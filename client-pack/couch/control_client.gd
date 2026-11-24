extends Node
## The host socket owns the join lifetime; the seat socket owns renderer and input messages.

signal status_changed(text: String)

# Godot's WebSocketPeer closes with 1009 on any message over its inbound buffer (64 KiB by default). The host's
# watch stream (a scene-delta over 1 MB) and post-join session envelopes outgrow that; a browser has no limit.
const HOST_MESSAGE_BUFFER := 4 * 1024 * 1024
signal input_result(text: String)
signal presentation_changed(epoch: int, ready: bool)
signal descriptor_received(descriptor: Dictionary)

const SELECTORS := "watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0"

var origin := "http://127.0.0.1:13337"
var player_name := "Native client"
var aspect := 16.0 / 9.0
var presentation_epoch := -1
var presentation_ready := false
var _control: WebSocketPeer
var _seat: WebSocketPeer
var _page_id := ""
var _join_sent := false
var _renderer_sent := false
var _attempt_id := ""
var _presented := false
var _frame_seen := false
var _input_sequence := 0
var _allowed := false
var _failed := false


func start() -> void:
	origin = origin.trim_suffix("/")
	var check := RegEx.new()
	check.compile("^https?://(\\[[0-9a-fA-F:]+\\]|[a-zA-Z0-9.-]+)(:[0-9]+)?$")
	if check.search(origin) == null or player_name.strip_edges().is_empty():
		_fail("Invalid pack configuration")
		return
	_page_id = Crypto.new().generate_random_bytes(16).hex_encode()
	_control = WebSocketPeer.new()
	_control.inbound_buffer_size = HOST_MESSAGE_BUFFER
	if _control.connect_to_url(_ws_origin() + "/ws?" + SELECTORS) != OK:
		_fail("Control connection failed")
	else:
		status_changed.emit("Connecting")


func _process(_delta: float) -> void:
	# WebSocketPeer requires a main-loop pump; sessions drive all presentation changes.
	_pump(_control, false)
	_pump(_seat, true)


func _pump(peer: WebSocketPeer, seat: bool) -> void:
	if peer == null or _failed:
		return
	peer.poll()
	if peer.get_ready_state() == WebSocketPeer.STATE_CLOSED:
		# The close code and reason are the only evidence of why a socket ended.
		print("[couch-pack] %s closed: code=%d reason=%s" % [
			"seat" if seat else "control", peer.get_close_code(), peer.get_close_reason().left(120)])
		_fail("Seat disconnected" if seat else "Control disconnected")
		return
	while peer.get_available_packet_count() > 0:
		var packet: PackedByteArray = peer.get_packet()
		if not peer.was_string_packet():
			continue
		var message: Variant = JSON.parse_string(packet.get_string_from_utf8())
		# Type and size only; bodies can carry credentials.
		print("[couch-pack] %s recv type=%s bytes=%d" % [
			"seat" if seat else "control",
			str((message as Dictionary).get("type", "?")) if message is Dictionary else "non-json", packet.size()])
		if message is Dictionary:
			_receive(message, seat)


func _receive(message: Dictionary, seat: bool) -> void:
	if message.get("type") == "input-result" and seat:
		# Only fixed local text reaches logs; host details may contain credentials.
		var result := "ok" if message.get("success") == true else "refused"
		if message.get("code") == "access-denied":
			result = "access-denied"
		input_result.emit(result)
		print("[couch-pack] input-result: " + result)
		return
	if message.get("type") != "session":
		return
	if not seat:
		var attempt: Variant = message.get("connectionAttemptId")
		if attempt is String and attempt.length() <= 128:
			_attempt_id = attempt
			_receipt()
		if message.has("joinRejection") and message["joinRejection"] is String:
			_fail("Join rejected")
			return
		if message.get("headlessMirrorPath") is String and _seat == null:
			if message.has("requestId") and message["requestId"] != "join:1":
				return
			var route: String = message["headlessMirrorPath"]
			# Same rule as the frontend's isValidSharedMirrorPath (mirrorClient.ts): the host owns the route's
			# shape (its RouteId is upper-case hex today), so only reject what cannot be a same-origin path.
			if not route.begins_with("/") or route.begins_with("//") or route.contains("\\") or route.contains("#"):
				_fail("Invalid seat route")
				return
			_seat = WebSocketPeer.new()
			_seat.inbound_buffer_size = HOST_MESSAGE_BUFFER
			if _seat.connect_to_url(_ws_origin() + route + "&" + SELECTORS + "&rendererPage=" + _page_id) != OK:
				_fail("Seat connection failed")
		elif not _join_sent:
			_join_sent = true
			_send(_control, {"type": "join", "rendererProtocol": 2, "requestId": "join:1", "name": player_name.strip_edges()})
			status_changed.emit("Joining")
		return
	if not _renderer_sent:
		_renderer_sent = true
		_send(_seat, {"type": "renderer", "rendererProtocol": 2, "renderer": "stream", "aspect": aspect})
		status_changed.emit("Waiting for stream")
	var state: Variant = message.get("rendererState")
	if state is Dictionary and state.get("presentationEpoch") is float and state["presentationEpoch"] >= 0 and floor(state["presentationEpoch"]) == state["presentationEpoch"]:
		var epoch := int(state["presentationEpoch"])
		if epoch < presentation_epoch:
			return
		presentation_epoch = epoch
		presentation_ready = state.get("presentationReady") == true
	else:
		presentation_ready = false
	var access: Variant = message.get("hostAccess")
	_allowed = access is Dictionary and access.get("allowed") == true and access.get("reason") == "allowed"
	# Hand the descriptor over before allowing a tap from the new presentation.
	if message.get("renderStream") is Dictionary:
		descriptor_received.emit(message["renderStream"])
	presentation_changed.emit(presentation_epoch, presentation_ready)


func first_frame() -> void:
	_frame_seen = true
	_receipt()


func _receipt() -> void:
	if _frame_seen and not _presented and not _attempt_id.is_empty():
		_presented = _send(_control, {"type": "client-frame-presented", "attemptId": _attempt_id})
		if _presented:
			status_changed.emit("Connected")


func tapped(_screen_pos: Vector2, _item: int, game_pos: Vector2) -> void:
	if _failed or not _allowed or not presentation_ready or presentation_epoch < 0 or not game_pos.is_finite():
		return
	for pressed: bool in [true, false]:
		_input_sequence += 1
		_send(_seat, {"type": "input", "requestId": "input:%d" % _input_sequence,
			"kind": "click", "button": "left", "pressed": pressed,
			"coordX": _coordinate(game_pos.x), "coordY": _coordinate(game_pos.y), "presentationEpoch": presentation_epoch})


func _coordinate(value: float) -> Variant:
	# Match JSON.stringify's integer spelling without rounding fractional presentation pixels.
	if value == floor(value):
		return int(value)
	return value


func _send(peer: WebSocketPeer, message: Dictionary) -> bool:
	return peer != null and peer.get_ready_state() == WebSocketPeer.STATE_OPEN and peer.send_text(JSON.stringify(message, "", false)) == OK


func _ws_origin() -> String:
	return origin.replace("https://", "wss://").replace("http://", "ws://")


func _fail(text: String) -> void:
	_failed = true
	presentation_ready = false
	status_changed.emit(text)


func _exit_tree() -> void:
	for peer: WebSocketPeer in [_seat, _control]:
		if peer != null and peer.get_ready_state() == WebSocketPeer.STATE_OPEN:
			peer.close(1000, "pack exit")
