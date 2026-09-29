# WASM caller recovery handoff

## Goal and evidence boundary

Explain and, if possible, repair the generated-WASM leaf and caller coverage
failure **without relabeling unknown samples**. This is a profiler-tool lane,
not a canvas optimization lane. Even a passing tool smoke would permit only a
later Astra-reviewed production capture; it would not establish a production
hotspot, JS/WASM CPU split, desktop saving, or phone result.

The separate [desktop CPU/output lane](handoff-desktop-rust-optimization.md)
may finish before or after this work unless a specific reviewed dependency is
named. Its candidate evidence cannot come from this failed profiler capture.

The original `js-wasm-symbol-smoke-1/` and its repaired
`js-wasm-symbol-smoke-2/` repeat are exhausted. The separately authorized
`fixed-period-tool-1/` capture was the **sole** fixed-period attempt, with no
repair/repeat. Its ignored `QUALIFICATION.md`, `contract.json`, `receipt.json`,
`perf.data`, `perf-injected.data`, `perf-raw-dump.txt`, `samples-ns.txt`, renderer
JIT dump, V8 isolate log, trace, and `analysis.json` are in the Sol Couch
profiling worktree. Preserve them byte-for-byte and audit their hashes before
derived analysis. The campaign readout and the Rust handoff record Astra's
stop decision. The user is authorizing this *new investigation*, not erasing
any previous failure or allowing a replay of the consumed capture.

The fixed-period raw file has 439 samples at 86 million cycles each, zero
LOST/THROTTLE/UNTHROTTLE, event-ID/CPU joins, and a qualified trace clock.
JS named leaves are 214/220 and callers 217/220; WASM named leaves are
202/219 (92.24%, below 95%) and named `wasm_entry` callers 4/219 (1.83%,
below 90%). Four early WASM stacks show `wasm_entry-1-liftoff` at
`0x20e6ab20ca2d`; the next 198 named-inner stacks show the **same** anonymous
caller IP `0x20e6ab20ce5a`, often before a named JS→WASM stub. This sequence
suggests a code or metadata transition, but does not prove that anonymous IP
is `wasm_entry`. The WASM denominator also contains 13 unknown leaves and
four other named leaves. At least seven additional eligible leaves must be
proved to be the expected function to reach 95%; genuine non-target leaves
remain in the denominator.

The capture wrapper exited 1 because it treated deliberate perf-stop SIGINT
as failure (`perfExit=null`, `perfSignal=SIGINT`) although perf wrote a readable
439-sample file. That bookkeeping defect is separate from symbol recovery.
The old adaptive-frequency run had 16 throttles; the fixed-period run had
zero. The pinned source/runtime trace clock is qualified for its Linux browser
configuration, with the documented version-to-source provenance assumption.

## Worktree, owners and isolation

- Sol owns a new isolated Couch profiler worktree based on local
  `experiment/rust-text-ink-readback-sep28` (currently `bfa7fca0`), using
  the setup/safety steps of `couch-worktree` with this explicit
  experiment-branch base and `scripts/install-agent-config.sh`. Copy or read
  the old
  ignored artifacts by explicit path and verify their hashes; a new worktree
  has an empty `.sts2/`. Keep all new raw output ignored there. Own new
  profiler parser/harness files and focused tests only. Do not modify GSW
  canvas, rendering output, or the desktop lane's CPU comparator.
- Luna uses a separate clean Couch worktree pinned to Sol's submitted commit
  and reads raw artifacts by manifest path; Luna never edits Sol's checkout.
  Record starting and reviewed heads. Luna independently audits every
  source-address and timeline join, stack denominator, missing frame,
  clock/loss/identity gate, code diff and fixture result. Astra reviews the
  offline causal hypothesis first and gives one next action; review any later
  actual capture before further profiling.
- Do not use a live desktop capture concurrently with the desktop lane. Any
  **newly authorized** run takes `exclusive:bench:desktop` plus browser/port
  leases via `scripts/live-qa-lock.mjs with`. Choose ports other than
  5219/5220. No phone, visible game window, Couch `npm run build`, deploy,
  push or tag. Agents share repositories and must not revert others' edits.

## Offline-first investigation and falsification

1. Decode the existing renderer `jit-*.dump` LOAD/MOVE/CLOSE records and V8
   isolate log. Join code start, size, load timestamp and name to the four
   early named caller IPs and the repeated anonymous `0x20e6ab20ce5a`.
   Compare `perf.data` raw callchain IPs, injection mappings and generated
   `jitted-*.so` ELF symbol ranges. Check whether the address belongs to a
   renamed/optimized `wasm_entry`, another WASM function, a generic trampoline,
   or no recorded code object. Record unknown rather than guessing. The first
   four named frames followed by 198 anonymous frames are a testable timing
   clue, not proof of V8 tier-up.
2. Check whether 13 unknown leaf IPs fall inside named JIT code ranges and
   whether the four other named leaves are real non-target work. Recompute
   all-phase leaf and caller gates over **all** eligible renderer-main samples,
   with explicit unknown, other, and boundary buckets. Offline symbolization
   may rename a captured IP; it cannot invent a caller frame absent from the
   raw stack. Falsify a recovery hypothesis if the anonymous IP is outside the
   expected code range or the expected caller is absent from raw callchains.
3. Fix the wrapper's stop bookkeeping and add focused tests for intentional
   SIGINT plus readable perf output versus a true collector failure. This is
   reusable tooling, not a retroactive clean exit for `fixed-period-tool-1`.
   Keep its original exit 1 in the ledger.

Give Astra the offline report, exact address/range/timestamp evidence, source
and JIT hashes, a failure explanation and a falsifying result. If offline
evidence resolves the captured caller/leaf gates, have Luna audit the raw join
before marking individual **symbol gates** recovered in a versioned derived
analysis. Preserve the original unqualified receipt and wrapper exit failure;
offline recovery alone cannot turn the historical capture into a clean
successful run. If it does not, Astra decides whether a **distinct,
predeclared** tool-only experiment is justified. This handoff permits at most
one new experiment after that review, with no repair/repeat. It must test a
specific metadata, code-tier or unwinding hypothesis on the pinned production
browser; changing WASM tier is a diagnostic isolation test and cannot by
itself qualify the production path. Do not simply rerun fixed-period-tool-1
or substitute another profiler without a proved source/clock/loss chain.

Before spending that one new capture, require passing offline wrapper/parser
tests, a reviewed clock/configuration manifest, and a predeclared falsifier.
Missing prerequisites stop before capture; a failed new capture gets no repair
or repeat. Preserve the two older exhausted allowances separately. Any new
capture must preserve exact source/browser/WASM/JIT hashes, commands,
PID/TID start identities, native/trace clock bounds, perf event IDs/CPU/actual
periods, full-attachment zero loss and throttling, wrapper exit semantics,
`/proc` process and per-thread CPU, and distinct JS/WASM phase denominators.
Require at least 95% expected named workload leaves and 90% named expected
callers in **each** phase over all eligible samples. Keep cycles/samples
separate from CPU milliseconds and unresolved samples visible. A failed gate
ends this profiler route for Astra review; no combat capture or canvas
candidate follows from a tool smoke alone.

## Verification and merge

Run focused parser/harness tests with raw failure fixtures (missing/moved JIT
record, bad address range, absent frame, wrong PID/ID/CPU, loss/throttle,
clock edge, SIGINT versus crash); run affected Couch script/frontend suites
for any tracked change. Do not run Couch `npm run build`. Commit only complete
reusable code and a concise evidence pointer; keep raw captures and personal
paths ignored. Luna and Astra review the actual diff and artifacts.

Inventory the full Rust experiment-baseline-to-current-main dependency diff
before implementation planning. Identify minimal dependencies and any
additional behavior/defaults. Read this handoff from the current Couch main
checkout; an experiment-based worktree will not contain it until integration.
Reusable profiler tooling that passes on current Couch main may land there
independently as one coherent squash; it
must not import unrelated Rust experiments merely to carry a wrapper fix.
Product work requiring the Rust baseline lands only after its complete
correctness, build/artifact and combined-source acceptance gates pass. The
profiler lane has no GSW product-code merge. For dependent product work,
integrate accepted GSW first and Couch against that exact GSW commit, then
land one coherent squash per repository in the local main worktrees. If tests
or gates fail, leave main clean and report the exact blocker. Preserve original
ignored artifacts in their worktree or rehash a copy into the main worktree's
ignored archive before removing a worktree. No push or tag.

## Copy/paste execution prompt

Continue the separate WASM caller-recovery lane from this handoff. Use separate
Sol and Luna worktrees: Sol for read-only JIT/code-map analysis and one scoped
profiler-tool fix, Luna to independently audit raw IP/timestamp/stack joins
and every gate, and Astra to
review the offline hypothesis and give one next action. Start from the saved
sole fixed-period capture; explain `0x20e6ab20ce5a` using actual JIT LOAD
ranges and raw stacks, inspect the 13 unknown leaves, and fix SIGINT wrapper
bookkeeping without rewriting the old receipt. Preserve the original smoke
repeat and sole fixed-period no-repeat ledger. Only after Astra accepts a
distinct falsifiable hypothesis may Sol run at most one new leased, tool-only
capture; no repair/repeat, combat, canvas candidate or speed claim. Use an
isolated Couch worktree and ignored raw artifacts; serialize desktop resource
use with the desktop optimization lane. Verify, commit, and integrate reviewed
reusable tooling directly into current local main when it passes there; use
the reviewed minimal Rust dependency set only when required.
No phone, prohibited ports, visible game window, Couch build/deploy, push or
tag.
