# Text rendering methods (Bitmap + MSDF) — Codex handoff

For a Codex coordinator running **Sol** (implementation), **Luna** (independent audit) and **Astra**
(proposes next steps and reviews every gate), each in isolated worktrees.

The deliverable is a per-device mirror setting, **Text rendering**, that selects how the Rust canvas stage
draws text:
- **Bitmap**: today's path, unchanged.
- **MSDF**: new; a multi-channel signed-distance-field glyph atlas.

The setting, the producer seam, the GSW encoder and the Rust contract must be built so that **SDF** and
**Slug** can be added later as new values, without touching settings plumbing, persistence or i18n beyond
the new option's strings.

## 1. Why, and what it is not

- **It will not fix the card-aim lag.** Text was 2.8% of the interactive card-aim trace (ledger row "Oct 2
  interactive aim attribution", memory `rust-interactive-spread-build-cost-oct2`). That work has its own
  handoff, [handoff-interactive-rebuild-cost.md](handoff-interactive-rebuild-cost.md).
- **What it does fix** is the structural cost and quality of today's text:
  - Every line × colour run is its own Canvas2D bitmap: `strokeText` + `fillText`, a double-canvas
    `getImageData`, CPU tint, then a brand-new GPU texture per changed key
    (`frontend/src/mirror/renderer/pixi/createRustDrawListExecutor.ts:535-641`).
  - Any change to a string, colour or tint re-rasters it (damage numbers, card values).
  - The cache never evicts, in JS (`:1345`) or Rust (`resources.rs`).
  - One texture per run splits the 8-slot batches (`geometry.rs:4`).
  - Text is rasterized at design size and GPU-scaled with no mips, so zoomed or held cards blur.
- **What MSDF gives instead:** glyphs generated once into a shared atlas, crisp at any scale; colour, tint
  and outline as instance data with no re-raster; and far fewer textures. The game itself imports its faces
  as MSDF (`msdf_size = 48`, GSW `packages/html/src/text.ts:338-357`).
- **The user's stance** (memories `user-renderer-playtest-preference`, `rust-text-ink-phone-sep28`):
  - Ship switchable methods they can play-test.
  - Modest glyph-raster differences are acceptable for a real gain, but report every visual trade-off with
    image paths.
  - FPS is the objective.
  - Keep measurement light: a simple on/off test, no new benchmark infrastructure.

## 2. Rules that bind this work

- **Never commit derived game assets.** Game fonts are game assets, and an MSDF atlas generated from them is
  a derived asset (Artifact Policy in `AGENTS.md`). **Generate atlases at runtime** in the browser from the
  font bytes the host already serves. A test may use a font that is already permissively licensed in the
  repo, or synthetic outlines.
- **godot-scene-web stays generic** (GSW `AGENTS.md`): no CouchCoop or STS2 concepts in `packages/*`.
  - The glyph-run command, the encoder carrier, the atlas manager and the MSDF generator are generic GSW
    features.
  - Couch owns the setting, the layout mapping to its text records, and the fallbacks.
  - Never add npm `harfbuzzjs` beside `hb-gpu`; there must be one HarfBuzz per page.
- **Builds, siblings and releases.**
  - Never run Couch `npm run build`; it deploys. The Couch gate is
    `cd frontend && npx vue-tsc --noEmit && npx vitest run`.
  - Leave the shared `../godot-scene-web` and `../spirectl` checkouts on clean `main`. Point Couch's dev
    server at a GSW **worktree** with `COUCHCOOP_GSW_ROOT=<gsw worktree>` (`frontend/vite.config.ts:79-80`)
    and `VITE_RUST_PROTOTYPE_MODULE_URL` for the built glue.
  - No visible game window. Phone legs only when asked. Never push or tag.
- **Worktrees.**
  - Couch worktrees use the `couch-worktree` skill.
  - **Copy** `.sts2/rust-prototype-web/` into each one; a symlink 403s and the stage falls back to DOM
    (memory `rust-wasm-worktree-dom-fallback`).
  - GSW worktrees: `git -C ../godot-scene-web worktree add -b <branch> ../gsw-<name> main`, then
    `mise exec -- pnpm install --frozen-lockfile` inside it.
  - Serialize browser and benchmark runs with `scripts/live-qa-lock.mjs with` leases. Use loopback ports
    other than 5219/5220.
- **Commits.** Commit messages follow each repo's `docs/commit-and-release.md`; `feat`/`perf` need a
  `Changelog:` trailer. GSW's renderer, contract and generator land before Couch's adapter and setting.
- **Licences.** Every new Rust crate or wasm in the shipped payload needs its licence checked and added to
  the payload's notices (`THIRD_PARTY_NOTICES.md`, `licenses/`; see the `topic-release-publish` memory
  index). Do this before Astra's final gate, not after.
- **Bookkeeping.** Add a ledger row in [renderer-optimization-ledger.md](renderer-optimization-ledger.md)
  after every attempt, and a memory for every trap.

## 3. Roles

- **Sol** implements one phase at a time on a lane branch in its own worktrees (Couch `cc-text-<phase>`,
  GSW `gsw-text-<phase>`). Sol records starting heads and hands back the diff, gate output, evidence paths
  and a short report.
- **Luna** audits each submitted phase from **separate clean worktrees pinned to Sol's commits**. Luna never
  edits Sol's checkouts. Luna's audit covers:
  - the diff;
  - re-running the gates;
  - fixed-clock pixels and hits (byte-identical where promised, paired images where not);
  - licence notes;
  - the claims in Sol's report against the raw evidence.
- **Astra** opens the round by answering the open decisions in §6. At every gate Astra reviews Sol's
  evidence and Luna's audit and returns **one** next action (go, revise or stop). Ask Astra; do not
  self-approve a gate.

## 4. Target architecture

### 4.1 Setting (Couch, device-local)

Plumbing to mirror, all in `frontend/src/mirror/mirrorSettings.ts`:
- Enums like `EFFECT_MODES` (:89).
- Fields in `MirrorSettings` (:164-313).
- `PERSISTED_SETTING_KEYS` (:358-381). The spec at `__tests__/mirrorSettings.spec.ts:508-513` requires
  every field to be either persisted or never-persisted.
- A `STORED_VALIDATORS` entry (:450-468).
- URL-over-saved-over-default seeding in `createMirrorSettings` (:690-770).

What to build:
- **`TextMethod` type and registry.** Add `type TextMethod = "bitmap" | "msdf"`, backed by a
  `TEXT_METHODS` registry of descriptors `{ id, labelKey, helpKey, available(ctx) }`. Adding SDF or Slug
  later is one descriptor plus its implementation.
- **The `textMethod` field:**
  - persisted;
  - **not** a server key (`SERVER_SETTING_KEYS` :318-326);
  - **not** in the `RUST_RENDER_SETTINGS` overlay (:618-629);
  - default `"bitmap"`.
- **Validator:** accepts only registered ids. An unknown saved value, for example a future `"slug"` read by
  an older build, falls back to the default.
- **URL override:** `?textMethod=msdf`.
- **Panel row** in `SettingsPanel.vue`:
  - follow the enum `<select>` pattern (:336-344) with a label map and a `SettingsHelpTip` (`HelpId`
    :190-212, `HELP_KEYS` :216-227);
  - show it only for the canvas stage (`v-if="canvasActive"`, :76; precedent `v-if` :423);
  - hide it while fewer than two methods are `available`.
- **Applying a change:** a brief renderer remount is acceptable. Reuse the stage switch's remount
  (`rendererComparison.ts:121-132` bumps the view revision keyed at `MirrorApp.vue:1508`), which keeps the
  sockets (memory `renderer-apply-preserve-transport`).
- **i18n:**
  - Add label, help and option names in all 14 locales: English `i18n/messages.ts`, `zhHans`, and the 12
    JSON catalogs. `i18n/__tests__/locale.spec.ts:56-80` enforces key and placeholder parity.
  - Reword `settings.help.stage` (:129), which says the Rust stage uses fixed settings.
  - Use real UI terminology (memory `official-localized-ui-name-sources`). Be careful: memory
    `catalog-mistranslations-sep24` records one round's mistranslations. Translate the technique names
    sensibly ("MSDF" stays as is), and say in each help string what the user sees: sharper text when cards
    zoom, possibly lower CPU.

### 4.2 Producer seam (Couch)

Today the Rust path forces `textMode = "native"` (`createPixiMirrorRenderer.ts:364`). The other values
(`native|slug|slug-cached`, `rendererComparison.ts:8`) are Pixi-only and dev-only. Leave Pixi alone.

- **One interface.** Introduce a `RustTextMethod` interface (for example under
  `renderer/pixi/textMethods/`) that the executor calls instead of `rasterTextWithMode`. It covers: prepare
  a record into a carrier, list resource keys, produce uploads within a budget, stats, and dispose.
- **`bitmap.ts`** is today's raster path moved behind the interface, **byte-identical**.
- **`msdf.ts`** is the new method.
- **Selection.** Pick the method in the executor options and add it to the `textPrepCache` key beside
  `textMode` (`createPixiMirrorRenderer.ts:617`, `rustTextPreparation.ts:295`, :336-359).
- **Layout authority stays in Couch.** `rustTextPreparation.ts` (`buildPreparedText` :162, measureText
  layout and line breaking) stays the source of truth for lines and run boxes. MSDF shapes each run and
  places its glyphs inside the measured run box. If the shaped advance and the measured width disagree
  beyond a tolerance Astra sets, **that run falls back to Bitmap**, with a counted reason.
- **Fallbacks are per run, never a blank.** A run falls back to Bitmap when:
  - a glyph is missing (glyph id 0, for example Cyrillic in a face that lacks it; see `glyphPass.ts:690-705`);
  - the outline is wider than the atlas distance range can express;
  - the atlas or generator isn't ready yet;
  - the width mismatch above occurs;
  - shaping fails.

  Expose counters by reason in `__mirrorRendererDiagnostics()`.
- **Rich text.**
  - BBCode colour runs become per-instance colours, with no re-raster.
  - `[b]`/`[i]` role faces are separate font faces.
  - Inline `[img]` keeps its own quads.
  - Hard shadow (blur 0) is an offset instance drawn under the fill.
  - Fix the known key gap, which omits ordered rich runs and colours (memory
    `rust-text-raster-key-omits-runs-sep28`), in any key MSDF introduces.

### 4.3 GSW encoder and Rust contract (generic)

- **Encoder** (`packages/canvas/src/rust-prototype-scene.ts`).
  - Generalise `RustTextCarrier` (:53-61) into a union:
    - `{ kind: "bitmap", … }` (today);
    - `{ kind: "glyphs", method: "msdf" | "sdf", atlas: <resource id>, glyphs: [{ src, dst }], fill, outline?: { color, width }, shadow?: { color, offset }, pxRange }`.
  - Leave room for `{ kind: "glyphs", method: "slug", … }`: Slug needs its own resource kind (RGBA16I blobs)
    and pipeline, so the union must not assume RGBA8 atlas tiles.
  - Emission (:382-409) adds a `glyphRun` command beside `rasterText`.
- **Crate** (`packages/canvas/rust-prototype/`).
  - **New command:** `Command::GlyphRun` in `contract.rs`, beside `RasterText` (:53-57); extend `kind()`
    (:84-93) and admission (:259-275).
  - **Instances:** `geometry.rs` `emit` (:41-109) expands it into instances. `uv_size_slot[3]` is unused
    (0.0 at :86); use it as a per-instance mode (0 sample, 1 MSDF, 2 SDF).
  - **Shader branch** in `shader.wgsl`: `median(r,g,b)`; screen pixel range from `fwidth(uv)` × atlas size
    × `pxRange`; an outline threshold shift; the shadow pass.
  - **Resource formats per resource.** `create_texture` (`renderer.rs:1002-1019`) makes every texture
    `Rgba8UnormSrgb`, but MSDF needs linear `Rgba8Unorm`. Add a format to the resource upload (RSR1 /
    `resources.rs`).
  - **Atlas updates** need partial sub-rect writes and page eviction (LRU).
- **Tests:**
  - `cargo test --locked` in the crate (`tests/contract.rs`; no script runs it, so run it explicitly);
  - `scripts/test-web-pixels.mjs` with a synthetic atlas;
  - `packages/canvas/test/rust-prototype-scene.test.ts`;
  - Couch `createRustDrawListExecutor.spec.ts`.
- **Build:** GSW `rust-prototype/scripts/build-web.sh`; refresh Couch's copy with
  `scripts/build-rust-prototype.sh` (`rust:build`) **inside the Couch worktree**.

### 4.4 Runtime MSDF generation (generic GSW package)

- **Font bytes.** Fonts reach the page only as `@font-face` URLs (`fonts.ts:112-139`), served raw from the
  host's `/res/` route. Fetch the bytes same-origin from those URLs. Precedent: `canvas/glyphPass.ts:369-377`
  `fetchBytes`.
- **No outline API exists.** hb-gpu exports shaping but no outline draw functions
  (`packages/hb-gpu/src/index.ts:218-268`).
- **Proposed generator (Astra decides):**
  - a small Rust crate built to its own wasm and run in a **Web Worker**;
  - outlines via `ttf-parser`, distance fields via `fdsm` (or an msdfgen port);
  - shaping via `rustybuzz`, sharing the parsed face;
  - it returns per-glyph tiles plus metrics; the main thread only uploads them.
- **CJK and Thai.** Generate on demand (CJK cannot be prebaked; Thai needs real shaping). Until a glyph is
  ready, its run renders as Bitmap. Never block a frame on generation.
- **Atlas parameters.** Start from the game's `msdf_size` 48. `pxRange` must cover the widest outline the
  game uses at that em size: the live outline rule is `outline_size*0.5`, because `fontMsdf` is absent from
  the wire (`nodeStyles.ts:65-66`). Pages are about 1024² Rgba8, with a memory cap and LRU.
- **Prior art:** GSW `docs/text-rendering.md` records Godot MSDF alignment error (0.43 px Latin, 0.63 px
  Han, :470-501) and the VRAM cost of large `msdf_size` (:649-653).
- **Optional persistent cache:** an IndexedDB cache keyed by font sha256, glyph id and params. It stays local
  to the viewer's browser, so it is not a committed asset. Astra decides whether it is worth it.

### 4.5 Future methods (design for them; do not build them now)

- **SDF:** the same generator in single-channel mode, mode 2 in the shader, and one new descriptor.
- **Slug:** hb-gpu outline blobs in Rust, with their own resource kind and pipeline. Reuse the atlas,
  eviction and shaping logic of GSW `src/glyph-pass-hbgpu.ts`. Note its blur below 16 ppem (GSW `AGENTS.md`).
- If an interface needs a Bitmap- or MSDF-specific assumption to compile, it is the wrong interface.

## 5. Phases and gates

Each phase: Sol builds, Luna audits, Astra gives one next action.

**Phase 0 — Astra decides.** Astra reads this handoff and §6, answers each open decision with a reason, and
names Sol's first task.

**Phase 1 — Couch: setting and registry, Bitmap only.**
- **Build:**
  - `textMethod` plumbing, persistence and validator, with specs;
  - the 14-locale strings;
  - the registry and the `RustTextMethod` interface;
  - `bitmap.ts` extracted.
- **Hide** the panel row while only Bitmap is available.
- **Luna:** fixed-clock pixels and hits on the Rust stage, byte-identical to `main` on two recordings (a
  combat replay and a card-reward or deck-view replay from `.sts2/bench/`); the locale spec; the settings
  spec.
- **May land** on `main` on its own as `refactor`.

**Phase 2 — GSW: contract, shader, formats, encoder.**
- **Build:**
  - `GlyphRun`;
  - the per-resource format;
  - sub-rect atlas updates with LRU;
  - the MSDF shader branch;
  - the carrier union.
- **Test** on a synthetic MSDF atlas: crate tests, the web-pixels test, and an encoder test.
- **Luna:** existing Bitmap output byte-identical; pixel tests for MSDF fill, outline and shadow edges at
  ×0.5, ×1 and ×3 scale; images listed.
- **Then:** GSW lands on its `main` before Phase 4.

**Phase 3 — GSW: runtime generator package.**
- **Build:** the worker plus wasm; font bytes in, tiles and metrics out; shaping per Astra's decision.
- **Tests:** a licensed test font or synthetic outlines; generation time per glyph; worker failure handling.
- **Luna:** the licence check of every new crate; determinism (same input, same tiles).

**Phase 4 — Couch: MSDF method.**
- **Build:**
  - `msdf.ts` with font fetch, shaping, run placement, per-run fallbacks, and atlas residency;
  - diagnostics counters for glyph runs, fallbacks by reason, atlas pages/bytes, and generation ms;
  - the panel row, which now shows Bitmap and MSDF.
- **Luna:** fixed-clock paired screenshots, Bitmap vs MSDF, at the phone viewport (739x281 @ DPR 3.49,
  stretch on) and at desktop 1920x1080. Cover:
  - combat HUD and damage numbers;
  - card text (including BBCode colour runs);
  - a zoomed or held card;
  - card reward and shop;
  - one CJK locale (`zhs`) and Russian.

  List every image path and summarise the visible differences for the user's decision.

**Phase 5 — quick performance on/off, then user play-test.**
- **Workload:** the same replay with `?textMethod=bitmap` vs `?textMethod=msdf`, ABAB, on the desktop GPU
  (`--use-angle=vulkan`). Use a text-churn workload, such as `.sts2/bench/combat-modern-2026-08-06.ndjson` or
  the card-target repro at `/opt/user/share/`.
- **Report:**
  - `textRasterizations`;
  - `getImageData` and raster ms (from a DevTools profile if needed);
  - GPU texture count and bytes;
  - batches per frame;
  - CDP `TaskDuration`.
- **Phone:** only if the user asks, using their rule (settle 10 s, record ~2 s, ≤45 s, phone parked
  otherwise).
- **Keep the default at Bitmap.** The user chooses after play-testing.

**Phase 6 — Astra's final review.**
- Astra reviews the fidelity images, the performance table and the licences.
- Astra recommends whether MSDF should become the default and which method comes next (SDF or Slug), as a
  one-page proposal.
- Add a ledger row and memories, then close the worktrees.

## 6. Open decisions for Astra (Phase 0)

1. **Shaper:** `rustybuzz` inside the generator worker, or hb-gpu `hb_shape` on the main thread? Weigh
   payload size, the one-HarfBuzz rule, parity with Canvas2D `measureText`, and Thai.
2. **Distance-field crate:** `fdsm`, an msdfgen port, or a custom one, judged on quality, wasm size and
   licence. Also decide MSDF vs MTSDF (MTSDF's alpha channel helps outlines).
3. **Atlas parameters:** em size, `pxRange` (it must fit the widest game outline), page size, page cap and
   eviction policy.
4. **Generator placement:** worker or main thread. If a worker, decide the transfer format and per-frame
   upload budget.
5. **Run-placement tolerance** before falling back to Bitmap.
6. **IndexedDB tile cache:** yes or no.
7. **The interactive-rebuild round:** whether anything in MSDF must wait for it, given that WP3 there changes
   the retained-patch code text records pass through.

## 7. Estimate

- **Switchable Latin/Cyrillic MSDF** with Bitmap fallback for CJK/Thai (Phases 0–4 minus on-demand CJK):
  about 1.5–2.5 weeks.
- **Production:** on-demand CJK/Thai, rich-run, outline, shadow and baseline parity, and the phone
  play-test: about 4–6 weeks.

## 8. Copy/paste prompt for the Codex coordinator

> Run `docs/agents/handoff-text-methods-msdf.md`.
>
> 1. Start with Phase 0: ask Astra to answer §6 and name Sol's first task.
> 2. Sol implements one phase at a time in its own Couch (`couch-worktree`, with a copied
>    `.sts2/rust-prototype-web/`) and GSW worktrees, on lane branches.
> 3. Luna audits each phase from separate clean worktrees pinned to Sol's commits: gates, fixed-clock
>    pixels and hits, paired images with paths, licences.
> 4. Astra reviews every gate and returns one next action.
>
> Rules:
> - Generate MSDF atlases at runtime only; never commit game-derived assets.
> - Keep GSW generic.
> - Keep Bitmap byte-identical and the default.
> - Make the setting device-local, canvas-only and translated in all 14 locales, with a registry that SDF
>   and Slug can join later.
> - Never run Couch `npm run build`, push or tag. Leave the shared sibling checkouts on clean `main`.
>
> Finish with the user-facing switch, the image paths for every visual difference, a light on/off
> performance table, and Astra's recommendation.
