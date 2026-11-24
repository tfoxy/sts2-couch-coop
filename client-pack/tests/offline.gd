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
		descriptor = value
		return OK


class FakeView extends Node:
	signal first_frame
	var client := FakeLive.new()

	func live_client() -> RefCounted:
		return client


class TestEntry extends "res://couch/entry.gd":
	func _make_view() -> Node:
		return FakeView.new()

	func _ready() -> void:
		super._ready()
		control.presentation_changed.connect(_presentation)
		control.input_result.connect(func(_text: String) -> void: get_tree().quit())
		control.status_changed.connect(func(text: String) -> void:
			if text == "Join rejected" or text == "Invalid seat route":
				print("[offline] " + text)
				get_tree().quit())

	func _presentation(_epoch: int, _ready: bool) -> void:
		if _view == null:
			return
		assert(_viewport.size == Vector2i(1920, 1080))
		assert(is_equal_approx(_fit.scale.x, _fit.scale.y))
		assert(_fit.size == Vector2(1920, 1080))
		# Before the fake receiver's first frame, there must be no presentation receipt.
		_view.first_frame.emit()
		_view.first_frame.emit()
		_view.client.tapped.emit(Vector2(100, 200), 99, Vector2(812, 640))


func _initialize() -> void:
	root.size = Vector2i(1280, 800)
	root.content_scale_size = Vector2i(1280, 800)
	root.content_scale_mode = Window.CONTENT_SCALE_MODE_CANVAS_ITEMS
	root.call_deferred("add_child", TestEntry.new())
	create_timer(15).timeout.connect(func() -> void:
		push_error("Offline control test timed out")
		quit(1))
