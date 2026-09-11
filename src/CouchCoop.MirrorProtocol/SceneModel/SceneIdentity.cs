namespace CouchCoop.MirrorProtocol.SceneModel;

// Godot-free port of the web mirror's `computeSceneInfo` (frontend/src/mirror/mirrorRenderer.ts L987-998),
// promoted here so BOTH the cosmetic animator (godot-client CosmeticAnimator) and the text-scale table
// (TextScale) resolve a node's scene identity the same way and can be unit-tested off the Godot runtime.
//
// Semantics (must stay identical to the web walk that stamps data-scene-file / data-scene-node-path):
//   - Walk the parent chain INCLUSIVE of the node itself.
//   - The FIRST ancestor carrying a non-null SceneFilePath is the owning scene root: its file is `File`.
//   - `RelPath` is the "/"-joined path of node names from that root's children down to the target — the scene
//     ROOT's OWN name is EXCLUDED (it is the "path relative to the root"). Empty string when the target IS the
//     root. Only name-bearing nodes contribute a segment; volatile auto-names (Godot `@Control@1328`, from
//     code-built/duplicated nodes) are kept VERBATIM (that is why the css uses $=/*=/^= over the volatile middle).
//   - Returns (null, null) when the node is not inside any instanced scene.
public static class SceneIdentity
{
    public static (string? File, string? RelPath) Resolve(string id, MirrorState state)
    {
        var names = new List<string>();
        MirrorNode? cur = state.Nodes.GetValueOrDefault(id);
        while (cur is not null)
        {
            if (cur.SceneFilePath is not null)
            {
                names.Reverse(); // collected leaf→up; reverse to root-first
                return (cur.SceneFilePath, string.Join("/", names));
            }

            if (!string.IsNullOrEmpty(cur.Name))
            {
                names.Add(cur.Name);
            }

            cur = cur.ParentId is { } pid ? state.Nodes.GetValueOrDefault(pid) : null;
        }

        return (null, null);
    }
}
