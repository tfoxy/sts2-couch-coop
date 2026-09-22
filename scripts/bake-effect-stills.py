#!/usr/bin/env python3
"""Bake the committed effect stills the mirror paints when shaders/particles are OFF.

WHAT THIS PRODUCES, and why the repo carries the output instead of rendering it live.
In `shaders=off` / `particles=off` the mirror runs no WebGL at all, so the card's playable-glow
(`res://shaders/card_ripple.gdshader`) and the rarity glows (`res://scenes/vfx/*_glow_vfx.tscn`) render
as nothing — and those are gameplay cues, not decoration. The answer is one PNG per effect, rendered ONCE
by the real game, committed, and bundled into the web app: zero GPU cost and one decode on exactly the
devices that resolve to those modes.

HOW EACH STILL IS MADE FAITHFUL. All three effects are ADDITIVE (`blend_add` / an additive
CanvasItemMaterial), and STS2 authors additive art as fully-opaque sprites that are BLACK where nothing
should show. Two consequences drive everything below:

  1. The capture is taken over an OPAQUE BLACK BACKDROP (`backdrop=black`). Over transparency the black
     areas become opaque black quads, and whether the result can be re-composited at all then depends on
     whether the engine's readback un-premultiplied — an inference about the renderer, not a property of
     the artifact. Over black there is nothing to infer: the capture IS `black + Σ(contribution)`, which
     is exactly what an additive compositor adds.
  2. That capture is then converted to STRAIGHT ALPHA here, with `a = max(r, g, b)` and `rgb = rgb / a`.
     Under CSS `plus-lighter` the painted contribution is `rgb x a`, which reproduces the capture exactly
     — and unlike shipping the opaque original, a viewer whose browser does NOT support `plus-lighter`
     degrades to a soft translucent glow instead of a BLACK RECTANGLE over the card. The conversion is
     lossless in the direction that matters (`rgb x a` round-trips to the captured value); it only exists
     to make the failure mode survivable.

The node-local RECT each still covers is stated here and consumed, unchanged, by
`frontend/src/mirror/bakedEffects.ts`. It is the contract between the two: one node-local unit is one
captured pixel, so the numbers in BAKES below are the numbers the browser places the image at.

USAGE (this drives a real game, so it needs the live-QA lease — see the `couch-live-lock` skill):

    scripts/bring-up-gamescope-instance.sh --instance effectbake \\
        --cache-root /tmp/effectbake-cache --i-hold-the-live-lock
    scripts/bake-effect-stills.py --instance effectbake \\
        --config /tmp/geoclip-bringup-effectbake/sts2.effectbake.yaml
    scripts/bring-up-gamescope-instance.sh --instance effectbake --teardown

Run it from the repo root: the instance's IPC socket is resolved from the working directory, and pointing
it at the wrong checkout is how you get `game_already_running_without_bridge` for a game that is up.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover - a setup error, reported rather than raised
    sys.exit("bake-effect-stills: Pillow is required (pip install --user Pillow)")

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = REPO_ROOT / "frontend" / "src" / "assets" / "effects"


@dataclass(frozen=True)
class Bake:
    """One still: the game resource it comes from, how it is posed, and the box it covers."""

    name: str
    scene: str
    node: str
    # The NODE-LOCAL capture rect (x, y, w, h), one unit per captured pixel. This is the number
    # `bakedEffects.ts` places the image at, so the two must move together.
    rect: tuple[int, int, int, int]
    # `modulate` pinned at capture. Both families pin it, for opposite reasons — see the per-bake notes.
    modulate: tuple[float, float, float, float]
    shader_params: dict[str, float] = field(default_factory=dict)
    live_particles: bool = False
    # Downscale factor applied AFTER capture. Purely a payload decision: the browser scales the image to
    # the node-local rect either way, and these are soft gradients with no detail to lose.
    downscale: int = 1
    why: str = ""


BAKES = [
    Bake(
        name="card-ripple",
        scene="res://scenes/cards/card.tscn",
        node="CardContainer/Highlight",
        # The node's OWN localRect, so the browser can paint it across the element 1:1 with no framing
        # arithmetic. The rendered silhouette is 334x457 inside it, against a 300x422 card — the ~17px
        # halo that spills past the card art IS the glow a player sees.
        rect=(0, 0, 759, 951),
        # NEUTRAL rgb on purpose. The shader only ever writes COLOR.a; its rgb passes straight through as
        # `texture.rgb x modulate.rgb`, and the mirror already multiplies every node by its own streamed
        # modulate through an feColorMatrix. So one white bake x that existing tint reproduces all three
        # NCardHighlight colours (playable cyan, gold, red) — and any colour added later — exactly.
        # The ALPHA is not neutral and must not be: `COLOR.a` enters the shader as
        # `sdf.a x modulate.a`, where it SHAPES the ripple band rather than scaling the output.
        modulate=(1.0, 1.0, 1.0, 0.98),
        # The authored value is 0.0 — the resting state the card's script tweens away from — and renders a
        # degenerate `smoothstep(1.0, 1.0, .)`, i.e. nothing. 0.075 is what `NCardHighlight.AnimShow`
        # tweens to when a card becomes playable, which is the state worth a still.
        shader_params={"width": 0.075},
        why="the playable / gold / red card glow",
    ),
    Bake(
        name="glow-uncommon",
        scene="res://scenes/vfx/uncommon_glow_vfx.tscn",
        node=".",
        # Centred on the emitter origin. Measured content reaches ~210 node-local units; +-256 leaves
        # headroom, which a stochastic emitter needs — a re-bake will not land on the same particles.
        rect=(-256, -256, 512, 512),
        # Pinned OPAQUE, the opposite reason to the ripple's: the glow scripts tween `modulate:a`
        # 1.0 -> 0.9 on tree entry, and the mirror streams that live 0.9 and applies it as element
        # opacity. Baking it in as well would fade the glow twice.
        modulate=(1.0, 1.0, 1.0, 1.0),
        live_particles=True,
        downscale=2,
        why="the uncommon-card rarity shimmer",
    ),
    Bake(
        name="glow-rare",
        scene="res://scenes/vfx/rare_glow_vfx.tscn",
        node=".",
        # Same shape, bigger effect: a 256px sprite at up to 3x scale. Content reaches ~300.
        rect=(-384, -384, 768, 768),
        modulate=(1.0, 1.0, 1.0, 1.0),
        live_particles=True,
        downscale=2,
        why="the rare-card rarity shimmer",
    ),
]


def asset_key(bake: Bake) -> str:
    """The `scene-subtree://` key, spelled exactly as spirectl's `Sts2SceneSubtreeStillKey` parses it."""
    x, y, w, h = bake.rect
    parts = [
        f"node={bake.node.replace('/', '%2F')}",
        f"rect={x},{y},{w},{h}",
        "modulate=" + ",".join(f"{c:g}" for c in bake.modulate),
        # Every bake is additive; see the module header for why this is not optional.
        "backdrop=black",
    ]
    for uniform, value in sorted(bake.shader_params.items()):
        parts.append(f"shaderParam.{uniform}={value:g}")
    if bake.live_particles:
        parts.append("particles=live")
    return f"scene-subtree://{bake.scene}?" + "&".join(parts)


def extract(bake: Bake, args: argparse.Namespace) -> Path:
    """Run one live extraction and return the rendered PNG's path."""
    argv = ["sts2"]
    if args.config:
        argv += ["--config", args.config]
    if args.instance:
        argv += ["--instance", args.instance]
    argv += ["--json", "assets", "extract", asset_key(bake), "--execution", "live", "--format", "png"]

    done = subprocess.run(argv, cwd=REPO_ROOT, capture_output=True, text=True)
    if done.returncode != 0:
        sys.exit(f"bake-effect-stills: {bake.name}: sts2 exited {done.returncode}\n{done.stdout}\n{done.stderr}")

    payload = json.loads(done.stdout)
    exports = payload.get("exports") or []
    if not exports or exports[0].get("status") != "exported":
        sys.exit(
            f"bake-effect-stills: {bake.name}: the live bridge did not export the still\n"
            + json.dumps(payload, indent=2)
        )

    export = exports[0]
    x, y, w, h = bake.rect
    if (export.get("width"), export.get("height")) != (w, h):
        sys.exit(
            f"bake-effect-stills: {bake.name}: expected a {w}x{h} capture for rect {bake.rect}, "
            f"got {export.get('width')}x{export.get('height')}"
        )
    for note in export.get("notes", []):
        print(f"    - {note}")
    return Path(export["outputPath"])


def to_straight_alpha(source: Path, destination: Path, downscale: int) -> tuple[int, int, int]:
    """Convert an additive capture over black into a straight-alpha PNG (see the module header).

    Returns (width, height, bytes). Raises when the capture is blank, which means the effect did not
    render and the still would be an empty file nobody notices.
    """
    image = Image.open(source).convert("RGB")
    if downscale > 1:
        image = image.resize(
            (image.width // downscale, image.height // downscale), Image.Resampling.LANCZOS
        )

    pixels = image.load()
    out = Image.new("RGBA", image.size)
    out_pixels = out.load()
    lit = 0
    for py in range(image.height):
        for px in range(image.width):
            r, g, b = pixels[px, py]
            a = max(r, g, b)
            if a == 0:
                out_pixels[px, py] = (0, 0, 0, 0)
                continue
            lit += 1
            # Un-premultiply, rounding so `rgb x a` lands back on the captured value.
            out_pixels[px, py] = (
                min(255, round(r * 255 / a)),
                min(255, round(g * 255 / a)),
                min(255, round(b * 255 / a)),
                a,
            )

    if lit == 0:
        sys.exit(f"bake-effect-stills: {source} is entirely black — the effect rendered nothing")

    destination.parent.mkdir(parents=True, exist_ok=True)
    out.save(destination, optimize=True)
    return out.width, out.height, destination.stat().st_size


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--instance", help="the isolated sts2 instance the game is running as")
    parser.add_argument("--config", help="the scratch sts2 config that instance was launched with")
    parser.add_argument(
        "--only", action="append", help="bake only the named still (repeatable); default is all of them"
    )
    args = parser.parse_args()

    selected = [b for b in BAKES if not args.only or b.name in args.only]
    if not selected:
        sys.exit(f"bake-effect-stills: no bake matches {args.only}; known: {[b.name for b in BAKES]}")

    print(f"bake-effect-stills: writing to {OUT_DIR.relative_to(REPO_ROOT)}")
    for bake in selected:
        print(f"  {bake.name} — {bake.why}")
        print(f"    key {asset_key(bake)}")
        captured = extract(bake, args)
        destination = OUT_DIR / f"{bake.name}.png"
        width, height, size = to_straight_alpha(captured, destination, bake.downscale)
        x, y, w, h = bake.rect
        print(
            f"    -> {destination.name}  {width}x{height}  {size / 1024:.1f} KiB"
            f"  (node-local rect {x},{y},{w},{h})"
        )

    print()
    print("bakedEffects.ts must state the same node-local rects:")
    for bake in selected:
        print(f"  {bake.name}: {{ x: {bake.rect[0]}, y: {bake.rect[1]}, "
              f"width: {bake.rect[2]}, height: {bake.rect[3]} }}")


if __name__ == "__main__":
    main()
