extends SceneTree

# Track F2a — host-side GPU texture transcoder. Runs under the TOOLS editor headless
# (Image.compress ASTC encoders are TOOLS_ENABLED-only, absent from export templates):
#   <tools-editor> --headless --path scripts/transcode-godot --script res://transcode.gd -- --manifest <file>
#
# Per manifest entry {src,out}: load the served PNG/WEBP bytes -> Image -> convert to RGBA8 ->
# generate_mipmaps() -> compress(COMPRESS_ASTC, COMPRESS_SOURCE_SRGB, ASTC_FORMAT_4x4) -> wrap the
# raw get_data() payload in the fixed 32-byte CCTX container (see src/CouchCoop.MirrorProtocol/
# Assets/CctxContainer.cs — the byte layout MUST stay identical). Writes are atomic (temp-then-move)
# and idempotent-safe (the driver skips entries whose output already exists).
#
# Manifest JSON: {"mipmaps": true, "entries": [{"src": "/abs/in.png", "out": "/abs/out.cctx"}, ...]}
# src/out are ABSOLUTE OS paths (FileAccess.open accepts absolute paths for arbitrary-file IO).

const MAGIC := [0x43, 0x43, 0x54, 0x58] # "CCTX"
const CONTAINER_VERSION := 1

func _initialize() -> void:
	var args := OS.get_cmdline_user_args() # everything after the "--" separator
	var manifest_path := ""
	for i in range(args.size()):
		if args[i] == "--manifest" and i + 1 < args.size():
			manifest_path = args[i + 1]
	if manifest_path == "":
		push_error("transcode: missing --manifest <file>")
		quit(2)
		return

	var text := FileAccess.get_file_as_string(manifest_path)
	if text == "":
		push_error("transcode: could not read manifest %s" % manifest_path)
		quit(2)
		return

	var manifest = JSON.parse_string(text)
	if typeof(manifest) != TYPE_DICTIONARY or not manifest.has("entries"):
		push_error("transcode: malformed manifest")
		quit(2)
		return

	var gen_mips: bool = manifest.get("mipmaps", true)
	var total_budget_bytes: int = int(manifest.get("totalBudgetBytes", 0))
	var entry_limit_bytes: int = int(manifest.get("entryLimitBytes", 0))
	var allocation_unit_bytes: int = int(manifest.get("allocationUnitBytes", 4096))
	if total_budget_bytes <= 0 or entry_limit_bytes <= 0 or allocation_unit_bytes <= 0:
		push_error("transcode: manifest requires positive totalBudgetBytes and entryLimitBytes")
		quit(2)
		return
	var entries: Array = manifest["entries"]
	var ok := 0
	var fail := 0
	var bytes_in := 0
	var bytes_out := 0
	var budget_used := 0
	var quota_skipped := 0
	for e in entries:
		var src: String = e["src"]
		var out: String = e["out"]
		var result := _transcode_one(src, out, gen_mips, total_budget_bytes - budget_used, entry_limit_bytes, allocation_unit_bytes)
		if result.size() == 3:
			ok += 1
			bytes_in += int(result[0])
			bytes_out += int(result[1])
			budget_used += int(result[2])
		elif result.size() == 1 and result[0] == "quota":
			quota_skipped += 1
		else:
			fail += 1
			push_warning("transcode: FAILED %s" % src)

	# Machine-readable summary line the driver greps for.
	print("TRANSCODE_RESULT %s" % JSON.stringify({
		"ok": ok, "fail": fail, "quotaSkipped": quota_skipped, "bytesIn": bytes_in, "bytesOut": bytes_out,
	}))
	quit(0 if fail == 0 else 1)

# Returns [srcLen, outLen] on success, [] on failure.
func _transcode_one(src: String, out: String, gen_mips: bool, remaining_budget_bytes: int, entry_limit_bytes: int, allocation_unit_bytes: int) -> Array:
	var bytes := FileAccess.get_file_as_bytes(src)
	if bytes.size() == 0:
		return []

	var img := Image.new()
	var err := _load_sniffed(img, bytes)
	if err != OK:
		return []

	# Uniform RGBA8 source: matches how the client's swizzled L8/LA8/RGB8 uploads sample, and ASTC
	# encodes from RGBA8.
	if img.get_format() != Image.FORMAT_RGBA8:
		img.convert(Image.FORMAT_RGBA8)

	if gen_mips:
		img.generate_mipmaps()

	# COMPRESS_SOURCE_SRGB: 2D color art is sRGB-encoded; the hint weights the encoder's error
	# perceptually. The decode format (ASTC_4x4 -> DATA_FORMAT_ASTC_4x4_UNORM_BLOCK) matches RGBA8's
	# UNORM mapping, so there is NO color-space shift vs the PNG path — only lossy quantization.
	err = img.compress(Image.COMPRESS_ASTC, Image.COMPRESS_SOURCE_SRGB, Image.ASTC_FORMAT_4x4)
	if err != OK:
		return []

	var data := img.get_data()
	var container := _build_container(img.get_width(), img.get_height(), img.get_format(), img.has_mipmaps(), data)
	# Check the exact durable CCTX bytes before opening a staging file. The current format has no sidecar metadata;
	# if one is added, its exact encoded length belongs in this sum before either file is opened.
	var charged_bytes := int(ceil(float(container.size()) / float(allocation_unit_bytes))) * allocation_unit_bytes
	if container.size() > entry_limit_bytes or charged_bytes > remaining_budget_bytes:
		return ["quota"]
	if not _write_atomic(out, container):
		return []
	return [bytes.size(), container.size(), charged_bytes]

func _load_sniffed(img: Image, bytes: PackedByteArray) -> int:
	# RIFF....WEBP
	if bytes.size() >= 12 and bytes[0] == 0x52 and bytes[1] == 0x49 and bytes[2] == 0x46 and bytes[3] == 0x46 \
			and bytes[8] == 0x57 and bytes[9] == 0x45 and bytes[10] == 0x42 and bytes[11] == 0x50:
		return img.load_webp_from_buffer(bytes)
	# \x89 P N G
	if bytes.size() >= 8 and bytes[0] == 0x89 and bytes[1] == 0x50 and bytes[2] == 0x4E and bytes[3] == 0x47:
		return img.load_png_from_buffer(bytes)
	# Tolerant fallback (codec-agnostic wire): try PNG then WEBP.
	var e := img.load_png_from_buffer(bytes)
	if e != OK:
		e = img.load_webp_from_buffer(bytes)
	return e

func _build_container(width: int, height: int, format: int, has_mips: bool, data: PackedByteArray) -> PackedByteArray:
	var header := PackedByteArray()
	header.resize(32)
	for i in range(4):
		header[i] = MAGIC[i]
	header.encode_u32(4, CONTAINER_VERSION)
	header.encode_u32(8, width)
	header.encode_u32(12, height)
	header.encode_u32(16, format)
	header.encode_u32(20, 1 if has_mips else 0)
	header.encode_u64(24, data.size())
	var buf := header.duplicate()
	buf.append_array(data)
	return buf

func _write_atomic(out: String, data: PackedByteArray) -> bool:
	var tmp := "%s.tmp.%d.%d" % [out, OS.get_process_id(), randi()]
	var f := FileAccess.open(tmp, FileAccess.WRITE)
	if f == null:
		push_error("transcode: cannot open %s for write (err %d)" % [tmp, FileAccess.get_open_error()])
		return false
	f.store_buffer(data)
	var write_error := f.get_error()
	f.close()
	if write_error != OK:
		DirAccess.remove_absolute(tmp)
		return false
	var da := DirAccess.open(out.get_base_dir())
	if da == null:
		DirAccess.remove_absolute(tmp)
		return false
	# A parallel batch may have completed the same content-addressed output while this one encoded it.
	if FileAccess.file_exists(out):
		var existing := FileAccess.get_file_as_bytes(out)
		if existing == data:
			DirAccess.remove_absolute(tmp)
			return true
		if DirAccess.remove_absolute(out) != OK:
			DirAccess.remove_absolute(tmp)
			return false
	var rename_error := da.rename(tmp, out)
	if rename_error != OK:
		DirAccess.remove_absolute(tmp)
		return false
	return true
