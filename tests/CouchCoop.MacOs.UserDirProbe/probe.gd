extends SceneTree

func _init() -> void:
	print("COUCHCOOP_USER_DIR_JSON=" + JSON.stringify({"userDir": OS.get_user_data_dir()}))
	quit()
