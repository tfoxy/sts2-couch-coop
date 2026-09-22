# Baked effect stills

Three PNGs the mirror paints where a WebGL effect would be, whenever that effect's family is **off** or
**static**. See [`../../mirror/bakedEffects.ts`](../../mirror/bakedEffects.ts) for how they are selected and
placed, and [`../../../../scripts/bake-effect-stills.py`](../../../../scripts/bake-effect-stills.py) for how
they are produced.

**Off** — the `minimum` quality rung, and the hard-off floor a software-WebGL phone lands on — would otherwise
lose a gameplay cue entirely: the card glow that says a card is playable, and the rarity shimmer behind an
uncommon or rare card.

**Static** is the product default on every device, and there these PNGs are a saving rather than a fallback:
that mode renders one frozen frame per surface and then reads it back off the GPU and PNG-encodes it to swap
the canvas for an `<img>`. These bakes *are* those frames, already encoded — so the ripple and the two glows
cost one decode instead of a readback each, and `card_ripple` (whose frozen frame used to be re-encoded on
every `width` tween) leaves that fleet entirely. The dynamic modes are untouched: they exist to animate.

| File | Effect | Node-local rect | Bake notes |
| --- | --- | --- | --- |
| `card-ripple.png` | `res://shaders/card_ripple.gdshader` on `card.tscn → CardContainer/Highlight` | `0, 0, 759, 951` (the node's own box) | `width = 0.075` (what `NCardHighlight.AnimShow` tweens to), `modulate = 1,1,1,0.98` |
| `glow-uncommon.png` | `res://scenes/vfx/uncommon_glow_vfx.tscn` | `-256, -256, 512, 512` | live emitter, `modulate = 1,1,1,1`, downscaled 2× |
| `glow-rare.png` | `res://scenes/vfx/rare_glow_vfx.tscn` | `-384, -384, 768, 768` | live emitter, `modulate = 1,1,1,1`, downscaled 2× |

Rendered by the real game through spirectl's `scene-subtree://` extraction, against **game v0.111.0** on
2026-09-22. Re-bake with:

```
scripts/bring-up-gamescope-instance.sh --instance effectbake \
    --cache-root /tmp/effectbake-cache --i-hold-the-live-lock
scripts/bake-effect-stills.py --instance effectbake \
    --config /tmp/geoclip-bringup-effectbake/sts2.effectbake.yaml
scripts/bring-up-gamescope-instance.sh --instance effectbake --teardown
```

The two glows are **stochastic** — a re-bake renders a different set of particles, and their committed
rects carry headroom for exactly that reason. The ripple's phase also moves (its shader reads `TIME`), so
no re-bake is byte-identical to the last one. That is expected; what must hold is the rect, which the
script prints and asserts against the capture.

## They are additive, and the alpha channel is not the effect's alpha

All three are `blend_add` in the game. Each was captured over an **opaque black backdrop** — the only way
to still an additive effect without inferring how the engine's readback premultiplies — and then converted
to straight alpha with `a = max(r, g, b)`. So `rgb × a` is the contribution the game adds, which is exactly
what CSS `plus-lighter` paints. Painted with normal blending instead, a glow reads as a grey film.

The conversion is lossless in the direction that matters (verified: `rgb × a` round-trips to the captured
value with zero channel error). It exists so a browser without `plus-lighter` degrades to a soft
translucent glow rather than a black rectangle over the card.

## No modulate is baked in

`card-ripple.png` is **neutral white**. `card_ripple` only ever writes `COLOR.a`, so its rgb passes through
as `texture.rgb × modulate.rgb`, and the mirror already multiplies every node by its own streamed modulate
through an `feColorMatrix`. One neutral bake therefore reproduces all three `NCardHighlight` colours —
playable cyan, gold, red — and any colour added later, exactly. Its **alpha** is not neutral and must not
be: `0.98` enters the shader as part of `COLOR.a`, where it shapes the ripple band.

The glows are captured at full opacity while the game's own scripts tween `modulate:a` to `0.9`; the mirror
streams that `0.9` and applies it as element opacity, which is where it belongs.

## Artifact policy

These are renders of official STS2 art (`card_frame_sdf.exr`, `glow_card_uncommon.png`,
`glow_card_rare.png`), so committing them is a deliberate, maintainer-approved exception to the repo's
"do not commit official STS2 assets" rule. Nothing else in this directory may grow on that precedent
without the same decision being made again.
