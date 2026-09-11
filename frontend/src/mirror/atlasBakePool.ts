// The atlas region baker's WORKER POOL — the main-thread half of atlasBakeWorker.ts.
//
// It owns exactly three things: how many workers to spawn on THIS device, which worker a region's job goes to,
// and what happens when any of that fails. The bake queue, the priorities, the strike/self-disable machinery and
// all region bookkeeping stay in atlasBaker.ts; this module is a transport.
//
// WHY A POOL AND NOT ONE WORKER
// The phone measurement behind this round (see atlasBakeWorker.ts's header) says the encode is not expensive, the
// WAIT is: `convertToBlob` encodes PNG as an idle task and a busy combat main thread starves idle callbacks. One
// worker already fixes that — the perf-harness's `worker-imagedata` arm beat inline encoding even at FAN-OUT 1
// (709ms vs 1,238ms) — so a 2-core phone is not excluded, it just gets `poolSize` 1. More cores buy more
// concurrent encodes on top of that, which is what the multi-core phones this client targets actually have.
//
// WHY RESIDENCY IS BUDGETED, NOT ASSUMED
// Each worker decodes the atlas pages it bakes from and holds them as raw RGBA (w × h × 4). Measured in this
// game's own assets: card_atlas_0 4032×4072 = 62.6MB, card_atlas_1 4032×4032 = 62.0MB, card_atlas_2 3528×3080 =
// 41.5MB, ui_atlas_0/1 2048×2048 = 16.0MB each, compressed_0 1936×2020 = 14.9MB, relic_atlas 4096×680 = 10.6MB;
// one recorded card-reward session touched 9 distinct pages ≈ 136MB. Four workers each holding their own copy of
// a card atlas would be ~250MB for ONE page — not a rounding error on a phone. So:
//   * a job PREFERS a worker that already holds its page (so pages spread across the pool instead of replicating),
//   * a SECOND copy of a page is only started when it is both AFFORDABLE (the pool's reported residency plus that
//     page still fits the budget) and AMORTIZABLE (see below) — except for the first copy of a page, which is
//     always allowed or a region could never bake at all,
//   * each worker evicts its own least-recently-used pages past `keepBytes` (its share of the budget, floored at
//     KEEP_MIN_BYTES) and gives back a page bigger than that share once its demand stops (`keepPage`),
//   * and the budget itself is derived from `navigator.deviceMemory`, as is the pool-size cap.
// Residency is REPORTED by the workers (`atlas` / `release` messages), never estimated here.
//
// WHAT RESIDENCY IS ACTUALLY BOUNDED BY — read this before trusting `budgetBytes`.
// `budgetBytes` governs SECOND copies of a page and nothing else. The first copy is unconditional: `holders === 0`
// in placePending bypasses both the affordability and the amortization gate, because a region of a page nobody
// holds must be bakeable or it could never bake off-thread at all. (Refusing it is strictly worse than paying for
// it: a refusal marks the page dead for the session and sends the biggest, most region-heavy atlas to the inline
// path forever — 177-225ms of main-thread stall per region, measured.) So the PEAK is
//     poolSize × largestPage  =  2 × 62.6MB  =  125.2MB  on a 2GB phone whose budget is 48MB,
// and it always will be. What the budget does bound is the SUSTAINED level: a page bigger than a worker's
// `keepBytes` share is given back once its demand stops (see DROPPING A FINISHED OVERSIZED PAGE in
// atlasBakeWorker.ts), so residency between bursts falls back to
//     poolSize × keepBytes    =  2 × 24MB    =  48MB     on that same phone — the budget, exactly.
//   …AND THE SUSTAINED LEVEL IS THAT ONLY WHERE THE IDLE DROP IS ON (Aug-20). On the drop-off tier — 4GB up, and
//   an unreported reading — nothing gives an oversized page back at all, so peak and sustained are the same
//   number and always were: `poolSize × (keepBytes + largestPage)`, e.g. 2 × (32 + 62.6) = 189MB with memory
//   unreported. What changed on Aug-20 is only whether that page is held HONESTLY (the hold slot) or by evicting
//   the whole rest of the worker for it and re-decoding it afterwards — see THE HOLD SLOT below.
//
// WHY AFFORDABLE IS NOT ENOUGH (Aug-14 device follow-up: `atlasLoads: 9` against `atlasPages: 7`)
// A page decode is ~590ms of worker time (fetch + decode + full readback); a region crop+encode is ~8.5ms — see
// `PAGE_DECODE_MS` / `REGION_BAKE_MS` below. Byte-budget affordability alone says nothing about whether that
// 590ms is worth paying: a worker alternating between two pages with only a handful of regions queued on each
// will happily evict-and-redecode every time the budget allows a second copy, which is exactly the 9-loads-for-
// 7-pages defect. A second copy only earns back its decode if there is enough of that SAME page's own queued
// work to spread across it once it lands — roughly `AMORTIZE_QUEUE_REGIONS` regions. Below that bar the job
// stays pending for the worker that already holds the page (`chooseAtlasBakeWorker` returning -1 is exactly
// this "wait instead of decode" outcome, which already existed for the affordability gate).
//
// WHAT THAT BAR ACTUALLY DOES TODAY — read this before "tuning" AMORTIZE_QUEUE_REGIONS.
// It is not a live knob. atlasBaker's own drain caps in-flight work at `bakeConcurrency() = poolSize` and only
// refills a slot when a bake SETTLES, so this queue never holds more than ~poolSize (<=4) jobs and a single
// page's own pending count cannot approach 70 through the real call path. The gate's practical effect in
// production is therefore the stronger rule "one live copy of a page at a time, always" — second copies are
// unreachable, not merely rare, and the constant is the DERIVATION of that rule rather than its tuning. The
// device sweep is what says this is the right rule and not a regression: at poolSize 1 (fully serialized on
// one holder) the phone showed `atlasLoads == atlasPages == 8`, 80.5MB residency and the BEST worst-case bake
// wall (2.3s), while poolSize 4 replicated to 195MB against a 134MB budget and made that wall 1.5s worse.
// Distinct pages still fan out across workers — `holders === 0` bypasses this bar entirely — so what is lost
// is only same-page replication, which measured as a pure loss. If a future change ever lifts the drain cap,
// the bar becomes live again and 70 is the number to argue with.
//
// DECODE AT MOST ONCE PER WINDOW (Aug-19). Everything above is about not decoding a page TWICE AT THE SAME TIME.
// The other way this pipeline paid twice was across TIME: a worker gave an oversized page back once its demand
// stopped for 2s (`keepPage` ⇒ the idle drop in atlasBakeWorker.ts), and every demand GAP in this game — a new
// hand of cards, a screen change — then cost ~590ms of worker time to decode the same card atlas again. So the
// residency policy is now tiered, and this module owns both halves of it:
//   * `resolveAtlasPageDrop` decides the worker's `dropIdleMs` from `navigator.deviceMemory`: OFF at 4GB and up
//     (and when the reading is ABSENT, consistent with the pool-size rule that an unreported device is not a
//     small one), the 2s window below under 4GB. It rides the EXISTING `config` message — the drop was always
//     the worker's decision to take, this only tells it when.
//   * `loadsPerUrl` PINS a page the pool has watched decode a second time: every later job for it is sent with
//     `keepPage: true`, which is already the worker's "do not arm a drop for this page" signal, so the pin needs
//     no protocol of its own. The cap that gives is hard and device-independent: TWO decodes per page per window,
//     everywhere. The first re-decode is the tier's price for the memory; a third would just be the same bet lost
//     twice, on a page whose demand has now demonstrably come back.
// Neither half touched the budget, the LRU or POOL_MAX. The budget ladder and POOL_MAX still stand on the Aug-14
// sweep tables above. The LRU did NOT: it was re-litigated on Aug-20 against live evidence those tables never
// covered — see below.
//
// THE HOLD SLOT (Aug-20). A fresh combat mount in a browser that reports no `navigator.deviceMemory` measured
// `atlasLoads` 18 against `atlasPages` 10: eight second decodes inside ONE mount, on the tier where the idle drop
// is already off, so none of them was a release. They were EVICTIONS. The worker's LRU asked
// `total + incoming > keepBytes` over one flat set of pages, and a card page (62.6MB) is bigger than every share
// the ladder can produce (24 / 32 / 64MB) — so it was evicted by whatever arrived next and re-decoded by whatever
// asked for it after that. That is an ACCOUNTING defect, not a budget one: an 8GB desktop, whose share is twice
// as big, has the identical behaviour. Raising the budget would have moved the number without touching the bug.
// So a worker now holds ONE page at or above `BIG_PAGE_BYTES` in a HOLD SLOT outside the share, plus `keepBytes`
// of smaller pages — bound `keepBytes + largestPage` per worker, which is what the LRU's always-keep-one floor
// had made it all along (see WHAT RESIDENCY IS ACTUALLY BOUNDED BY). `resolveAtlasBigPageBytes` arms it from the
// SAME memory tier as the drop policy, so the two halves of the residency policy cannot disagree: a
// device either holds its big pages (drop off, hold slot armed) or gives them back on a timer (drop on, hold slot
// off, the sweep byte-for-byte as it was). And the gauge for the whole question is `atlasLoads - atlasPages`, not
// `atlasEvicted`: evicting a page whose regions have all baked is free, and only a re-decode is damage.
//
// WHY AN UNREPORTED `deviceMemory` IS STILL WORTH 4GB (Aug-20, re-examined and KEPT)
// The burst above happened on the unreported-memory tier, so the budget's fallback was the obvious suspect and is
// worth writing down rather than leaving as a default nobody has looked at since it was typed. It stays, for the
// same reason the other two unreported-memory rules do: iOS Safari and Firefox report no `deviceMemory` AT ALL, so
// "unreported" is not a desktop bucket — it is a bucket with phones in it. `resolveAtlasBakePoolSize` reads it as
// "not small" (2 workers, not 1) and `resolveAtlasPageDrop` reads it as 4GB-and-up (hold pages, do not drop them);
// `gb = 4` is the same reading, and it lands on the TIER LINE (4 × 16MB = 64MB, mid-way through the 48-128MB
// clamp) rather than on a desktop's 8GB. Guessing high there would hand an iPhone a 64MB share per worker.

/**
 * Absolute cap. Was 4 on the reasoning that past four the encodes stop being the bottleneck; the Aug-14 device
 * sweep measured that the bottleneck is already gone at ONE, and that the third and fourth workers are a net
 * loss. Two 45s arms per size, one build, palindrome order, `hiddenSamples: 0`, an identical 54-region workload
 * in every arm, on de-duplicated code (`atlasLoads == atlasPages == 8` at every size):
 *
 *   workers | slowestSyncMs | slowest bake wall | resident
 *         1 |   6.4 / 5.6   |   3006 / 2558 ms  |  80.5MB
 *         2 |   3.9 / 5.7   |   2579 / 2273 ms  |  80.5MB
 *         4 |  15.4 / 11.6  |   2331 / 2863 ms  | 145.5MB
 *
 * Four workers were the WORST main-thread arm in both of their runs and held 65MB more, because a worker owns
 * its pages: four of them decoding 60MB pages compete for memory bandwidth with the renderer they exist to
 * protect, and the per-worker `keepBytes` share (budget/poolSize) gets small enough that each one sits on its
 * newest page alone — which is how residency overruns the budget it is measured against. Two match one worker's
 * residency exactly (nothing is replicated any more) while decoding DISTINCT pages two at a time, which is the
 * only real parallelism here: ~88% of worker time is one-off page decode and a page decode cannot be shared.
 *
 * So the ladder below tops out at 2. The floor of 1 is still the hard requirement (a 2-core phone must work and
 * must still benefit — it does, since even one worker takes the readback and encode off the main thread: the
 * inline arm measured `slowestSyncMs` 177-225ms against 5-7ms with a single worker).
 */
const POOL_MAX = 2;
const MB = 1024 * 1024;
/** Pool-wide decoded-page budget bounds. 48MB still holds three ui atlases; 128MB two card atlases. */
const BUDGET_MIN_BYTES = 48 * MB;
const BUDGET_MAX_BYTES = 128 * MB;
const BUDGET_PER_GB_BYTES = 16 * MB;

/**
 * Floor under ONE worker's `keepBytes` share, and a LITERAL on purpose. It used to be written
 * `BUDGET_MIN_BYTES / POOL_MAX`, which let an unrelated constant move it: when POOL_MAX went 4 → 2 last round
 * this floor silently DOUBLED, 12MB → 24MB, with nothing in the diff saying so. It is pinned here at the 24MB
 * that expression evaluates to today, so this round changes no shipped value and the number stops tracking the
 * pool cap.
 *
 * Why 24MB is the right literal in its own right: it sits above the largest non-card page this game has
 * (ui_atlas_0/1, 2048×2048 = 16.0MB) and below the smallest card page (card_atlas_2, 3528×3080 = 41.5MB). So a
 * worker's share always holds a whole UI atlas with room to spare, and the card atlases are the only pages that
 * can ever exceed a share — which is exactly the set the worker's idle drop is meant to arm on.
 *
 * The shipped ladder is poolSize 1-2 against a 48-128MB budget, so `budget / poolSize` is at or above the floor.
 */
const KEEP_MIN_BYTES = 24 * MB;

/**
 * THE HOLD SLOT LINE — a page of this many bytes or more is held APART from a worker's share instead of competing
 * with it (see THE HOLD SLOT above, and `evictPages` in atlasBakeWorker.ts).
 *
 * It is deliberately the same line KEEP_MIN_BYTES already draws, and deliberately a CONSTANT rather than anything
 * derived from `keepBytes`. The line is a fact about this game's assets — above the largest non-card page
 * (ui_atlas_0/1, 16.0MB) and below the smallest card page (card_atlas_2, 41.5MB) — so it must not move with the
 * device: an 8GB desktop with a 64MB share would otherwise re-classify the card atlases as ordinary share pages
 * and get back the exact eviction thrash this exists to remove. Same line, two names, because the two uses are
 * different questions: KEEP_MIN_BYTES is the floor under a share, this is the size at which a page stops being
 * budgetable by one.
 */
const BIG_PAGE_BYTES = KEEP_MIN_BYTES;

/**
 * The amortization bar for a SECOND (or later) copy of a page — see "WHY AFFORDABLE IS NOT ENOUGH" above. Both
 * numbers are the Aug-14 device session's own measurement (`workerMsTotal`/`workerEncodeMsTotal` split): a page
 * decode is ~590ms of worker time, a region crop+encode is ~8.5ms. `AMORTIZE_QUEUE_REGIONS` is the break-even
 * queue depth — the smallest number of a page's OWN pending regions that would cost at least as much to bake
 * through the worker that already holds the page as a fresh decode costs to start on a second one.
 */
const PAGE_DECODE_MS = 590;
const REGION_BAKE_MS = 8.5;
const AMORTIZE_QUEUE_REGIONS = Math.ceil(PAGE_DECODE_MS / REGION_BAKE_MS);

/**
 * THE PAGE-DROP TIER — see DECODE AT MOST ONCE PER WINDOW above.
 *
 * `PAGE_DROP_IDLE_MS` is the idle window handed to a small device's workers, and it is the same 2s the worker's
 * own `DROP_IDLE_MS` fallback carries (a spec pins the two together: they describe one window, and a device that
 * gets the value from here must see what a worker left un-configured would do). `PAGE_DROP_MIN_MEMORY_GB` is the
 * line the drop is worth taking below: a card atlas is 62.6MB of RGBA per worker, which is ~3% of a 2GB device's
 * whole memory and under 1% of an 8GB one's, while the re-decode it buys costs the same ~590ms on both.
 */
const PAGE_DROP_IDLE_MS = 2_000;
const PAGE_DROP_MIN_MEMORY_GB = 4;

/** The worker-side idle-drop policy: an idle window in ms, or `"off"` = never give a page back on demand alone.
 *  Mirrors `AtlasBakeWorkerRequest`'s `config.dropIdleMs` — see WorkerMessage for why the wire shapes are
 *  re-declared here rather than imported (importing the worker module would bundle and RUN it on this thread). */
export type AtlasPageDropPolicy = number | "off";

/**
 * How long a worker may hold a page bigger than its share after demand for it stops.
 *
 * The default is OFF from PAGE_DROP_MIN_MEMORY_GB up, and off for an ABSENT reading (Safari/Firefox report no
 * `deviceMemory`) — the byte budget already bounds residency on those, and treating "unknown" as "tiny" would
 * hand the browsers that report nothing the phone policy.
 */
export function resolveAtlasPageDrop(memoryGb: number | undefined): AtlasPageDropPolicy {
  const known = typeof memoryGb === "number" && Number.isFinite(memoryGb) && memoryGb > 0 ? memoryGb : null;
  return known !== null && known < PAGE_DROP_MIN_MEMORY_GB ? PAGE_DROP_IDLE_MS : "off";
}

/** The worker-side hold-slot line: a byte size, or `"off"` = no hold slot (one flat LRU, the pre-Aug-20 rule). */
export type AtlasBigPageBytes = number | "off";

/**
 * The OTHER half of the residency policy, derived from the FIRST half rather than from the device — see THE HOLD
 * SLOT above. The memory tier decides both, so they cannot end up
 * describing different policies:
 *   * drop OFF ⇒ this worker is keeping its big pages for the session, so it needs somewhere to keep them that is
 *     not the share they cannot fit in: the hold slot is armed at BIG_PAGE_BYTES.
 *   * drop ON  ⇒ a big page is given back on an idle timer instead, which is the small-device trade the Aug-19
 *     tier measured. The hold slot is off and the worker's sweep is exactly the one that tier shipped with.
 * Passing the resolved drop policy in (rather than the memory reading) is what makes that structural: there is no
 * ordering of arguments in which the two answers can disagree.
 */
export function resolveAtlasBigPageBytes(drop: AtlasPageDropPolicy): AtlasBigPageBytes {
  return drop === "off" ? BIG_PAGE_BYTES : "off";
}

/** Live counters, folded into `window.__mirrorAtlasBakeStats` by atlasBaker so one probe read covers both. */
export interface AtlasBakePoolStats {
  /** Workers actually spawned (0 = inline path: unsupported or every worker died). */
  poolSize: number;
  /** What the sizing decision was made from, so a device probe can explain the pool size it sees. */
  cores: number;
  deviceMemoryGb: number | null;
  /**
   * The pool-wide byte budget — which is NOT the pool's residency bound, and reading it as one is how the Aug-20
   * eviction defect stayed invisible for a round. It governs SECOND copies of a page and the size of a worker's
   * share; the actual bound is
   *     poolSize × (keepBytes + largestPage)   =   2 × (32MB + 62.6MB)   =   189MB on the unreported-memory tier
   * because the first copy of a page is unconditional and a page bigger than a share is held whole either way (in
   * the hold slot on this tier, by the LRU's always-keep-one floor on the other). See WHAT RESIDENCY IS ACTUALLY
   * BOUNDED BY, and the two fields below for the terms of that sum.
   */
  budgetBytes: number;
  /** …one worker's share of it (`resolveAtlasKeepBytes`), i.e. what its SMALL pages are budgeted against. */
  keepBytes: number;
  /**
   * …and the size at which a page stops being budgeted against that share at all and takes the worker's HOLD SLOT
   * instead (`"off"` = no hold slot; the under-4GB tier, where the idle drop does that job instead). Published for
   * the same reason `pageDropMs` is: when `atlasLoads` runs above `atlasPages` on a device, these three fields are
   * the residency policy that produced it.
   */
  bigPageBytes: AtlasBigPageBytes;
  /**
   * …and the residency policy that came out of the same reading: the `dropIdleMs` every worker was configured
   * with (`"off"` = a page decoded here stays decoded). Published because it is the first thing to check when
   * `atlasLoads` runs above `atlasPages` on a device — see DECODE AT MOST ONCE PER WINDOW.
   */
  pageDropMs: AtlasPageDropPolicy;
  /** Regions a worker returned a blob for, and regions that fell back to the inline path after a worker failure. */
  workerBaked: number;
  workerFailed: number;
  /** Worker-side ms (whole job, including its share of a page decode) and the encode-only part of it. */
  workerMsTotal: number;
  workerSlowestMs: number;
  workerEncodeMsTotal: number;
  /**
   * …and the slowest single ENCODE, which is the number the baker's stall backstop reads on this path (see the
   * "WHICH WALL IS THE DAMAGE" block in atlasBaker.ts). Kept next to `workerSlowestMs` on purpose: the difference
   * between the two is a job's share of a one-off page decode, i.e. the part that must never count as pathology.
   */
  workerSlowestEncodeMs: number;
  /**
   * How long jobs sat in THIS queue before a worker took them — pure waiting (64 regions through 4 workers, and
   * the first copy of a page is exclusive until it reports its size). It is a diagnostic, never a strike: the
   * Aug-14 device session tripped the old wall backstop on exactly this time.
   */
  queuedMsTotal: number;
  slowestQueuedMs: number;
  /** Decoded page loads, pages that failed to load anywhere, and the residency the workers last reported. */
  atlasLoads: number;
  atlasFailed: number;
  atlasBytes: number;
  /**
   * …and how many DISTINCT pages those loads were, which is the only way to read `atlasLoads` honestly: a load is
   * a fetch + decode + full readback (~590ms of worker time each in the Aug-14 device session, against ~8.5ms to
   * encode a region), so `atlasLoads - atlasPages` is decode work the pool paid TWICE — a second copy the budget
   * allowed, a page the LRU evicted, or a page a worker RELEASED once its demand stopped (`atlasReleased`), each
   * of which had to be decoded again. 7 loads of 7 pages is the pipeline working; 7 loads of 5 pages is 1.2s of
   * avoidable worker time.
   */
  atlasPages: number;
  /**
   * Pages a worker gave back, split by why, because each is a way a LATER region of that page can be made to pay
   * for a second decode: `atlasReleased` is the idle drop (a page bigger than that worker's `keepBytes` share
   * whose demand stopped — see DROPPING A FINISHED OVERSIZED PAGE in atlasBakeWorker.ts), `atlasEvicted` is the
   * LRU making room for another page. NEITHER is a load, so neither touches `atlasLoads`; they are here to
   * ATTRIBUTE the `atlasLoads - atlasPages` gap above rather than leave it a mystery.
   */
  atlasReleased: number;
  atlasEvicted: number;
  /**
   * How many regions were held pending for an existing holder rather than triggering a second copy of their page,
   * because that page's own queue had not reached `AMORTIZE_QUEUE_REGIONS` — i.e. decodes the amortization gate
   * AVOIDED. Counted once per region (the first time it is found waiting on this), not once per placement pass,
   * so it reads like `atlasLoads`/`atlasPages`: a count of distinct decisions, not a busy-loop tally. This is the
   * "waited for holder" half of the "waited for holder" vs "loaded a second copy" question a device probe asks.
   */
  atlasAmortizedWaits: number;
  /**
   * …of which were STRIP jobs (N cells of one page composed into one image — the enemy-intent glyph's compositor
   * strip). Counted apart from `workerBaked` purely so a device probe can PROVE the strip is encoded off-thread:
   * a session showing intents with `stripBaked: 0` means every strip fell back to the main-thread canvas.
   */
  stripBaked: number;
  stripFailed: number;
  /** Workers lost to a runtime error (their queues were re-bakeable inline, never stranded). */
  workersLost: number;
}

export const atlasBakePoolStats: AtlasBakePoolStats = {
  poolSize: 0,
  cores: 0,
  deviceMemoryGb: null,
  budgetBytes: 0,
  keepBytes: 0,
  bigPageBytes: "off",
  pageDropMs: "off",
  workerBaked: 0,
  workerFailed: 0,
  workerMsTotal: 0,
  workerSlowestMs: 0,
  workerEncodeMsTotal: 0,
  workerSlowestEncodeMs: 0,
  queuedMsTotal: 0,
  slowestQueuedMs: 0,
  atlasLoads: 0,
  atlasFailed: 0,
  atlasBytes: 0,
  atlasPages: 0,
  atlasReleased: 0,
  atlasEvicted: 0,
  atlasAmortizedWaits: 0,
  stripBaked: 0,
  stripFailed: 0,
  workersLost: 0
};

// The bake stats mirror the fields a probe needs most (see atlasBaker's syncPoolStats), but the whole record is
// published too: `cores`/`deviceMemoryGb`/`budgetBytes` explain the pool size a device ended up with, and
// `workerEncodeMsTotal` vs `workerMsTotal` splits a job's encode from its share of a page decode, with
// `queuedMsTotal` holding the third slice (this queue's own latency) so a probe can read a bake's wall as
// queue + decode + encode instead of guessing which of the three a big number was.
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__mirrorAtlasBakePoolStats = atlasBakePoolStats;
}

/**
 * What one job cost, split so the caller can tell WAITING from WORK. The baker's self-disable reads `encodeMs`
 * and nothing else on this path — see the "WHICH WALL IS THE DAMAGE" block in atlasBaker.ts:
 *   * `queuedMs` is this queue's own latency (a fan-out of 4 over 64 regions HAS to queue),
 *   * `workerMs - encodeMs` is the job's share of a page decode, which the FIRST job for a page pays in full and
 *     every later job for that page pays nothing (measured: 4,680.7ms of worker time, 544.9ms of it encoding),
 *   * `encodeMs` is the crop + `convertToBlob` this region actually caused.
 */
export interface AtlasBakeJobTiming {
  /** ms the job spent PENDING here before a worker took it. */
  queuedMs: number;
  /** the worker's whole job, its wait for the page included. 0 when no worker ever ran it. */
  workerMs: number;
  /** …and the crop+encode part of that — the only part that is this region's own work. */
  encodeMs: number;
}

/**
 * A STRIP job's own payload: N cells of `PoolJob.url`, in frame order, composed into one image whose cells are
 * `cellW × cellH`. Present ⇒ this job posts a `strip` request instead of a `bake` one; everything else about it
 * (placement, residency, `keepPage`, the `blob` reply, the timing split) is a region job's, unchanged.
 */
interface PoolStrip {
  cells: ReadonlyArray<{ x: number; y: number; width: number; height: number }>;
  cellW: number;
  cellH: number;
}

/** A region job handed to the pool. `settle(null, …)` means "bake this one inline instead". */
interface PoolJob {
  key: string;
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Non-null ⇒ a strip job (see PoolStrip). */
  strip: PoolStrip | null;
  settle: (blob: Blob | null, timing: AtlasBakeJobTiming) => void;
  /**
   * Clock stamps for the split above: when the pool accepted it, and when a worker was actually handed it (-1
   * until then — 0 is a legitimate `performance.now()` reading and cannot be the sentinel).
   */
  enqueuedAt: number;
  dispatchedAt: number;
  /** Set once this job has been counted toward `atlasAmortizedWaits`, so a job stuck pending across many
   *  `placePending` passes is counted once, not once per pass. */
  amortizedWaitCounted: boolean;
}

interface PoolWorker {
  worker: Worker;
  /** At most one job at a time: a second concurrent job in the same worker only interleaves its awaits. */
  inFlight: Map<number, PoolJob>;
  /** Pages the worker has REPORTED holding, and the byte total it reported for them. */
  pages: Set<string>;
  bytes: number;
  /**
   * …and pages it has been sent a job for but has not reported yet, i.e. copies that are being fetched+decoded
   * RIGHT NOW. Both halves matter to the budget: without the optimistic half, N jobs for the same page issued
   * before the first report all see "nobody holds it, nothing costs anything" and a 62.6MB card atlas is decoded
   * into every worker at once.
   */
  loading: Set<string>;
  dead: boolean;
}

/** How a worker looks to the dispatch decision — the pure part, so a spec can drive it directly. */
export interface AtlasWorkerSlot {
  holds: boolean;
  busy: boolean;
  bytes: number;
}

/**
 * Which worker should bake a region of this page RIGHT NOW. `canLoadNew` is the caller's budget answer for "may a
 * worker that does NOT hold this page start decoding it". Returns -1 for "none of them may": the job then waits
 * in the pool's pending queue for a holder to free up, rather than being placed behind one worker's back.
 *
 * Placement happens at SEND time, never earlier, so the decision always uses the freshest residency the workers
 * have reported — and a job is never stuck in a queue behind work another worker could have taken.
 *
 * Preference order — holder-first, so pages spread across the pool instead of replicating into it:
 *   1. an idle worker that already holds the page (zero fetch, zero decode, zero extra bytes),
 *   2. an idle worker holding the least, if a new copy of the page is affordable.
 */
export function chooseAtlasBakeWorker(slots: readonly AtlasWorkerSlot[], canLoadNew: boolean): number {
  for (let i = 0; i < slots.length; i++) {
    if (slots[i].holds && !slots[i].busy) {
      return i;
    }
  }
  let best = -1;
  if (canLoadNew) {
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].busy) {
        continue;
      }
      if (best < 0 || slots[i].bytes < slots[best].bytes) {
        best = i;
      }
    }
  }
  return best;
}

/**
 * How many workers this device gets.
 *
 * Cores → pool: `<= 2 → 1`, `>= 3 → 2` (POOL_MAX). This used to climb to 4 with the core count; the device sweep
 * recorded above POOL_MAX says the climb was a loss, so the ladder is now flat past 3 cores. It is deliberately
 * NOT "cores - 1": the parallelism available here is bounded by DISTINCT PAGES in flight, not by cores, because a
 * worker owns the pages it decodes and ~88% of worker time is that one-off decode. An 8-core phone has no more
 * distinct pages to decode than a 4-core one.
 *
 * The floor of 1 is the hard requirement — a 2-core phone must still work AND still benefit, and it does, because
 * even one worker takes the readback and the encode off the main thread (measured: `slowestSyncMs` 177-225ms
 * inline against 5-7ms with a single worker).
 *
 * `navigator.deviceMemory` then caps it, because each worker's page residency is real (see the header): under 2GB
 * one worker. An absent reading (Safari/Firefox) is not treated as small — the byte budget below is the actual
 * residency bound, and it applies either way.
 *
 */
export function resolveAtlasBakePoolSize(cores: number | undefined, memoryGb: number | undefined): number {
  const known = typeof cores === "number" && Number.isFinite(cores) && cores > 0 ? cores : 1;
  let size = known <= 2 ? 1 : POOL_MAX;
  if (typeof memoryGb === "number" && Number.isFinite(memoryGb) && memoryGb > 0) {
    size = Math.min(size, memoryGb < 2 ? 1 : POOL_MAX);
  }
  return Math.max(1, size);
}

/**
 * Pool-wide decoded-page budget: 16MB per GB of reported device memory, clamped, 4GB assumed when unreported (see
 * WHY AN UNREPORTED `deviceMemory` IS STILL WORTH 4GB — that fallback is a decision, not an oversight).
 *
 */
export function resolveAtlasBudgetBytes(memoryGb: number | undefined): number {
  const gb = typeof memoryGb === "number" && Number.isFinite(memoryGb) && memoryGb > 0 ? memoryGb : 4;
  return Math.min(BUDGET_MAX_BYTES, Math.max(BUDGET_MIN_BYTES, Math.round(gb * BUDGET_PER_GB_BYTES)));
}

/**
 * What ONE worker may hold: an equal share of the pool-wide budget, never below KEEP_MIN_BYTES. Note what this is
 * NOT — a ceiling on what a worker ever holds. A page bigger than the share is still decoded and still resident
 * while it has work (a worker cannot bake from a page it refused), so this is the level residency RETURNS to once
 * demand for such a page stops, not one it never crosses. See WHAT RESIDENCY IS ACTUALLY BOUNDED BY.
 */
export function resolveAtlasKeepBytes(budget: number, size: number): number {
  return Math.max(KEEP_MIN_BYTES, Math.floor(budget / Math.max(1, size)));
}

let poolSizeForTest: number | null = null;

/** TEST-ONLY seam for a residency test that must vary page-drop without changing the device policy inputs. */
let pageDropForTest: AtlasPageDropPolicy | null = null;

type WorkerFactory = () => Worker;

/** Vite's worker-URL form — it is what makes the worker its own emitted chunk. Must stay a literal. */
const defaultWorkerFactory: WorkerFactory = () =>
  new Worker(new URL("./atlasBakeWorker.ts", import.meta.url), { type: "module" });

let workerFactory: WorkerFactory = defaultWorkerFactory;

let pool: PoolWorker[] | null = null;
let poolResolved = false;
let poolSize = 0;
let budgetBytes = 0;
let nextJobId = 1;
/** Jobs the pool has accepted but not yet started, in arrival order. Placement happens in pumpPool. */
const pending: PoolJob[] = [];
/** url → bytes, learned from whichever worker decoded it first (never estimated). */
const pageBytes = new Map<string, number>();
/**
 * url → how many times a worker has REPORTED decoding it this session (the `atlas` message), pooled across
 * workers. Two or more ⇒ this page has already been paid for twice, so `send` pins it — see DECODE AT MOST ONCE
 * PER WINDOW. Never cleared while the session lives: the pin is the point, and a page that has bounced once must
 * not be allowed to bounce again just because the counter aged out.
 */
const loadsPerUrl = new Map<string, number>();
/** Pages no worker could load — their regions go inline for the rest of the session. */
const deadPages = new Set<string>();

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * Close a job's books: how long it waited here, what the worker spent, and the encode inside that. Called on EVERY
 * terminal path (a blob, a worker error, a page that died while it waited, a pool that lost its last worker), so
 * the queue-latency counters cover the jobs that never ran too — those waited the same wall the old backstop was
 * charging them for.
 */
function timingFor(job: PoolJob, workerMs: number, encodeMs: number): AtlasBakeJobTiming {
  const queuedMs = Math.max(0, (job.dispatchedAt >= 0 ? job.dispatchedAt : now()) - job.enqueuedAt);
  atlasBakePoolStats.queuedMsTotal += queuedMs;
  if (queuedMs > atlasBakePoolStats.slowestQueuedMs) {
    atlasBakePoolStats.slowestQueuedMs = queuedMs;
  }
  return { queuedMs, workerMs, encodeMs };
}

function navigatorCores(): number | undefined {
  return typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined;
}

function navigatorMemoryGb(): number | undefined {
  if (typeof navigator === "undefined") {
    return undefined;
  }
  const value = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof value === "number" ? value : undefined;
}

/** Spawn the pool on first use (a session that never bakes never pays for it). Returns null for the inline path. */
function ensurePool(): PoolWorker[] | null {
  if (poolResolved) {
    return pool;
  }
  poolResolved = true;
  const cores = navigatorCores();
  const memoryGb = navigatorMemoryGb();
  atlasBakePoolStats.cores = cores ?? 0;
  atlasBakePoolStats.deviceMemoryGb = memoryGb ?? null;
  const wanted = typeof Worker === "undefined" ? 0 : (poolSizeForTest ?? resolveAtlasBakePoolSize(cores, memoryGb));
  if (wanted === 0) {
    return null;
  }
  budgetBytes = resolveAtlasBudgetBytes(memoryGb);
  atlasBakePoolStats.budgetBytes = budgetBytes;
  const workers: PoolWorker[] = [];
  for (let i = 0; i < wanted; i++) {
    let worker: Worker;
    try {
      worker = workerFactory();
    } catch {
      break; // a construction error degrades to whatever spawned so far (possibly nothing) — never throws out
    }
    const entry: PoolWorker = {
      worker,
      inFlight: new Map(),
      pages: new Set(),
      bytes: 0,
      loading: new Set(),
      dead: false
    };
    worker.onmessage = (event: MessageEvent) => {
      onWorkerMessage(entry, event.data as WorkerMessage);
    };
    worker.onerror = () => {
      loseWorker(entry);
    };
    worker.onmessageerror = () => {
      loseWorker(entry);
    };
    workers.push(entry);
  }
  if (workers.length === 0) {
    return null;
  }
  poolSize = workers.length;
  atlasBakePoolStats.poolSize = poolSize;
  const keepBytes = resolveAtlasKeepBytes(budgetBytes, poolSize);
  const dropIdleMs = pageDropForTest ?? resolveAtlasPageDrop(memoryGb);
  // Both halves of the residency policy come off the SAME resolved answer, on the same message — see
  // `resolveAtlasBigPageBytes`. A worker that was told one and not the other would be the one configuration this
  // design has no story for.
  const bigPageBytes = resolveAtlasBigPageBytes(dropIdleMs);
  atlasBakePoolStats.pageDropMs = dropIdleMs;
  atlasBakePoolStats.keepBytes = keepBytes;
  atlasBakePoolStats.bigPageBytes = bigPageBytes;
  for (const entry of workers) {
    entry.worker.postMessage({ type: "config", keepBytes, dropIdleMs, bigPageBytes });
  }
  pool = workers;
  return pool;
}

type WorkerMessage =
  | { type: "blob"; id: number; key: string; blob: Blob; workerMs: number; encodeMs: number }
  | { type: "error"; id: number; key: string; url: string; message: string; atlas: boolean }
  | { type: "atlas"; url: string; bytes: number; totalBytes: number; urls: string[]; loadMs: number }
  | {
      type: "release";
      url: string;
      bytes: number;
      totalBytes: number;
      urls: string[];
      reason: "idle" | "budget";
    };

/** Decoded page bytes the workers have REPORTED holding. */
function residentBytes(): number {
  let total = 0;
  for (const entry of pool ?? []) {
    total += entry.dead ? 0 : entry.bytes;
  }
  return total;
}

/** …plus the copies currently being decoded, priced at what that page cost the worker that already reported it. */
function committedBytes(): number {
  let total = residentBytes();
  for (const entry of pool ?? []) {
    if (entry.dead) {
      continue;
    }
    for (const url of entry.loading) {
      total += pageBytes.get(url) ?? 0;
    }
  }
  return total;
}

/** Does this worker hold, or is it about to hold, that page? */
function holdsPage(entry: PoolWorker, url: string): boolean {
  return entry.pages.has(url) || entry.loading.has(url);
}

function onWorkerMessage(entry: PoolWorker, message: WorkerMessage): void {
  if (message.type === "atlas") {
    pageBytes.set(message.url, message.bytes);
    // What it holds now, plus the page of the job it is running (an eviction inside the worker drops the rest,
    // and its next report re-states the truth).
    entry.pages = new Set(message.urls);
    for (const url of [...entry.loading]) {
      if (entry.pages.has(url)) {
        entry.loading.delete(url);
      }
    }
    entry.bytes = message.totalBytes;
    atlasBakePoolStats.atlasLoads += 1;
    atlasBakePoolStats.atlasPages = pageBytes.size; // never cleared: DISTINCT pages this session (see atlasPages)
    // …and the same count PER PAGE, which is what pins it: the second decode of a page is the last one this
    // session, whatever the device tier says about giving pages back (see `send`).
    loadsPerUrl.set(message.url, (loadsPerUrl.get(message.url) ?? 0) + 1);
    atlasBakePoolStats.atlasBytes = residentBytes();
    // A report can UNBLOCK pending work: the page's cost is now known, so the budget can answer whether a second
    // copy is affordable.
    pumpPool();
    return;
  }
  if (message.type === "release") {
    // A page the worker gave back. Deliberately NOT counted as a load — `atlasLoads` is decode work and this is
    // the opposite — but it does change residency, and freeing bytes can make a second copy affordable, so it
    // pumps like an `atlas` report does. `pageBytes` keeps the page's size: it is still the right price for the
    // next copy of it, and forgetting it would only make the affordability answer "unknown" again.
    entry.pages = new Set(message.urls);
    entry.bytes = message.totalBytes;
    if (message.reason === "idle") {
      atlasBakePoolStats.atlasReleased += 1;
    } else {
      atlasBakePoolStats.atlasEvicted += 1;
    }
    atlasBakePoolStats.atlasBytes = residentBytes();
    pumpPool();
    return;
  }
  const job = entry.inFlight.get(message.id);
  entry.inFlight.delete(message.id);
  if (message.type === "blob") {
    atlasBakePoolStats.workerBaked += 1;
    if (job?.strip) {
      atlasBakePoolStats.stripBaked += 1;
    }
    atlasBakePoolStats.workerMsTotal += message.workerMs;
    atlasBakePoolStats.workerEncodeMsTotal += message.encodeMs;
    if (message.workerMs > atlasBakePoolStats.workerSlowestMs) {
      atlasBakePoolStats.workerSlowestMs = message.workerMs;
    }
    if (message.encodeMs > atlasBakePoolStats.workerSlowestEncodeMs) {
      atlasBakePoolStats.workerSlowestEncodeMs = message.encodeMs;
    }
    if (job) {
      job.settle(message.blob, timingFor(job, message.workerMs, message.encodeMs));
    }
  } else {
    entry.loading.delete(message.url); // it is not decoding that page after all
    if (message.atlas) {
      deadPages.add(message.url);
      atlasBakePoolStats.atlasFailed += 1;
    }
    atlasBakePoolStats.workerFailed += 1;
    if (job?.strip) {
      atlasBakePoolStats.stripFailed += 1;
    }
    if (job) {
      job.settle(null, timingFor(job, 0, 0)); // degrade: the baker re-bakes this region on the inline path
    }
  }
  pumpPool();
}

/** A worker that errored out is gone for the session; nothing it was doing may be left stranded. */
function loseWorker(entry: PoolWorker): void {
  if (entry.dead) {
    return;
  }
  entry.dead = true;
  atlasBakePoolStats.workersLost += 1;
  // Whatever it was running goes back to the FRONT of the pending queue: it is the oldest work in the pool and a
  // node is waiting on it.
  pending.unshift(...entry.inFlight.values());
  entry.inFlight.clear();
  entry.pages.clear();
  entry.loading.clear();
  entry.bytes = 0;
  try {
    entry.worker.terminate();
  } catch {
    // terminate is best-effort; the worker is already unusable either way
  }
  poolSize = (pool ?? []).filter((w) => !w.dead).length;
  atlasBakePoolStats.poolSize = poolSize;
  atlasBakePoolStats.atlasBytes = residentBytes();
  if (poolSize > 0) {
    pumpPool(); // a survivor takes it
    return;
  }
  // No pool left at all: every pending region goes back to the caller, which bakes it on the main thread. Slower,
  // but nothing is dropped and no waiter waits forever.
  const orphans = pending.splice(0);
  for (const job of orphans) {
    atlasBakePoolStats.workerFailed += 1;
    if (job.strip) {
      atlasBakePoolStats.stripFailed += 1;
    }
    job.settle(null, timingFor(job, 0, 0));
  }
}

let pumping = false;
let pumpAgain = false;

/**
 * Place as many pending jobs as the pool can start right now. Called whenever anything changes that could free a
 * worker or change the answer: a new job, a settled job, a page-residency report, a lost worker.
 *
 * A job that no worker may take yet (its page is being decoded somewhere and a second copy is not affordable)
 * stays pending and does NOT block the ones behind it — a region of another page can still go out.
 */
function pumpPool(): void {
  // A placement can fail and lose a worker, which pumps again from inside this loop. Rather than iterate a
  // mutating array, re-run the pass afterwards.
  if (pumping) {
    pumpAgain = true;
    return;
  }
  pumping = true;
  try {
    do {
      pumpAgain = false;
      placePending();
    } while (pumpAgain);
  } finally {
    pumping = false;
  }
}

/** How many jobs still waiting in THIS queue are for this page — the fan-out a fresh decode of it would serve. */
function pendingCountForUrl(url: string): number {
  let n = 0;
  for (const job of pending) {
    if (job.url === url) {
      n += 1;
    }
  }
  return n;
}

function placePending(): void {
  if (pool === null || pending.length === 0) {
    return;
  }
  const alive = pool.filter((entry) => !entry.dead);
  if (alive.length === 0) {
    return;
  }
  for (let i = 0; i < pending.length; ) {
    const job = pending[i];
    const url = job.url;
    if (deadPages.has(url)) {
      // The page failed in a worker while this job waited — hand it straight back for an inline bake rather than
      // leaving it pending against a page no worker will ever hold.
      pending.splice(i, 1);
      atlasBakePoolStats.workerFailed += 1;
      if (job.strip) {
        atlasBakePoolStats.stripFailed += 1;
      }
      job.settle(null, timingFor(job, 0, 0));
      continue;
    }
    const bytes = pageBytes.get(url);
    const holders = alive.filter((entry) => holdsPage(entry, url)).length;
    // The FIRST copy of a page is always allowed (otherwise its regions could never bake off-thread at all). A
    // SECOND one has to be both AFFORDABLE (fit the pool's budget against what the workers actually report
    // holding — a page whose size is not known yet is exactly a page some worker is decoding RIGHT NOW, so it
    // does not get a second copy either) and AMORTIZABLE (enough of the page's OWN queue to earn back the ~590ms
    // decode a copy costs — see AMORTIZE_QUEUE_REGIONS). That is what stops a burst of card-atlas regions from
    // fetching and decoding 62.6MB into all four workers at once, AND what stops two workers alternating between
    // two pages from evicting and re-decoding each other's page every time the byte budget merely allows it.
    const affordable = bytes !== undefined && committedBytes() + bytes <= budgetBytes;
    const amortized = pendingCountForUrl(url) >= AMORTIZE_QUEUE_REGIONS;
    const canLoadNew = holders === 0 || (affordable && amortized);
    const slot = chooseAtlasBakeWorker(
      alive.map((entry) => ({
        holds: holdsPage(entry, url),
        busy: entry.inFlight.size > 0,
        bytes: entry.bytes
      })),
      canLoadNew
    );
    if (slot < 0) {
      // Left pending. Attribute it once, the first time it happens, when the amortization bar — not the byte
      // budget, not "every worker is busy" — is what is keeping this region off a second copy.
      if (holders > 0 && affordable && !amortized && !job.amortizedWaitCounted) {
        job.amortizedWaitCounted = true;
        atlasBakePoolStats.atlasAmortizedWaits += 1;
      }
      i += 1; // nothing may take it yet — leave it pending and look at the next one
      continue;
    }
    pending.splice(i, 1);
    send(alive[slot], job);
  }
}

/** Is this worker already running another region of that page? (At most one at a time today — see PoolWorker.) */
function hasInFlightForUrl(entry: PoolWorker, url: string): boolean {
  for (const job of entry.inFlight.values()) {
    if (job.url === url) {
      return true;
    }
  }
  return false;
}

function send(entry: PoolWorker, job: PoolJob): void {
  const id = nextJobId++;
  // Does this page still have work here once this region is out? The worker needs it to decide whether a page
  // bigger than its share is worth holding on to (see DROPPING A FINISHED OVERSIZED PAGE in atlasBakeWorker.ts),
  // and only this queue can answer — but only for what it can SEE. The baker hands the pool one region per drain
  // task and refills a slot on SETTLE, so `false` here means "nothing else is queued RIGHT NOW", not "nothing
  // else is coming": at poolSize 1 this queue is empty at send time by construction. That is precisely why the
  // worker treats a `false` as ARMING a delayed drop instead of taking one at the crop.
  //
  // …OR this page has already been decoded twice (see DECODE AT MOST ONCE PER WINDOW). That is not an answer
  // about the queue at all — it is the pool refusing to make the same bet a third time on a page whose demand has
  // been shown to come back after a gap. It rides `keepPage` because `keepPage: true` already means exactly "do
  // not arm a drop for this page", so a pin needs no new field, no new message and no worker change.
  const keepPage =
    pendingCountForUrl(job.url) > 0 ||
    hasInFlightForUrl(entry, job.url) ||
    (loadsPerUrl.get(job.url) ?? 0) >= 2;
  entry.inFlight.set(id, job);
  job.dispatchedAt = now(); // everything before this stamp is QUEUE, not work (see AtlasBakeJobTiming)
  if (!entry.pages.has(job.url)) {
    entry.loading.add(job.url); // it is committed to this page from the moment it starts decoding it
  }
  try {
    entry.worker.postMessage(
      job.strip
        ? {
            type: "strip",
            id,
            key: job.key,
            url: job.url,
            cells: job.strip.cells,
            cellW: job.strip.cellW,
            cellH: job.strip.cellH,
            keepPage
          }
        : {
            type: "bake",
            id,
            key: job.key,
            url: job.url,
            x: job.x,
            y: job.y,
            width: job.width,
            height: job.height,
            keepPage
          }
    );
  } catch {
    entry.inFlight.delete(id);
    pending.unshift(job); // loseWorker re-places (or inlines) everything still pending
    loseWorker(entry);
  }
}

/**
 * Hand one region to the pool. Returns false when the pool cannot take it — no Worker support, a page that failed
 * to load in a worker, or every worker lost — and the caller must bake it inline.
 * `settle(null, …)` later means the same thing for a job the pool DID accept but could not finish. Either way the
 * settle carries the job's queue/decode/encode split, because the caller's self-disable may only judge the last of
 * the three.
 */
export function bakeAtlasRegionInWorker(
  key: string,
  url: string,
  region: { x: number; y: number; width: number; height: number },
  settle: (blob: Blob | null, timing: AtlasBakeJobTiming) => void
): boolean {
  if (ensurePool() === null || deadPages.has(url) || poolSize === 0) {
    return false;
  }
  pending.push({
    key,
    url,
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
    strip: null,
    settle,
    enqueuedAt: now(),
    dispatchedAt: -1,
    amortizedWaitCounted: false
  });
  pumpPool();
  return true;
}

/**
 * Hand one STRIP to the pool: N cells of ONE page composed into a single image, encoded once, off this thread.
 * Same contract as `bakeAtlasRegionInWorker` in every respect that matters to the caller — `false` = "the pool
 * cannot take it, bake it yourself", `settle(null, …)` = "it took it and could not finish" — because the caller's
 * fallback is the same one either way.
 *
 * SINGLE PAGE, ENFORCED HERE. Every placement, residency and `keepPage` decision in this module is keyed on one
 * `url` per job, so a strip whose cells span two atlas pages is refused rather than half-modelled: its caller
 * keeps the main-thread strip canvas, which is correct, just one composited layer. Nothing in this game ships
 * such a set (an intent animation's frames are consecutive rects of one atlas), so this is a guard, not a case.
 */
export function bakeAtlasStripInWorker(
  key: string,
  url: string,
  cells: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
  cellW: number,
  cellH: number,
  settle: (blob: Blob | null, timing: AtlasBakeJobTiming) => void
): boolean {
  if (cells.length === 0 || ensurePool() === null || deadPages.has(url) || poolSize === 0) {
    return false;
  }
  pending.push({
    key,
    url,
    // The strip's own box, so a strip job reads like a region job everywhere the two share code (and so a probe
    // dumping the queue sees the pixels it is actually about to produce).
    x: 0,
    y: 0,
    width: cellW * cells.length,
    height: cellH,
    strip: { cells: cells.map((c) => ({ x: c.x, y: c.y, width: c.width, height: c.height })), cellW, cellH },
    settle,
    enqueuedAt: now(),
    dispatchedAt: -1,
    amortizedWaitCounted: false
  });
  pumpPool();
  return true;
}

/** TEST-ONLY: swap the worker constructor (jsdom has no Worker); pass null to restore the real one. */
export function __setAtlasBakeWorkerFactoryForTest(factory: (() => Worker) | null): void {
  workerFactory = factory ?? defaultWorkerFactory;
}

/** TEST-ONLY: exercise pool lifecycle mechanics independently of device sizing. */
export function __setAtlasBakePoolSizeForTest(size: number | null): void {
  poolSizeForTest = size;
}

/** TEST-ONLY: force the page-drop policy; null restores the device answer. Read on the next `ensurePool`. */
export function __setAtlasPageDropForTest(policy: AtlasPageDropPolicy | null): void {
  pageDropForTest = policy;
}

/** TEST-ONLY: tear the pool down so the next call re-resolves it (sizing, budget, query override). */
export function __resetAtlasBakePoolForTest(): void {
  for (const entry of pool ?? []) {
    try {
      entry.worker.terminate();
    } catch {
      // best effort
    }
  }
  pool = null;
  poolResolved = false;
  pending.length = 0;
  pumping = false;
  pumpAgain = false;
  poolSize = 0;
  budgetBytes = 0;
  nextJobId = 1;
  pageBytes.clear();
  loadsPerUrl.clear();
  deadPages.clear();
  atlasBakePoolStats.poolSize = 0;
  atlasBakePoolStats.cores = 0;
  atlasBakePoolStats.deviceMemoryGb = null;
  atlasBakePoolStats.budgetBytes = 0;
  atlasBakePoolStats.keepBytes = 0;
  atlasBakePoolStats.bigPageBytes = "off";
  atlasBakePoolStats.pageDropMs = "off";
  atlasBakePoolStats.workerBaked = 0;
  atlasBakePoolStats.workerFailed = 0;
  atlasBakePoolStats.workerMsTotal = 0;
  atlasBakePoolStats.workerSlowestMs = 0;
  atlasBakePoolStats.workerEncodeMsTotal = 0;
  atlasBakePoolStats.workerSlowestEncodeMs = 0;
  atlasBakePoolStats.queuedMsTotal = 0;
  atlasBakePoolStats.slowestQueuedMs = 0;
  atlasBakePoolStats.atlasLoads = 0;
  atlasBakePoolStats.atlasFailed = 0;
  atlasBakePoolStats.atlasBytes = 0;
  atlasBakePoolStats.atlasPages = 0;
  atlasBakePoolStats.atlasReleased = 0;
  atlasBakePoolStats.atlasEvicted = 0;
  atlasBakePoolStats.atlasAmortizedWaits = 0;
  atlasBakePoolStats.stripBaked = 0;
  atlasBakePoolStats.stripFailed = 0;
  atlasBakePoolStats.workersLost = 0;
}

/** TEST-ONLY: the pool's tuning constants, so a spec asserts the real bounds rather than copies of them. */
export const __atlasBakePoolTuningForTest = {
  POOL_MAX,
  BUDGET_MIN_BYTES,
  BUDGET_MAX_BYTES,
  BUDGET_PER_GB_BYTES,
  KEEP_MIN_BYTES,
  BIG_PAGE_BYTES,
  AMORTIZE_QUEUE_REGIONS,
  PAGE_DROP_IDLE_MS,
  PAGE_DROP_MIN_MEMORY_GB
};
