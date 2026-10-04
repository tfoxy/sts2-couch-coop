# Idle-combat frame cost on the Rust stage — fix handoff

For a Claude Code coordinator (Opus) that runs the round with Opus and Sonnet subagents, each in its own worktree.
The goal is a play-test-visible win on a phone in **idle combat**:
- a cheaper steady frame when only a few things animate;
- no CPU spike when the clock changes its number;
- a Bitmap text cache that stops growing for as long as the session runs.

Base: couch `main` 4db5ebb7, godot-scene-web (GSW) `main` b97a2490. Line numbers below are at those commits.

## 1. What is already known (do not re-measure)

The evidence is the user's phone trace and its source-mapped analysis, both in the main checkout:
- `.sts2/bench/idle-oct2/Trace-20261002T214612.json.gz`
- `.sts2/bench/idle-oct2/analysis/` (`components.tsv`, `burst-tree-*.txt`, `agg.txt`, `threads.txt`, scripts)

The trace was taken on a Moto g86 (Chrome, 739x281 @ DPR 3.49, stretch on) on the Rust stage with Bitmap text. It
covers 4.4 s of idle combat: an intent bob, an orb spin, and the clock ticking once a second. That is 125 frames at
the 30 Hz idle cadence (`CANVAS_IDLE_ANIMATION_FPS`, `renderer/canvas/frameRuntime.ts:26`) and 4 bursts.

> **Update:** WP7 of the wire-shaped-renderer round (`handoff-wire-shaped-renderer.md`) removed
> `CANVAS_IDLE_ANIMATION_FPS` and the 30 Hz idle cadence entirely; idle animation is now display-paced on every
> canvas backend. The cadence figures below are historical, as measured at the time.

**Steady frame: ~11.3 ms of sampled main thread, and every frame is a retained *patch*.**

| Part | ms |
| --- | ---: |
| Wasm render: replay every draw into the picture (`LoadOp::Clear`), then a full-screen copy pass, submit, present | 4.1 |
| Scheduler plumbing: rAF + park `setTimeout` + `postTask` epoch close, so 3 tasks per frame | 2.3 |
| Blink commit and task overhead | 2.3 |
| JS producer: local-anim sample plan, `encodeRustRetainedPatch`, glue | 1.5 |
| Wasm `apply_patch` (serde) + `patch_spans` | 0.75 |
| GC | 0.3 |

- **Other threads per frame:** GPU process ~4.2 ms (CrGpuMain) + 2.35 ms (CompositorGpuThread), and the renderer
  compositor 1.7 ms.
- **CPU-frequency noise:** the same path costs 3–5 ms at the start and end of the trace and 9–11 ms in the middle.
- **How the animations get there:** the intent bob (`IntentHolder`) and orb spin are client local animations. They
  already take the patch path (`planRetainedSample` → `retained.patch(visual.localAnims)`,
  `createPixiMirrorRenderer.ts:1732,1774`).

**1 Hz burst: 45–80 ms. It follows one ~1 KB wire delta, the clock text.** The path:
1. The text change refuses the wire patch (`wire-nontransform-change`, `createPixiMirrorRenderer.ts:1535`).
2. That forces a full build (`paint` :957 → `buildDrawList` :1025, from reconcile :2782).
3. Bitmap raster: an ink canvas plus a `getImageData` readback (`createRustDrawListExecutor.ts:473`,
   `textMethods/bitmap.ts:98`).
4. The diff to the committed scene refuses because the resource list changed (`rust-prototype-scene.ts:953-964`).
5. So the whole scene goes through `admit_scene` (`createRustDrawListExecutor.ts:1123`).
6. The upload clears the whole bind-group cache (`renderer.rs:599`).

| Burst part | ms (typical; first burst) |
| --- | ---: |
| `buildDrawList` full walk | 18.8; 13.9 |
| Bitmap `getImageData` readback (one synchronous GPU→CPU stall) | 8.0; 6.2 |
| Other text raster | 2.4; 1.4 |
| Interaction / hand-raise pass | 3.9; 4.0 |
| `paint()` bookkeeping, executor, full-scene JSON encode | 5.0; 4.3 |
| Wasm `admit_scene` | 4.4; 21.7 |
| `upload_rgba_batch` + bind-group rebuild | 0.8; 19.1 |
| Render, wire receive, scheduler, GC | ~12 |

**MSDF shrinks the burst but cannot remove it.** The digits reuse an existing atlas, which removes the readback,
the new texture and probably the re-admission. But the text change still forces the full JS build (~25–30 ms on
this phone). The Oct 2 MSDF focused-card legs also recorded Bitmap rasters for timer labels, so the timer may still
fall back to Bitmap under MSDF.

**Bitmap text never evicts. This is a leak that grows with play time, in three places:**
1. the JS cache in `textMethods/bitmap.ts` (`cache.set` :129, cleared only on `dispose`);
2. the executor's `uploadedPixels` (`createRustDrawListExecutor.ts:1109`; `:500` deletes only the
   uploaded flag);
3. one Rust GPU texture per string, never released.

A per-second clock makes ~3,600 new strings an hour. The Rust resource format already supports release (RSR2,
`resources.rs:244-258`), and the MSDF atlas uses it (`textMethods/msdfAtlas.ts:79`). Bitmap never does.

## 2. Success criteria

The user's standing preference (memory `user-renderer-playtest-preference`) is **large, obvious wins in a simple
on/off test**, delivered as switches they can play-test. Keep tooling proportionate. A drop below 10% relative
renderer-main busy time is not worth shipping on its own.

**Steady idle frame:**
- renderer-main CPU per frame at least halved (~11 → ≤5 ms in the phone trace's terms);
- GPU-process time per frame visibly lower;
- no extra frames presented.

**Clock tick:**
- no full producer build and no `admit_scene` for a text-only change;
- the burst falls to ≤ ~10 ms with MSDF and ≤ ~20 ms with Bitmap.

**Bitmap cache:** bounded. The diagnostics `resources` count stays flat over a 10-minute idle combat.

**No regression:**
- `rustFastVerify=1` mismatch counters stay 0, including one run under host load;
- the touch harness is as green as `main` (H11 is intermittent on `main`);
- fixed-clock pixels match (the Rust present change needs a pixel comparison, see WP3).

**Visible to the user** on their phone in an on/off comparison. Never claim a phone FPS gain that wasn't observed
there.

## 3. Rules for this round

From `CLAUDE.md`/`AGENTS.md`, restated because each one has bitten a round before:

- **Builds and deploys:**
  - Never run `npm run build`; it deploys.
  - The frontend gate is `cd frontend && npx vue-tsc --noEmit && npx vitest run`.
  - The GSW gates are `mise exec -- pnpm typecheck` (the `test-harness` `upload-bench-entry.ts:281` failure is
    pre-existing), `npx vitest run packages/canvas`, `cargo test` in `packages/canvas/rust-prototype`, and
    `scripts/build-web.sh` then `test-web-pixels.mjs` and `test-integration-browser.mjs` (headless Chromium).
  - Never use the `xvfb-run` targets.
  - Deploy only through `couch-deploy`, after asking the user.
- **Sibling repos:**
  - Leave `../godot-scene-web` and `../spirectl` on clean `main`.
  - GSW work happens in GSW worktrees (`git -C ../godot-scene-web worktree add …`, then `mise trust` and
    `mise exec -- pnpm install --offline --frozen-lockfile`).
  - Couch is aliased to a GSW worktree with `COUCHCOOP_GSW_ROOT=<gsw worktree>`, which `frontend/vite.config.ts`
    honours for dev and vitest.
  - Build a couch worktree's Wasm from it with `COUCHCOOP_GSW_ROOT=<gsw wt> bash scripts/build-rust-prototype.sh`.
  - GSW lands on its `main` first, as one squash commit per change. Then rebuild the main checkout's Wasm, then run
    the couch gate without the alias.
- **No polling** and no spirectl semantic actions. No visible game window. Never push or tag.
- **Switches:** every behaviour change is a switch in `renderer/pixi/rustFastFlags.ts`:
  - default-on once verified, and covered by `rustFast=0`;
  - off individually with `<switch>=0`;
  - shadow-checked by `rustFastVerify=1` wherever it claims exactness.

  GSW behaviour changes must be backward compatible: an old caller sees today's behaviour, and couch probes the
  capability (precedent: `translatesClips`, `createRustDrawListExecutor.ts:97-104`).
- **Input-path QA:** a change to the frame scheduler or held-card paths needs a `touch-input-qa` run (narrowed is
  fine: H11 ×3 vs `main`, H12, H13 `spreadAudit=1`, H14–H17). Use `canvas-*` combo names; bare names select DOM.
  The harness's own game is the `touchqa` instance, never the developer's.
- **Bookkeeping:**
  - Add a ledger row to `renderer-optimization-ledger.md` after every attempt, accepted or not.
  - Update or add a memory with `project-memory`.
  - List image paths for every visual claim.

## 4. Team, models and worktrees

The coordinator is the main session on **Opus**. It owns this plan, creates the worktrees, reviews and merges,
runs the final measurement, and talks to the user. Every implementer is a `round-implementer` launched with an
explicit `model`. Each WP's branch gets an Opus `general-purpose` reviewer running `code-review` at level high;
for a commit range, review by `git diff a..b` if the skill can't target it.

| WP | Owner (model) | Repo / main files | Switch |
| --- | --- | --- | --- |
| WP1 Bitmap eviction | round-implementer (**Sonnet**) | couch `textMethods/bitmap.ts`, `createRustDrawListExecutor.ts` | `rustTextEvict` |
| WP2 readback flag | `mirror-bench` (**Sonnet**), then a small change | couch `createRustDrawListExecutor.ts:78` | `rustTextInkReadFrequently` |
| WP3 damage-region present | round-implementer (**Opus**) | GSW crate `renderer.rs` (+ README), couch executor wiring | `rustDamagePresent` |
| WP4 bind/resource caches | round-implementer (**Sonnet**) | GSW crate `renderer.rs` `texture_bind`, `geometry.rs` | none (exact internal cache) |
| WP5 text-only patch | round-implementer (**Opus**) | GSW `rust-prototype-scene.ts` + crate patch/resources; couch `createPixiMirrorRenderer.ts` reconcile, executor | `rustTextPatch` |
| WP6 idle scheduler | round-implementer (**Opus**) | couch `renderer/canvas/frameScheduler.ts` | `rustIdleScheduler` |
| WP7 (optional) group transforms | round-implementer (**Opus**) | GSW patch contract + couch encoder | `rustGroupTransformPatch` |
| Measurements | `mirror-bench` (**Sonnet**) | read-only, plus `.sts2/bench/idle-oct3/` | — |
| Touch harness | `touch-input-qa` (**Sonnet**) | read-only | — |

Frontend paths above are relative to `frontend/src/mirror/renderer/pixi/` unless shown otherwise.

**Worktrees:**
- **Couch:** use the `couch-worktree` skill (`cc-idle-<wp>` on `round/idle-<wp>`, cut from local `main`).
  - **Copy, don't symlink,** `.sts2/rust-prototype-web/`; a symlink 403s.
  - Export `COUCHCOOP_GAME_MODS_DIR=/tmp/cc-mods-idle-<wp>` before any build.
- **GSW:** `gsw-idle-<wp>` on `round/idle-<wp>`.
- Pass absolute paths in every brief.
- Do not rely on the Agent tool's bare `isolation: "worktree"`.
- A worktree whose Vite serves a running harness must not be edited until that harness finishes.

**Parallelism:**
- **Phase A, in parallel:** WP1, WP2, WP4, WP6. Their files are disjoint, except that WP2's one-line default
  change touches the executor WP1 edits, so land WP2 after WP1.
- **Phase B:** WP3 and WP5. Both touch `renderer.rs`, in different regions (present vs upload/bind invalidation).
  - Run them in two GSW worktrees cut from GSW `main` *after WP4 lands*.
  - The coordinator merges the two GSW branches and lands GSW once.
  - The WP5 couch part follows its GSW part.
- **Phase C:** WP7, only if §6 says it is worth it.

**Briefs:** each brief names its WP section, worktree path, branch and switch name, and asks for:
- a diff on the branch;
- passing gate output;
- the evidence paths;
- a ≤15-line report.

## 5. Work packages

### WP1 — bounded Bitmap text cache (Sonnet) — switch `rustTextEvict`

**At each committed scene**, find the Bitmap raster keys no longer referenced by the committed scene.
- Keep a small recently-unreferenced pool, so toggling labels don't re-raster: an LRU of ~64–128 keys.
- Evict the rest from all three places:
  1. the JS cache and `pads` in `bitmap.ts`;
  2. the executor's `uploaded`/`uploadedPixels`;
  3. Rust, with an RSR2 `{ operation: "release", key }` in the same upload batch. That path is already used by
     `textMethods/msdfAtlas.ts:79`; the encoder is `rust-prototype-scene.ts:730-827`.

**Never release a key still referenced by:**
- the committed scene;
- an in-flight presentation or patch (`asyncSubmissionRevision`);
- the retained base a later patch diffs against.

Key the decision off what actually committed, not off a build that might still be refused.

**Releasing a texture must not clear the whole bind-group cache.** If the crate's release path does
(`renderer.rs:599`-style), add a targeted invalidation in GSW. Coordinate with WP4, which owns the crate's bind
cache, and land the GSW part through WP4's branch.

**Diagnostics:** expose `textEvictions` and the live `resources` count.

**Tests:**
- Specs that a released key is re-rasterised and re-uploaded on reuse.
- No eviction while a key is in flight.
- With the switch off, behaviour matches today's.

**Measure** the quiet-combat replay (§6) for 10+ minutes of replay time: loop it, or stretch it with `--speed`.
Show `resources` flat ON and growing OFF.

### WP2 — `rustTextInkReadFrequently` (Sonnet: measure first, then a small change)

Today the Bitmap ink canvas is created without `willReadFrequently`, so `getImageData` stalls on a GPU→CPU
readback: 6–10 ms per clock tick on the phone. The flag (`createRustDrawListExecutor.ts:78`) makes it a CPU canvas.

1. **Desktop:** quick ABAB on the quiet-combat replay at the phone viewport, flag off vs on. Report the
   text-prepare time per raster from the executor's raster diagnostics, and whether rasters stay byte-identical.
   Compare `raster.rgbaBytes` and pixels; a CPU canvas can anti-alias differently, so if it does, record
   before/after images and say so.
2. **Phone:** ask the user for an on/off pair with `?rustTextInkReadFrequently=1` (settle 10 s, record ~2 s).
3. **If it wins without visible difference:** move it into `RUST_FAST_SWITCHES` (default-on, `=0` off). If it
   differs visibly, report it to the user with images and keep it opt-in.

### WP3 — damage-region present in the Rust renderer (Opus) — switch `rustDamagePresent`

Today every patch replays **all** committed draws into a cleared offscreen picture (`renderer.rs:950-1003`,
`LoadOp::Clear` :983). Then it runs a full-screen copy pass to the surface (:1009-1025), ~2.5 MP at DPR 3.49. That
is most of the 4.1 ms of Wasm per frame, and most of the GPU-process time.

**Design it in GSW, as a backward-compatible option of the crate:**
- **Damage:** keep the picture texture. On a patch, compute the damage as the union of old and new device bounds of
  every changed instance. Include the old bounds of removed draws and the full scope of any changed clip.
- **Redraw only the damage:** redraw the picture with `LoadOp::Load` plus a scissor of the damage. Redraw only the
  draws whose bounds intersect it, in their original order, and clear the scissored region to transparent first.
- **Blending:** blending is order-dependent, so redraw *every* draw intersecting the damage, not just the changed
  ones.
- **Bail to a full redraw** on resize, a resource or bind change affecting draws outside the damage, a damage area
  above a threshold (e.g. 50% of the surface), or a lost context.
- **Surface copy:** decide whether the copy to the surface can also be limited.
  - WebGL's default `preserveDrawingBuffer: false` means the surface contents aren't kept between frames, so a
    scissored copy needs `preserveDrawingBuffer: true`, which has its own cost.
  - Measure both: full copy plus damaged picture, and preserved surface plus scissored copy. Pick the cheaper.
  - **Outcome (Oct 3, follow-up round):** wgpu's `Surface` was the blocker, not WebGL. GSW 2cb5bd0f adds
    `createWithPresent(canvas, mode)`, which owns the WebGL2 context and skips the `Surface`. `direct` (now couch's
    default) halves the full-surface passes per frame; `preserved` scissors the canvas draw to the damage. See the
    `rustPresent=` rows in the [renderer optimization ledger](renderer-optimization-ledger.md).
- **No change at all:** when a frame has no change, skip the present entirely.

**Exactness:**
- Add a browser integration leg in GSW comparing damaged-present pixels with a full redraw, after a randomized
  sequence of patches. It should be byte-identical; if blending makes it not identical, report and justify.
- Couch: a fixed-clock pixel comparison on the quiet-combat replay, ON vs `rustDamagePresent=0`, with image paths.

**Measure:**
- desktop renderer and GPU-process `/proc` CPU, using `bench-rust-ab.mjs`, which already captures both;
- one phone pair from the user.

### WP4 — per-draw bind and resource-index caches (Sonnet, GSW crate; exact, no switch)

**Bind lookup.** Each frame `texture_bind` (`renderer.rs:789`) clones every draw's `Vec<Option<String>>`, then
hashes and compares it to find its bind group.
- Cache the bind group per draw index, keyed by a resource-set epoch, so an unchanged draw does no string work.
- Invalidate only the draws whose resources changed. Replace the wholesale clear at `renderer.rs:599` with targeted
  invalidation, keeping a full clear for resize or context loss.

**Resource index.** Check whether `patch_spans` still builds the resource `HashMap` per patch. `geometry.rs:435-437`
makes it lazy, but the trace shows it on patches that carry updates. If it does, cache it per committed resource
epoch.

**Gates:** the GSW gates. Report a micro-bench of present and patch on a ~3,000-command scene, before vs after.

### WP5 — text-only retained patch (Opus, GSW + couch) — switch `rustTextPatch`

When a wire delta changes only a label's `text` (plus whatever the text record derives from it, such as its
measured size), a full build is wasted work.

**GSW:**
- Let a retained patch add, replace or release resources, carrying the RSR batch with the patch or as one
  transaction with it.
- Let it replace a text command's resource key and quad without refusing on a resource-list change
  (`rust-prototype-scene.ts:953-964`).
- Bind invalidation is targeted (WP4).
- Backward compatible: couch probes the capability.

**Couch:**
- In `tryRetainedWire`, classify a delta whose only change is `text` on text-bearing nodes:
  - re-prepare that one text record with the active text method (Bitmap raster, or MSDF glyph run);
  - re-derive exactly what the build would for that node (size, alignment box and wrapping, anything a parent
    container lays out from the text size);
  - emit a patch.
- Refuse when the change can affect layout outside the node, e.g. a container sizes to the label, autowrap
  changes line count, or a sibling's position depends on it. When in doubt, refuse.
- Shadow verify compares against a full build.

**MSDF check:** find out why the timer label still rasterises as Bitmap under MSDF (the Oct 2 ledger rows in the
text-methods section). Fix it if it is a fallback rule, or report it if it is by design.

**Done when:** a clock tick on the quiet-combat replay produces no full build and no `admit_scene`. Measure with
both text methods.

### WP6 — idle scheduler plumbing (Opus) — switch `rustIdleScheduler`

Each idle frame runs three tasks: the rAF chain, a park `setTimeout` and the `postTask` epoch close
(`frameScheduler.ts:288,290,308-311`). Together that is ~2.3 ms per frame on the phone.

**Goal:** while the idle cadence is steady and nothing is requested (no wire, input or build requests), run one
rAF task per frame. Fold the park timer into the rAF chain, and post the epoch close only when a build or request
actually happened in that epoch.

**Read first:** memory `rust-coalesced-builds-frame-epoch`, then `docs/agents/renderer-optimization-ledger.md`'s
`rustCoalescedBuilds` row. WP2 of the previous round defined the task-epoch semantics, which **must not break**:
- the first lift presents in the same frame;
- at most one build or patch per frame;
- a late epoch close starts a new epoch rather than inheriting work.

The 30 Hz idle cadence (`CANVAS_IDLE_ANIMATION_FPS`) must stay exact, with no drift and no extra frames.
(Superseded: WP7 of the wire-shaped-renderer round later removed this cadence cap entirely; see the note in §1.)

**No polling** (CLAUDE.md): replace a timer, never add one.

**Gate:** scheduler specs, plus the narrowed touch harness.

### WP7 — optional: group-transform patch op (Opus)

Only if, after WP3–6, `encodeRustRetainedPatch` plus `apply_patch` are still more than ~1 ms of an idle frame on the
replay.
- **What:** send one matrix per moving group (the bob and spin roots) instead of re-posed commands as JSON.
- **Where:** GSW contract plus couch encoder, backward compatible.
- **Before starting:** read the Sep 27 `patch/1` rows in the ledger.

## 6. Measurement (mirror-bench, Sonnet; keep it light)

**Idle harness:** `.sts2/bench/bitmap-phase1-oct02/static-combat-a.repro.ndjson` (main checkout), 15.8 s of
current quiet combat.
- Confirm that it contains clock ticks: look for once-a-second `text` deltas. If it doesn't, ask the user for a
  short idle-combat recording (Settings → repro recorder → SAVE; `docs/agents/repro-recorder.md`).
- Run it through `scripts/bench-rust-ab.mjs` at the phone viewport:
  - `--extra-bench-args "--viewport 739x281 --dpr 3.49"`;
  - model the config on `.sts2/bench/rust-fast2-oct1/config.json`, swapping in this recording.
  - This captures renderer and GPU-process `/proc` CPU.
- For build/patch/decline counts, use `scripts/replay-repro.mjs … --gpu vulkan --diag-out <f>` with
  `?stage=canvas&rustProducerReasons=1`. The recipe is in `docs/agents/repro-recorder.md`.
- Use private loopback ports; never 5219/5220. Take the desktop benchmark lease (`scripts/live-qa-lock.mjs`).
- Gate every cell on the Rust backend.
- Note the load average per cell.
- Frame counts can swing between ~24 and ~30 fps runs, so report per presented frame.

**Cells:** ABAB of all new switches on vs all new switches off. Add one `rustFastVerify=1` cell (expect 0), and one
under host load.

**Phone:**
- Give the user switch URLs and ask before any deploy.
- Their trace rule: settle 10 s, record ~2 s; the phone leg is ≤45 s.
- The user drives live play; never script blind input against the live game.

## 7. Integration

**Per WP:**
1. The implementer commits on its branch.
2. The Opus reviewer runs `code-review`.
3. The implementer fixes the findings.
4. The coordinator runs the gates.
5. Merge into the round branch `round/idle-frame` in WP order.

**GSW first:** land GSW branches on GSW `main` as squash commits, rebuild the main checkout's Wasm, and re-run the
couch gate without the alias.

**Final:**
- Narrowed touch harness on the round branch, then the ABAB in §6.
- Squash to couch `main`, one commit per coherent change. Suggested:
  - `perf(mirror): …` for WP1/WP2;
  - `perf(mirror): …` for WP3–WP6.
- Player-facing `Changelog:` lines, e.g. "Idle combat uses less battery and the clock no longer causes a hitch on
  phones." Use `none` for internal-only commits.
- Message format: [../commit-and-release.md](../commit-and-release.md).
- Ask the user before redeploying.

**Close-out:**
- Ledger rows for every attempt (ON/OFF/REJ/MFAIL).
- Update memory `topic-rust-stage` (and add per-WP memories where a trap was found).
- Remove the worktrees.
- Never push or tag.

## 8. Copy/paste prompt for the coordinator

> Run the round in `docs/agents/handoff-idle-combat-frame-cost.md` as its Opus coordinator.
>
> 1. Read §1–§3, the evidence in `.sts2/bench/idle-oct2/`, and memories `user-renderer-playtest-preference`,
>    `rust-coalesced-builds-frame-epoch` and `topic-rust-stage`.
> 2. Create a worktree per WP (couch via `couch-worktree`, copying `.sts2/rust-prototype-web/`; GSW via
>    `git worktree add` + `mise trust` + an offline `pnpm install`).
> 3. Phase A: launch WP1 (Sonnet), WP2 measurement (`mirror-bench`, Sonnet), WP4 (Sonnet) and WP6 (Opus) as
>    parallel agents, each told its worktree path, branch, switch and section.
> 4. When WP4 lands on GSW `main`, run WP3 and WP5 (Opus) in parallel GSW worktrees. Then WP5's couch part.
>    WP7 only if §6 warrants it.
>
> Rules for every WP:
> - Review each branch with an Opus `code-review` pass before merging.
> - Run the narrowed `touch-input-qa` after WP6 and on the final branch.
> - Measure only with the §6 harness at the phone viewport, as a quick ABAB.
> - Add a ledger row per attempt.
> - Never `npm run build`, push or tag; leave the siblings on clean `main`; land GSW first.
>
> Finish by giving the user switch URLs for a phone on/off play-test and the squash commits ready on `main`.
