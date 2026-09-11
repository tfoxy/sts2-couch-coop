# `clip_contents` on the mirror wire — what it can newly clip (R19 WP-4)

The mirror now honours `Control.clip_contents`, which it previously ignored entirely (it carried only
`CanvasItem.ClipChildren`, a different property). The user-visible reason is the ancient event: the game hides
pending options by clipping them, not by hiding them, so the mirror was showing options the game was not.

Honouring it is a general change, so the question this note answers is: **what ELSE starts being clipped, and
can any of it cut content the player needs?**

> **R20 CORRECTION.** The original sweep below missed **two real regressions**, and it missed them
> *structurally* — both legs of its method were blind by construction, not unlucky. Read
> [What the original method could not see](#what-the-original-method-could-not-see) before trusting any part
> of this note, and treat the tables below as the *authored* clippers only.

## Method

Two passes, because neither is sufficient alone.

1. **Replay** — every `audit-*.ndjson` recording in `.sts2/bench/` predates the field and carries **zero**
   `clipContents` keys, so a replay renders byte-identically with the flag on or off. That bounds the
   regression risk for everything those recordings cover, and it is also why a replay-only sweep would be a
   false pass: it proves nothing about live screens.
   **(R20: this leg was vacuous — see below. It was not a weak pass, it was a guaranteed one.)**
2. **Static** — enumerate every scene in the shipped project that authors `clip_contents = true`, drop the
   ones the mirror never streams, and check what each clipper actually contains.
   **(R20: a `.tscn` sweep can only see AUTHORED values, never a Godot class default — see below.)**

## The clippers, and why each is safe

20 scenes author it. Discounting `scenes/debug/*` (never streamed), the in-scope clippers are:

| scene | clipping node | what it holds | verdict |
| --- | --- | --- | --- |
| `combat/health_bar.tscn` | `PoisonForeground`, `DoomForeground` | nine-patch **fill bars**, no text | safe — and clipping is what makes a partially-filled poison/doom bar render correctly, so this is a fix, not a risk |
| `screens/rewards_screen.tscn` | `RewardContainerMask` | the reward rows | safe — see below |
| `screens/inspect_relic_screen/…` | `NoiseMask` (under a `Spacer`) | decorative noise art | safe |
| `rest_site/overgrowth_rest_site.tscn` | `RestSiteForeground1` | background art layering | safe |
| `events/custom/crystal_sphere/…` | `CrystalSphereCell` | one event cell's art | safe |
| `events/ancient_event_layout.tscn` | `ContentContainer` | **the target of the change** | intended — but see R20 victim 1: the VERTICAL clip is the fix, the horizontal one was a regression |
| menus (`settings_screen`, `compendium_submenu`, `paginator`, the dropdowns), `ftue/*`, `vfx/*` | scroll/paginator viewports and vfx masks | — | safe; these are the case clipping exists for |

**Why `RewardContainerMask` does not cut the enlarged rewards.** This repo scales the post-combat reward panel
up (`viewScale.ts` — `rewards_screen.tscn :: Rewards`, one group about its own centre), and a mask that did not
scale with it would slice the enlarged rows. It does scale with it: the mask is a CHILD of `Rewards`, and
`applyViewScalePass` prepends its matrix to the group element, so the whole subtree — mask and contents
together — is scaled by the same factor. The clip region grows exactly as fast as what it clips.

**The class of thing that WOULD be dangerous**, for whoever adds the next readability transform: a clipper that
is an ANCESTOR of a scaled node rather than a descendant, or a text node whose scaled font pushes it past a
clipping parent. ~~Neither exists today.~~ **R20: BOTH existed on the day this was written.** The first is
victim 1 below; the second is victim 2. The sentence identified the hazard correctly and then cleared it on
evidence that could not have shown it.

## What the original method could not see

Two blind spots, both structural:

1. **A `.tscn` sweep cannot see a Godot CLASS DEFAULT.** A scene file records only the properties an author
   *changed*; a node that inherits its class's default writes nothing, so grepping scenes for
   `clip_contents = true` enumerates the authored clippers and nothing else. The producer, by contrast, reads
   the property off every `Control` it probes and reports the EFFECTIVE value — default included. Godot 4
   classes that default `clip_contents` to **true** include (verify against the engine before relying on this
   list being exhaustive):

   | class | default `clip_contents` |
   | --- | --- |
   | `RichTextLabel` | **true** |
   | `TextEdit` (and `CodeEdit`) | **true** |
   | `LineEdit` | **true** |
   | `ScrollContainer` | **true** |
   | `Control` (and `Label`, `Container`, `Panel`, …) | false |

   So every `RichTextLabel` in the game became a clipper the moment WP-4 landed, without a single scene
   authoring anything. That is how victim 2 got past a 20-scene table.

2. **The replay leg was a guaranteed pass, not a weak one.** Every recording in `.sts2/bench/` was captured
   *before* the producer put `clipContents` on the wire, so a replay's node stream contains no such key by
   construction: the flag has nothing to act on and both settings render identically. A replay can only bound
   a field's blast radius if the recording carries that field. This one could not fail.

   *Recipe for the next field:* re-record after the producer change (or synthesise the field into an existing
   recording) before claiming a replay pass, and state the recording's capture date next to the claim.

## The two real victims (R20)

Both are the same shape — a clip that the game's own layout never exercised, because in the game nothing inside
the clipper is bigger than the clipper. This repo makes things bigger for phone legibility, and that is what
turned an inert clip into a crop.

| # | node | what happened | fix |
| --- | --- | --- | --- |
| 1 | `events/ancient_event_layout.tscn :: ContentContainer` (**authored**) | The clipper is 1160x720 at design (380,320) → it bounds x 380…1540. Its `Content/OptionsContainer` subtree is 1000 wide at x 460…1460 (80px inside on each side, so the game never crops). `viewScale.ts` enlarges the options by 1.2 about x 960 → 360…1560, i.e. **20px cut per side**, and more while an option is focused and grown further. | `clipAxis.ts` — a scene-identity table granting this node a **vertical-only** clip: `clip-path: inset(0px -380px)`. The vertical clip is the WP-4 fix (it hides the options parked below the container mid-dialogue) and is unchanged. The exception applies only while readability scaling is enabled. |
| 2 | `cards/card.tscn :: CardContainer/DescriptionLabel` and `ui/hover_tip.tscn :: TextContainer/VBoxContainer/Description` (**class default**) | Both are `RichTextLabel`s that author nothing, so they inherited `clip_contents = true`. `mirrorTextScale.css` (and its `textScaleClasses.ts` twin) scales `.mirror-text` 1.24x about its own centre and states the contract literally — *"Overflow beyond the card bg is ACCEPTABLE (cropping is not)"* — so the enlarged glyphs are MEANT to spill over the frame. The frame never moved; the text stopped escaping. | `nodeStyles.ts` never clips a rich-text node. This restores pre-WP-4 web behaviour (the web never clipped text at all) and re-converges with the native client, whose `TextBuilder.ConfigureRich` already sets `rtl.ClipContents = false` for exactly these labels. Scoped to RICH text: a plain `Label` defaults to false, and a `ScrollContainer`'s clip is legitimate and still fires. |

Measured geometry for victim 1 comes from `.sts2/bench/audit-mprun.ndjson` (main checkout — worktrees carry
their own empty `.sts2/`).

**The rule this leaves behind.** Before honouring a Godot layout property in the mirror, ask which of this
repo's own transforms it can now interact with, and check the property's CLASS DEFAULT for every class the
producer probes — not just what the scenes author. `viewScale.ts` and `mirrorTextScale.css` are the standing
list of "things this repo makes bigger than the game made them".

## What is still owed

A live visual pass, on:

* the ancient event mid-dialogue — that the options are no longer cropped at the sides **and** that parked
  options are still hidden while the dialogue plays (the WP-4 fix must not have regressed);
* a card with a long description, and a hover tip — that the text paints over its frame again;
* the post-combat rewards (the scaled-group interaction above) and combat (the poison/doom bars).

Everything above is asserted by unit tests over the real walk (`nodeStyles.spec.ts`, `mirrorClip.spec.ts`); no
screenshot has been taken of any of it.

The current client always honours `clipContents`. The one-axis exception is active only with readability scaling,
because it exists to protect those enlargements from an otherwise-correct game clip.
