extends Control

const ControlClient = preload("res://couch/control_client.gd")
const ReceiverView = preload("res://couch/view.gd")

var control: Node
var _fit: SubViewportContainer
var _viewport: SubViewport
var _view: Node
var _descriptor: Dictionary = {}
var _status: Label
var _last_input: Label


func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	_fit = SubViewportContainer.new()
	_fit.stretch = false
	add_child(_fit)
	_viewport = SubViewport.new()
	_viewport.disable_3d = true
	_viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	_fit.add_child(_viewport)
	_status = Label.new()
	_status.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_status.position = Vector2(8, 8)
	add_child(_status)
	_last_input = Label.new()
	_last_input.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_last_input.position = Vector2(8, 30)
	add_child(_last_input)
	control = ControlClient.new()
	control.origin = _config("COUCH_HOST_ORIGIN", "http://127.0.0.1:13337")
	control.player_name = _config("COUCH_PLAYER_NAME", "Native client")
	control.aspect = size.x / size.y if size.y > 0 else 16.0 / 9.0
	control.status_changed.connect(func(text: String) -> void: _status.text = text)
	control.input_result.connect(func(text: String) -> void: _last_input.text = "Input: " + text)
	control.descriptor_received.connect(_connect_descriptor)
	add_child(control)
	resized.connect(_fit_view)
	_receiver_defaults()
	control.start()


func _config(key: String, fallback: String) -> String:
	return RsConfig.get_env(key) if RsConfig.get_env(key) != "" else fallback


func _receiver_defaults() -> void:
	var defaults := {"RS_RECEIVER_OUT": ProjectSettings.globalize_path("user://couch/applied.json"),
		"RS_RECEIVER_CACHE_DIR": ProjectSettings.globalize_path("user://couch/cache"),
		"RS_RECEIVER_CACHE_MODE": "warm", "RS_RECEIVER_LOG": "summary"}
	for key: String in defaults:
		if RsConfig.get_env(key) == "":
			RsConfig._args[key] = defaults[key]
	# Warm mode keeps payloads across launches but refuses a missing directory (a first run, or cleared app
	# data), so the pack creates it before the receiver opens it.
	if RsConfig.get_env("RS_RECEIVER_CACHE_MODE") == "warm":
		DirAccess.make_dir_recursive_absolute(RsConfig.get_env("RS_RECEIVER_CACHE_DIR"))


func _make_view() -> Node:
	return ReceiverView.new()


func _connect_descriptor(descriptor: Dictionary) -> void:
	if descriptor == _descriptor:
		return
	_descriptor = descriptor.duplicate(true)
	if _view != null:
		_viewport.remove_child(_view)
		_view.queue_free()
	_view = _make_view()
	var client: RefCounted = _view.live_client()
	client.origin = control.origin
	client.tapped.connect(control.tapped)
	_view.first_frame.connect(control.first_frame)
	var result: Error = client.connect_descriptor(descriptor)
	if result != OK:
		_status.text = "Stream descriptor refused"
		_view.free()
		_view = null
		return
	var presentation: Array = descriptor.get("presentation", [640, 360])
	_viewport.size = Vector2i(int(presentation[0]), int(presentation[1]))
	_fit_view()
	_viewport.add_child(_view)


func _fit_view() -> void:
	if _viewport.size.x <= 0 or _viewport.size.y <= 0:
		return
	# Keep the receiver at presentation size and fit it uniformly inside the shell window.
	var scale_factor: float = minf(size.x / _viewport.size.x, size.y / _viewport.size.y)
	_fit.size = Vector2(_viewport.size)
	_fit.scale = Vector2.ONE * scale_factor
	_fit.position = (size - Vector2(_viewport.size) * scale_factor) / 2.0
