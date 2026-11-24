extends SceneTree
## Exercise the real entry wiring; replace only the native receiver in this offline leg.

class FakeLive extends RefCounted:
	signal tapped(screen_pos: Vector2, item: int, game_pos: Vector2)
	var origin := ""
	var descriptor: Dictionary

	func connect_descriptor(value: Dictionary) -> Error:
		assert(origin == OS.get_environment("COUCH_HOST_ORIGIN"))
		assert(value["protocol"] == 19)
		assert(value["url"] == "/render-stream")
		assert(value["resourceBase"] == "/resources")
		assert(value["presentation"] == [1920.0, 1080.0])
		print("[offline] receiver-config: received-max-bytes=%s memory-budget-bytes=%s" % [
			RsConfig.get_env("RS_RECEIVER_RECEIVED_MAX_BYTES"),
			RsConfig.get_env("RS_RECEIVER_MEMORY_BUDGET_BYTES")])
		descriptor = value
		return OK


class FakeView extends Node:
	signal first_frame
	var client := FakeLive.new()
	var fit_presentation := false

	func _ready() -> void:
		assert(fit_presentation)
		assert(get_viewport() == get_window())
		# Simulate the receiver adopting a host canvas with three presentation pixels per unit.
		get_window().content_scale_size = Vector2i(1920, 1080)
		get_window().global_canvas_transform = Transform2D(Vector2(3, 0), Vector2(0, 3), Vector2.ZERO)

	func live_client() -> RefCounted:
		return client


class TestEntry extends "res://couch/entry.gd":
	func _make_view() -> Node:
		return FakeView.new()

	func _ready() -> void:
		super._ready()
		control.presentation_changed.connect(_presentation)
		control.input_result.connect(func(text: String) -> void:
			assert(_last_input.text == "Input: " + text)
			print("[offline] input-result: " + text)
			get_tree().quit())
		control.status_changed.connect(func(text: String) -> void:
			if text == "Join rejected" or text == "Invalid seat route":
				print("[offline] " + text)
				get_tree().quit())

	func _presentation(_epoch: int, _ready: bool) -> void:
		if _view == null:
			return
		assert(_view.get_parent() == self)
		assert(get_tree().root.find_children("*", "SubViewport", true, false).is_empty())
		assert(get_tree().root.find_children("*", "SubViewportContainer", true, false).is_empty())
		# Before the fake receiver's first frame, there must be no presentation receipt.
		_view.first_frame.emit()
		_view.first_frame.emit()
		for label: Label in [_status, _last_input]:
			assert(label.get_canvas_transform() == get_viewport().global_canvas_transform)
			assert(label.mouse_filter == Control.MOUSE_FILTER_IGNORE)
		print("[offline] direct-window receiver and content-space overlay")
		_view.client.tapped.emit(Vector2(100, 200), 99, Vector2(812, 640))


func _initialize() -> void:
	root.size = Vector2i(1280, 800)
	root.content_scale_size = Vector2i(1280, 800)
	root.content_scale_mode = Window.CONTENT_SCALE_MODE_CANVAS_ITEMS
	root.call_deferred("add_child", TestEntry.new())
	create_timer(15).timeout.connect(func() -> void:
		push_error("Offline control test timed out")
		quit(1))
