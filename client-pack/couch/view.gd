extends "res://couch/receiver/receiver.gd"
## Expose the receiver's submitted-frame hook without copying its implementation.

signal first_frame

var _first_submitted := false


func _send(message: Dictionary) -> void:
	super._send(message)
	if not _first_submitted and message.get("type") == "ack" and message.get("stage") == "submitted":
		_first_submitted = true
		first_frame.emit()


func _log(text: String) -> void:
	# The receiver's diagnostics can include a refused hello. Redact before printing.
	if _token != "":
		text = text.replace(_token, "[redacted]")
	super._log(text)


func _exit_tree() -> void:
	if _applier != null:
		_dispose_applier()
		_applier = null
