# Material-cache eviction: why it needs refcounting (design, not built)

Status: **SPEC ONLY** (WS-B commit 6). This round ships the cheap overflow counters
(`matCacheOverflow` / `sharedMatOverflow` in the QA `state` JSON); eviction itself is deliberately
NOT implemented. Build it only if a long soak ever shows the counters climbing.

## The caches and their caps

Two session-lifetime signature caches hold strong refs to shared, live-mounted materials:

| Cache | Owner | Cap | Cap-overflow behavior |
| --- | --- | --- | --- |
| `_procMatCache` / `_canvasMatCache` | `ParticleLayer` (ParticleAttachment.cs) | `MatCacheCap = 512` (each) | returns a FRESH un-cached material per emitter |
| `SharedMats` | `ShaderAttachment` | `SharedMatCap = 256` | share-eligible view falls back to a fresh PRIVATE material |

Both are emptied only on back-to-menu (`ClearMatCaches` / `ResetCaches`), where every entry is
`Dispose()`d deterministically.

## The failure mode the counters watch for

If a session ever produces more distinct signatures than the cap, every signature past the cap
builds a fresh material per emitter/view again — exactly the pre-MATSHARE churn: transient
`ParticleProcessMaterial` / `ShaderMaterial` wrappers piling up undisposed until GC, each carrying a
Vulkan descriptor set (the Mali descriptor-storm driver from the July GPU rounds). The caps were
sized generously (distinct signatures observed per scene are dozens), so overflow is believed
unreachable in practice — but "believed" is not evidence. `matCacheOverflow` (particle, covers both
proc+canvas caches) and `sharedMatOverflow` (shader) increment at the exact cap-fail sites, so a
long soak PROVES whether the hazard is ever hit before anyone builds the risky fix below.

## Why naive LRU eviction is unsafe

An evicting cache must free what it evicts — otherwise eviction just drops the strong ref and
re-creates the GC-latency leak the caches were built to fix. But these caches hand out the SAME
material instance to many live consumers:

- `SharedProcessMaterial` mounts one cached `ParticleProcessMaterial` on every live emitter with
  that signature (`GpuParticles2D.ProcessMaterial`).
- `SharedMats` materials are mounted on many live `CanvasItem`s (`MirrorNodeView.Material`).

`Dispose()`ing an evicted material that is still assigned to a live node frees its RID out from
under the renderer — a rendering bug (invalid material on a live canvas item), not a leak fix. And
evicting WITHOUT disposing regresses to descriptor-storm GC churn. So a correct LRU needs to know
when the last consumer let go: **refcounting** (or an equivalent liveness sweep).

## Sketch: refcounted LRU (the follow-up round, if ever justified)

1. Cache entries become `{ material, refCount, lastUseTick }`.
2. **Acquire** — every site that assigns a cached material to a live object increments:
   `ParticleLayer.Configure`/`Rebuild` (proc + canvas), `ShaderAttachment.EnsureMaterial` (the
   `shared = true` paths).
3. **Release** — every site that unassigns or destroys the consumer decrements: emitter teardown /
   rebuild-replace (`FreeEmitter`, layer `Free`/`QueueFree` via `Predelete`),
   `ShaderAttachment.DisposePrivateMaterial`'s shared-de-ref branch, `ResetView`, and the
   copy-on-write private rebuild in `EnsureMaterial`. Symmetry here is the whole difficulty: a
   missed release pins an entry forever; a double release frees an in-use material.
4. **Evict** — only entries with `refCount == 0`, oldest `lastUseTick` first, and only past a
   high-water mark (cap − headroom); evicted entries are `Dispose()`d immediately (safe: no
   consumer holds them).
5. Back-to-menu keeps today's dispose-everything path (it must also reset all refcounts).
6. Alternative if the release bookkeeping proves too error-prone: a **generation sweep** — walk the
   live emitters/views at a low cadence, mark every material actually mounted, evict+dispose
   unmarked entries older than N sweeps. Costlier per sweep, but needs no per-site release
   discipline.

Godot-side note: `Material.Dispose()` drops the C# wrapper + its RID ref; the RenderingServer frees
the RID (and its descriptor sets) once the last engine-side user is gone. Refcounting the C#
consumers is still required — the engine will NOT protect a canvas item from having its material
resource freed while assigned.

## Decision rule

- Counters stay 0 across the long-session soaks → close this as "caps are effectively unbounded in
  practice"; keep the spec for reference.
- Counters climb → build the refcounted LRU above as its own reviewed round (it touches every
  acquire/release site listed in step 2-3 and needs an A/B soak against the descriptor-storm
  telemetry: `lk*` counters, `engineResources`, `renderVideoMemMib`).
