import type { MirrorNode } from "@/mirror/sceneTree";

const LINE_ERASE_SHADER_SUFFIX = "line_erase.gdshader";
const MAP_STROKE_SCENE_PREFIX = "res://scenes/screens/map/map_line_";
const MAP_STROKE_NAME_PREFIX = "map_line_";
export function isLineEraser(node: MirrorNode): boolean {
  return node.shaderId != null && node.shaderId.endsWith(LINE_ERASE_SHADER_SUFFIX);
}
export function isMapStrokeNode(node: MirrorNode): boolean {
  return node.sceneFilePath != null ? node.sceneFilePath.startsWith(MAP_STROKE_SCENE_PREFIX) : node.name.startsWith(MAP_STROKE_NAME_PREFIX);
}
