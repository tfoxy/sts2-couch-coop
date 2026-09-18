# In-game issue reporting investigation

Status: design investigation, 2026-09-16; extended 2026-09-18 with section N. This document specifies a future
contract; it does not add reporting code, provision a service, or authorize telemetry.

Sections A–M design reporting for a join attempt that fails while a healthy host keeps running. Section N
covers the three failures that happen before or outside that path — the game not starting, a native crash that
outruns every log, and a mod that loads but shows no button. Its evidence is source review of this repository
on 2026-09-18; nothing in it was live-proven.

## Evidence, provenance, and limits

The investigation was made from local `main` at `36e466af`, using three isolated worktrees for runtime, Sentry,
and diagnostics/backend research. The primary review reopened the cited source, checked every branch (all were
clean), repeated hashes and assembly metadata checks, reran the focused connection suite, and independently reran
the no-network Sentry harness. Raw decompile details, commands, runtime paths, and experiment output remain in the
primary checkout's ignored research store:

- `.sts2/research/in-game-reporting-runtime-sep16.md`
- `.sts2/research/in-game-reporting-sentry-sep16.md`
- `.sts2/research/in-game-reporting-backend-sep16.md`

Those files are local evidence, not repository documentation. This document keeps only product behavior, public
mod architecture, metadata, and design conclusions allowed by the artifact policy.

One requested experiment could not be run. The live-QA registry was repeatedly held by the unrelated live owner
`conndiagqa` with `exclusive:install`; the lock protocol requires every game session to take `shared:install`.
The investigator did not steal the lease, redeploy, or evade it with another installation. Consequently the
failed-seat-to-same-slot retry behavior in section E is source-proven and consistent with existing files, but the
exact Linux rename/timing sequence is **not live-proven by this investigation**. Windows and macOS behavior is
code/test-backed only and is also marked unverified. This is an evidence limitation, not a reason to loosen the
lock protocol.

Official service documentation and pricing were checked on 2026-09-16. Prices and quotas are dated facts and must
be rechecked before provisioning anything.

Validation completed for the evidence that was available. The focused command
`dotnet run --project tests/CouchCoop.Mod.Tests -- connections` passed; the v111 collecting-transport harness
passed again under a no-network `strace`; local Markdown links and cited source paths resolve; and final
whitespace, requested-section, and artifact-policy checks passed. No frontend path was probed or changed, so a
frontend suite was not relevant. The unavailable live leg is not counted as passing.

## A. Executive recommendation

Ship the first reporting version as an explicit, previewed **Save diagnostic ZIP** workflow with no backend. Make
durable, bounded attempt preservation the first implementation step, because today's useful connection report is
only host-memory state and is lost at host teardown even though a normal retry preserves its bounded excerpt.

Do not initialize the game's Sentry integration, call a static Sentry initializer, use the game's DSN, bundle a
second `Sentry.dll`, or depend on Sentry for collection. Both currently installed game locations are v0.111.0,
while CouchCoop must support the v107 and v111 API lanes; a genuine v107 runtime Sentry input is absent. A direct
v111 `SentryClient` can be isolated from the global hub, but that narrow success does not make the installed SDK a
stable cross-lane product dependency.

If real support volume later justifies a **Send** button, keep the same ZIP as the contract and put a small,
strictly validating CouchCoop intake in front of a private hosted Sentry project. Sentry is the best evaluated
search/grouping inbox for that later phase, not the first collector and not the source of truth. The intake would
enforce size, schema, rate, and privacy policy, then create a normalized Sentry event with the ZIP attached. It
must not become a public ticket portal. A custom full issue database is needless operational work; GlitchTip is a
credible open/self-hosted alternative only if control or hosting policy outweighs that work.

The direct answers are:

| Decision | Recommendation |
| --- | --- |
| Backend in the first shippable version | No. Preserve, preview, and export locally. |
| Silent collection or upload | Never. Local terminal-attempt preservation is allowed; upload requires an explicit action. |
| Best later support inbox | Hosted Sentry behind a narrow validator, subject to a fresh privacy/cost review. |
| Reuse the installed game SDK | No production dependency. Do not call global/static initialization. |
| Bundle another SDK | No; it adds load-context, version-lane, notice, and update risk. |
| Send raw Sentry envelopes from the mod | Not in v1; it shifts queue, protocol, privacy, and abuse work into the client. |
| Build a full custom collector | No. At most, build a narrow intake/validation relay for a later Send phase. |
| Player accounts, public portal, or automatic GitHub issues | No. |
| Screenshot | Outside v1; later only as a separate, optional, previewed attachment. |

After a future Send, the player should immediately receive the local code (for example
`CCH-7K3M9Q2Y6D4T`), see `Sending`, and be able to keep playing. Success adds the remote receipt; failure retains
the exact reviewed ZIP and offers Retry, Save ZIP, and Delete. It never invents success or silently expands the
payload.

## B. Current architecture and data flow

The current system already has strong correlation and bounded diagnostic primitives. The missing property is a
durable immutable snapshot, not another identifier system.

### Host, raw LAN server, browser, and visits

- [`CouchCoopMod.cs`](../../src/CouchCoop.Mod/CouchCoopMod.cs) starts the mod runtime and the seat-side status
  reporter when the process is a headless child.
- [`HotReloadableBrowserServerHost.cs`](../../src/CouchCoop.Mod/Server/HotReloadableBrowserServerHost.cs) and
  [`CouchCoopBrowserServer.cs`](../../src/CouchCoop.Mod/Server/CouchCoopBrowserServer.cs) own the raw
  `TcpListener` HTTP/WebSocket server. A host walks upward from the preferred port until it binds; a seat must bind
  its assigned port exactly.
- A served SPA shell receives a random visit ID before the WebSocket is established. The arrival ring promotes
  that visit when the join or redirected-seat socket presents it. Visit correlation does not by itself authorize
  diagnostic data.
- [`ConnectionArrivalLog.cs`](../../src/CouchCoop.Mod/Connections/ConnectionArrivalLog.cs) retains 128 arrivals
  for 30 minutes. The Copy report renders up to 12 arrivals, prioritizes the attempt's visit within those 12, and
  may add an overflow summary line; it omits query and fragment data.

### Seat allocation, launch, and readiness

- [`HeadlessClientManager.cs`](../../src/CouchCoop.Mod/Session/HeadlessClientManager.cs) and
  [`HeadlessClientManager.Connections.cs`](../../src/CouchCoop.Mod/Session/HeadlessClientManager.Connections.cs)
  allocate the seat, give every process incarnation a monotonically increasing generation, and map slot `N` to
  port `13337 + N * 10`.
- The child receives the slot, client and host identifiers, host PID/build, join address, assigned browser port,
  generation, loopback control URL, and a random bearer token through its environment. These values are useful
  locally but raw environment and command-line dumps must never enter a report.
- [`HeadlessConnectionReporter.cs`](../../src/CouchCoop.Mod/Session/HeadlessConnectionReporter.cs) posts bounded
  status about once a second over the loopback control channel. The host rejects non-loopback, oversized,
  unauthenticated, wrong-generation, and non-monotonic updates. A heartbeat older than 10 seconds is not ready.
- The monitor checks every 250 ms. A terminal failure requests graceful shutdown, waits up to 5 seconds, kills if
  necessary, waits once more, and captures log excerpts. Successful cleanup evicts the stale peer and frees
  claims; failed termination or eviction quarantines the slot and deliberately retains ownership.
- The six registry stages are `connecting`, `choosing`, `initializing`, `joining`, `loading-view`, and `complete`.
  Completion requires host membership and the required browser/frame evidence, not merely a live process.

### IDs and present retention

[`ConnectionRegistry.cs`](../../src/CouchCoop.Mod/Connections/ConnectionRegistry.cs) gives each join attempt a
fresh attempt ID and binds updates to session, slot, process generation, and attempt. Per live entry it bounds
facts to 32 and timeline events to 64. It also retains up to 128 failed issue snapshots in memory.

The existing UI issue/report ID is a retained-row identifier, not the future durable `report_id`. A new retry
archives the old issue before it clears the live row. The native panel keeps the retained issue visible,
selectable, and Copy-able after retry until dismissal, hosting ends, or the 128-entry bound evicts it. Thus a
normal retry does **not** immediately erase the existing bounded Copy evidence. Hosting teardown does.

### Per-platform child profile, logs, caches, and stdio

[`HeadlessUserDirSeeder.cs`](../../src/CouchCoop.Mod/Session/HeadlessUserDirSeeder.cs) creates isolated per-slot
profile roots:

| Platform | Child override | Evidence status |
| --- | --- | --- |
| Linux | `XDG_DATA_HOME=<host-user-data>/couch-coop/headless-slots/slot-N` | Code/test backed; live retry leg blocked here. |
| Windows | isolated `APPDATA` and `LOCALAPPDATA` under the slot root | Code/test backed; not live-verified. |
| macOS | isolated `HOME` with the required application-support ancestry | Code/test backed; not live-verified. |

The normal seat log is the slot's `SlayTheSpire2/logs/godot.log`. Godot manages the current and timestamped prior
logs; its [logging documentation](https://docs.godotengine.org/en/stable/tutorials/scripting/logging.html) says
five files are retained by default. Shader/Vulkan caches and a narrow CouchCoop cache leaf may be shared; the
entire CouchCoop directory is not. If profile isolation fails, the launcher uses an explicit per-slot
`--log-file` in the host profile. Godot's
[`log_path` documentation](https://docs.godotengine.org/en/stable/classes/class_projectsettings.html#class-projectsettings-property-debug-file-logging-log-path)
says that argument disables rotation; the reused fallback path can therefore truncate on a later launch, making
the pre-retry snapshot especially important.

The seat launcher does not separately redirect stdout or stderr, so there is no per-attempt attributed stream in
the current report. The child inherits its parent's streams, and `sts2 game launch` can tee game stdio into launch
artifacts, but a future bundle must add deliberate bounded attribution rather than infer a seat stream from an
unrelated or multi-process terminal file.

### Existing Copy report

[`ConnectionAttemptLogs.cs`](../../src/CouchCoop.Mod/Connections/ConnectionAttemptLogs.cs) checkpoints the host
log at attempt start with no seat path, attaches the seat checkpoint once slot/generation/log path are known, and
later reads bounded post-checkpoint error entries.
[`ConnectionReportFormatter.cs`](../../src/CouchCoop.Mod/Connections/ConnectionReportFormatter.cs) produces a
64 KiB text report, with up to 16 KiB per host/seat excerpt. Its current targeted rules cover authorization/bearer
values, `COUCHCOOP_*TOKEN`, query keys `token`/`access_token`/`auth`, and home-directory forms. The report is useful
and should remain, but it has no ZIP manifest, checksum, browser ring, loaded-mod snapshot, on-disk lifetime, or
delivery receipt.

## C. STS2 Sentry findings

### Do not mix current installs, supported lanes, and stale corpora

The configured stable/default path (whose Steam subscription currently also says `public-beta`) and the separate
public-beta physical install both presently identify as game v0.111.0, commit `41cef1ea`, and contain
byte-identical Sentry assemblies. That is a statement about today's installed runtime, not about the supported
v107 lane.

| Input | Meaning | `Sentry.dll` |
| --- | --- | --- |
| Current stable/default path | Present runtime, currently subscribed to public-beta v0.111.0 | 831,488 B; assembly 6.7.0.0; SHA-256 `4f1619b048d0b0f604265075bc5311f9f2e4a0ecdc09662009b7ee11d50c216c` |
| Current public-beta path | Present runtime, v0.111.0 | Same bytes and hash |
| v111 compile/reference input | Supported API lane input, not proof of installed runtime | assembly 6.7.0.0; SHA-256 `e4edbd7a1c3ba81a233aaf092f4bfbd35f63ff6f086b86b42d85eb4d3181aa4e` |
| v107 compile/reference input | Supported API lane input, not proof of installed runtime | assembly 5.0.0.0; SHA-256 `2d51be4d98f31abf6c83d6c24837200bb2af8305c1e82e286d19f297cf5c7a5d` |
| Historical public corpus | Recorded v0.107.1 only | Stale corpus; not evidence for today's installed binaries |

Both current installs also contain identical `Sentry.Godot.dll`: 59,392 B, assembly 1.0.0.0, SHA-256
`bef522b322662f6dbf280891e23e2001483107f8bb981f1692c264928753112a`. No genuine active v107 installation was
available, so this investigation makes no v107 runtime hash or load-context claim. As a separate current-build
identity check, both installed `sts2.dll` files hash to
`2b40d2df538db1ceb5fa48d958c80ab730ada1e07db88a870aff01a661768b9f`.

### Initialization, shutdown, and isolation

Metadata inspection confirms that the game's integration owns process-global SDK state and is deliberately shut
down for modded play. Its logs can contain startup/shutdown lines, but CouchCoop must not force it on, call its
test command, or use its DSN. Raw implementation reconstruction remains only in the ignored Sentry research note.
The installed integration covers managed event handling and native crash handling. Native crash hooks are
process-wide, so a mod cannot safely “reuse” them by filtering only managed events. CouchCoop has no owned
crash-upload path today.

Calling the installed managed SDK's static `SentrySdk.Init` replaces and disposes the process-global current hub.
Therefore `SentrySdk.Init`, `Close`, and `BindClient`, and the Godot static initializer, are forbidden for this feature.
Breadcrumbs and attachments added to the game's scope would likewise cross an ownership boundary.

A temporary v111-only harness directly constructed `SentryClient` with an in-memory collecting transport, empty
DSN, file writes disabled, and 250 ms flush/shutdown timeouts. It captured exactly one event envelope containing a
breadcrumb and attachment, returned a non-empty event ID, left the `CurrentHub` object identity unchanged, and
left no cache entries. The primary reviewer reran it under `strace`; the only `connect` calls were failed local
Unix tracing-socket probes, with no network-family connection. This proves the narrow API behavior and nothing
about normal Sentry transports, v107, or product fitness.

### Options

| Approach | Finding |
| --- | --- |
| Reuse installed SDK | Reject as a product dependency: two supported lanes, game-owned lifetime, update/ABI risk, no current v107 runtime proof. |
| Bundle a separate SDK | Reject: same-simple-name/load-context collision risk, per-lane maintenance, licensing/notices, and artifact-policy concerns. |
| Direct Sentry envelopes | Keep as a future adapter option only; CouchCoop would own serialization, compatibility, queuing, privacy, and rate behavior. |
| Avoid Sentry in v1 | Recommended. Collection and the local ZIP work entirely without it. |

The open-source Sentry .NET SDK is MIT-licensed. The server-side project has mixed terms: the main Sentry and
Codecov web-app components use the current [Functional Source License](https://open.sentry.io/licensing/), while
other components retain their own open-source licenses. Self-hosting is operationally substantial regardless.
Licensing still needs a release-time notice review if a future implementation adds any package.

## D. Diagnostic coverage matrix

`unavailable` is a first-class result with a closed reason code; it is never replaced with a nearby file or stale
process merely to make the report look complete.

| Evidence | Today | Future bundle source | If unavailable |
| --- | --- | --- | --- |
| Host build, OS, patch/listener state | Copy report facts | Frozen host snapshot | `host_snapshot_failed` |
| Six-stage facts/timeline | In-memory, bounded | Frozen attempt JSON | `attempt_not_retained` |
| Visit/arrival correlation | In-memory arrival ring | Sanitized matching arrivals | `visit_not_observed` |
| Host log | 16 KiB error excerpt | Bounded host log context | `log_missing`, `rotated_before_capture`, or `read_failed` |
| Previous failed seat log | Frozen excerpt while host lives | Durable terminal-attempt snapshot | `attempt_not_retained` or `log_missing` |
| Current seat log | Current checkpoint/excerpt | Authenticated generation-bound receipt or local path | `seat_not_running`, `seat_timeout`, or `generation_mismatch` |
| Process exit | Partial registry facts | PID, generation, exit kind/code, monotonic timing | `exit_code_unavailable` |
| stdout/stderr | Inherited, not separately attributed/captured by seat launcher | Omitted in v1 | `not_attributed_to_attempt` |
| Browser diagnostics | No dedicated ring | Established WebSocket, bounded nonce-bound reply | `browser_never_reached_host`, `browser_disconnected`, or `browser_timeout` |
| Host/seat loaded mods | Not in Copy report | New read-only spirectl loaded-mod snapshot in each live process | `bridge_timeout` or `load_order_not_exposed` |
| Cache contents | Exists, not diagnostic contract | Omitted | `omitted_by_policy` |
| Network | Raw addresses may exist in arrivals | Topology class and relation only | `omitted_by_policy` |
| Screenshot | None | Outside v1, separate consent later | `omitted_by_policy` |
| Windows/macOS runtime behavior | Code/test only here | Same contract after platform QA | `platform_not_live_verified` |
| Startup phase reached | Checkpoints to stderr/log only | Boot ledger (§N.1) | `boot_log_missing` or `never_reached_init` |
| Previous run's outcome | Nothing survives a crash | Clean-shutdown seal (§N.2) | `no_clean_shutdown` |
| Previous run's log | Rotated away, unattributed | Sealed on the next launch (§N.2) | `crashed_before_seal` or `rotated_before_capture` |
| Native crash site | None | OS crash record (§N.4) | `os_crash_record_unreadable` |
| Harmony patch health | In-memory row, unreachable if the panel is gone | Ledger fact plus the §N.5 surface | `patching_unavailable` |

## E. Headless log lifecycle and durable retention

### What happens today

At `BeginAttempt`, the registry creates a new attempt ID, clears the live row, and checkpoints the current host
log. Once the slot/generation exists, the seat checkpoint is attached. On terminal failure, cleanup reads both
bounded slices before removing the connection. A retry awaits pending cleanup, so the normal retry cannot launch
the next same-slot process before that excerpt read finishes. The retained issue row is copied before asynchronous
tail enrichment and remains independently addressable.

On the normal isolated-profile path, a later process reuses the same current `godot.log`; existing local files and
Godot's documented logger behavior indicate rotation to a timestamped prior file. On the fallback explicit-log
path, reuse can truncate. Either way, the new attempt's fixed current-log path cannot identify the prior process's
raw file after rotation/truncation. The old bounded excerpt survives only in the host process.

Therefore the plan's initial “retry overwrites all evidence” hypothesis is too broad: normal cleanup protects the
current bounded excerpt. The real gap is that there is no atomic, on-disk, session/attempt/generation-bound
snapshot before file identity changes, and all retained issue rows disappear at host teardown or crash.

Host teardown is not the only loss, and a seat is not the only process worth preserving: a host that crashes —
or never reaches `Init` at all — loses everything this section describes, because the host is the writer. §N.2
adds a **process-scoped** record to the same store, under the same caps, retention and redaction, sealed by the
next launch rather than by a live host. The indexing key there is host session + process generation + launch,
not attempt + slot; a report selects a process record and an attempt record independently.

### Required future preservation

On every terminal failed seat attempt, before releasing the slot or allowing retry:

1. Freeze IDs, slot, generation, PID, exit code/kind, stage, monotonic timestamps, matching arrival IDs, exact
   log checkpoints, and the last generation-bound loaded-mod receipt into an immutable record. Capture/refresh
   that inventory while the seat is authenticated and alive; if the process dies first, record it unavailable.
2. Read/redact bounded host and failed-seat context while the paths still refer to that attempt.
3. Write a versioned snapshot to a new file and atomically rename it only after checksums and caps pass. A crash
   leaves no accepted partial snapshot.
4. Index it by host session + client + attempt + slot + generation. A later report selects only an exact match.
5. Retain the last **3 terminal snapshots per slot**, no longer than **7 days**, under a **16 MiB global cap**;
   delete oldest eligible snapshots first. Each snapshot is capped at **640 KiB uncompressed** (64 KiB JSON plus
   256 KiB each for host and failed-seat log context, plus 64 KiB reserved for the bounded inventory receipt,
   checksums, and framing). Never delete a snapshot being previewed or bundled.

These local snapshots are allowed without upload consent because they are bounded crash preservation in the
game's user-data directory. They are still redacted at capture, never silently sent, and surfaced in the same
delete/retention controls as exported bundles.

### Observed sizes and exact selection caps

The primary review measured the 31 current Godot logs beneath the active `SlayTheSpire2` user-data tree: 1,411,965
bytes total; minimum 18,127; median 49,269; nearest-rank p95 73,149; maximum 75,661. Mature log directories held
five files. A broader exploratory local corpus was excluded from the committed sizing claim because it mixed
provenance.

Use at most **256 KiB per included process log**, selecting non-overlapping regions:

| Region | Cap | Purpose |
| --- | ---: | --- |
| Beginning | 16 KiB | Build/startup/patch context |
| Event blocks | 192 KiB | Complete WARN/INFO/ERROR blocks selected by closed snapshot IDs and bounded context |
| End | 48 KiB | Shutdown, exit, and late failure context |

If a log fits, include it once rather than repeating regions. For a larger log, report ranges, rotation/truncation,
invalid UTF-8 replacement, and omissions in the manifest. Selection markers come only from host-generated closed
fields, never user description or browser text. This comfortably contains all active-tree observations while
remaining safe when logs grow much larger.

## F. Report contract, bundle, and example manifest

### Immutable snapshot

`ReportSnapshot` is frozen when Preview begins. Later retries, visits, process exits, or browser messages cannot
mutate it; late data requires a new Preview. The canonical `report_id` is a random 128-bit identifier. The
`CCH-` plus a 12-character Crockford Base32 payload is a human locator, not authentication. Keep the existing
identifiers in their own namespaces:

- `host_session_id`, `client_id`, `attempt_id`, and correlated `visit_id`;
- slot, process generation, PID, lifecycle stage, exit kind/code and monotonic timing;
- exact previous-failed-seat snapshot identity and current-seat identity;
- host/current/failed-seat evidence receipts with included/unavailable/redacted/omitted status;
- browser receipt identity and actual loaded-mod inventory receipts;
- schema version, collector version, timestamps, limits, redaction counts, entries, and checksums.

### ZIP allowlist and limits

Only fixed, generated ASCII entry names may reach the ZIP writer. No log, browser, mod, or user value can name an
entry. Hash entries **after** normalization and redaction. Reject duplicates and unknown entries. The manifest
lists the size and SHA-256 of every non-manifest entry; it does not recursively list or hash itself. Compute the
finished ZIP's SHA-256 after close and store/display that receipt outside the ZIP.

| Entry | Maximum uncompressed size |
| --- | ---: |
| `manifest.json` | 24 KiB |
| `summary.txt` | 32 KiB |
| `description.txt` | 4 KiB |
| `host/attempt.json` | 64 KiB |
| `seat/previous-failed/attempt.json` | 48 KiB |
| `seat/current/attempt.json` | 48 KiB |
| `host/log-context.txt` | 256 KiB |
| `seat/previous-failed/log-context.txt` | 256 KiB |
| `seat/current/log-context.txt` | 256 KiB |
| `browser/diagnostics.json` | 32 KiB |
| each of `inventory/host.json`, `inventory/previous-failed-seat.json`, `inventory/current-seat.json` | 48 KiB |

The whole archive is capped at **1,280 KiB uncompressed** and **1,312 KiB compressed**. The slightly higher
compressed limit allows ZIP framing and incompressible input while the lower uncompressed limit is the anti-bomb
boundary. Enforce per-entry and aggregate counters while streaming; write `manifest.json` from final receipts and
commit the archive atomically. Do not use compression ratio as a trust signal.

Keep at most **3 successful or approved-pending bundles**, **7 days**, and **4 MiB compressed total**, oldest
eligible first. A preview/active send is ineligible for eviction; inability to make room is an honest error. The
optional user description is limited to **1,024 Unicode scalars and 4 KiB UTF-8**, whichever comes first.

### Browser diagnostic ring and message boundaries

The browser keeps at most **128 entries**, **256 UTF-8 bytes per entry**, **32 KiB serialized**, or **15 minutes**,
whichever limit is reached first. Apply the per-entry byte cap before insertion, parsing, or serialization.
Allowlisted events are page load, host/seat socket open/close/error, redirect, protocol mismatch, first frame,
sanitized renderer failure, visibility change, and diagnostic receipt. Do not collect console history,
URLs/query strings, request bodies, DOM/scene state, inputs, storage, cookies, or arbitrary stacks.

The host sends a one-time nonce plus report/session/client/attempt/visit IDs over an already established WebSocket.
The browser echoes those closed fields with its ring. Seat evidence travels through the existing authenticated
loopback seat-to-host control boundary and is also fenced by slot and generation. The host rejects mismatches,
replay, over-cap, and late receipt. If the browser never established the relevant connection, the manifest says
`browser_never_reached_host`; there is no fallback scrape.

### Loaded mod inventories

Inventory must describe the mods actually loaded in the host and relevant seat processes through reusable,
read-only spirectl surfaces. Never enumerate Workshop subscriptions, folders, or manifests as a proxy.

Today's `GetMods` result is sorted by ID, so it proves membership but not load order. Before claiming load order,
spirectl should expose a bounded diagnostics snapshot with `load_index`, `id`, `version`, `source_class`,
`load_state`, `enabled`, and `active`. `source_class` is a closed path-free class, not the raw source. Omit paths,
assembly paths, and raw loader errors. Capture the failed seat's generation-bound inventory while it is still
alive and persist the receipt in terminal preservation; Preview cannot query a dead process. Until the ordinal
exists, mark the order-sensitive inventory `load_order_not_exposed`; do not sort and relabel it as load order.

### Example manifest

```json
{
  "schema_version": 1,
  "report_id": "2f02a6af2b404b1eb9eef2bc03216bf3",
  "issue_code": "CCH-7K3M9Q2Y6D4T",
  "captured_at_utc": "2026-09-16T15:30:00Z",
  "collector_version": "future-version",
  "status": "partial",
  "correlation": {
    "host_session_id": "c3d696bf7c8d44d5905f362763072aa3",
    "client_id": "38153c99741a4dbba16bda257cfd9efa",
    "attempt_id": "3ef91c5d1c9e42d8978185b8a77d2488",
    "visit_id": null
  },
  "seat": {
    "slot": 2,
    "generation": 4,
    "pid": 4217,
    "exit_kind": "exited",
    "exit_code": 1
  },
  "privacy": {
    "consent": "explicit_export",
    "network": { "family": "ipv4", "scope": "private_lan", "relation": "viewer" },
    "redactions": { "credential": 0, "home_path": 3, "query_token": 1, "invalid_utf8": 1 }
  },
  "sources": {
    "host": { "status": "included" },
    "previous_failed_seat": { "status": "included", "generation": 3 },
    "current_seat": { "status": "unavailable", "reason": "seat_not_running" },
    "browser": { "status": "unavailable", "reason": "browser_never_reached_host" },
    "host_inventory": { "status": "included" },
    "seat_inventory": { "status": "unavailable", "reason": "load_order_not_exposed" }
  },
  "entries": [
    { "name": "summary.txt", "bytes": 2142, "sha256": "<64-lowercase-hex>" },
    { "name": "host/attempt.json", "bytes": 9411, "sha256": "<64-lowercase-hex>" },
    { "name": "host/log-context.txt", "bytes": 44218, "sha256": "<64-lowercase-hex>" },
    { "name": "inventory/host.json", "bytes": 2331, "sha256": "<64-lowercase-hex>" }
  ],
  "non_manifest_uncompressed_bytes": 58102,
  "limits": { "uncompressed_bytes": 1310720, "compressed_bytes": 1343488 }
}
```

JSON `null` is used only where the schema permits a missing correlation value; evidence sources always carry a
status and, when unavailable, a closed reason. `manifest.json` is required but intentionally absent from its own
`entries` array. The finished archive SHA-256 and byte size are an external local/upload receipt.

## G. Lifecycle, offline behavior, retry, and cleanup

1. **Terminal attempt preservation:** failure freezes and atomically stores the bounded local attempt snapshot
   before the slot can be reused. Nothing is uploaded.
2. **Open Report a problem:** the native host selects a retained issue/attempt. Browser users may be told to ask
   the host; browsers cannot initiate collection.
3. **Preview:** mint `report_id`, freeze correlation, request bounded seat/browser receipts, collect host evidence,
   redact, validate, and display the exact readable summary, description, entries, sizes, omissions, and target.
   Use a 2-second timeout per remote source and a 5-second total collection deadline; gameplay never waits.
4. **Consent:** Save ZIP is an explicit local action. A future Send is a separate explicit action against the same
   reviewed bytes. Changing description or evidence requires a fresh Preview.
5. **Commit:** atomically write `couchcoop-report-<report_id>.zip` beneath the game user-data `reports/` directory.
   Delete partial files on cancel/error. Display issue code and archive SHA-256.
6. **Future send:** one immediate request plus at most three visible retries after 5 seconds, 30 seconds, and
   5 minutes, each with ±20% jitter. These retries belong to the explicit Send action and stop when the host
   closes. After restart, never auto-send; offer Retry, Save ZIP, or Delete for the approved pending bundle.
7. **Receipt:** persist only the local report ID, destination class, remote receipt/event ID, attempt count, and
   timestamps. Do not treat a local Sentry event ID as server acceptance.
8. **Cleanup:** enforce count, age, and byte caps after successful atomic writes and on startup. Never traverse or
   delete outside the dedicated report/snapshot roots.

## H. Minimal native-host-first UX

The native connection panel is the right owner **when the panel exists**. It already shows live and retained
issues and can correlate host/seat evidence — but it is reached only through the lobby's Couch Co-op button, so
it is unreachable in exactly the sessions where the mod failed to attach to the game. §N.5 has the finding and
the patch-independent entry points that fix it; this section describes the ordinary path. V1 needs one entry
point and two screens:

1. **Report a problem** opens a short explanation: “CouchCoop can create a diagnostic ZIP containing the selected
   connection attempt, bounded game logs, loaded mod details, and browser connection events when available. It
   does not send anything automatically.”
2. An optional **What happened?** field shows both `0 / 1024 characters` and `0 / 4096 UTF-8 bytes`, plus “Do not
   include passwords, access codes, account details, IP addresses, or other private information.”
3. **Preview** shows the post-redaction description, issue code, destination (`Save on this computer`), exact file
   list/bytes, unavailable reasons, redaction counts, retention, and Delete/Back.
4. **Save diagnostic ZIP** performs the explicit action. The result screen provides Copy support text, Open
   folder where supported, and Delete. It never claims a support ticket exists.

A later phase may add **Send privately to CouchCoop support** beside Save ZIP, with the named operator, retention,
privacy link, same preview, progress, receipt, and failure actions. No account, CAPTCHA in the game UI, public
thread, automatic GitHub issue, or browser-only report flow is needed. Localization and keyboard/controller focus
must be part of that implementation, not follow-up polish.

Screenshots remain outside v1. If later evidence proves their value, use a separate initially-off checkbox,
preview the actual image, scrub overlays where possible, and cap it at 1 MiB before compression. It must never be
silently added because a backend accepts attachments.

## I. Backend and service comparison

| Option | Maintenance and search | Privacy, attachments, abuse | Offline/player friction | Migration cost |
| --- | --- | --- | --- | --- |
| **Export-only (v1)** | Local schema/redactor/ZIP/tests; support searches manually by issue code/build. | No public ingest surface; exact local preview. | Fully offline, but player must attach the ZIP somewhere. | Archive remains the later ingest contract. |
| **Sentry SaaS (later)** | Mature grouping, issues, tags, event IDs, roles, and retention controls; contexts are not fully searchable. | Attachments consume quota; DSN is not submitter authentication; needs local and server scrubbing/rate limits. | Normal caching transport was not tested here; a relay still needs pending/retry UX. | Straightforward normalized event + ZIP attachment after validator exists. |
| **Minimal custom collector** | Must own TLS, deployment, schema migration, storage, deletion, indexing, observability, and incident response. | Maximum control, but every byte and abuse case becomes project responsibility. | Can accept the archive; must still implement queue/retry/export fallback. | High if it grows into an issue system; low only as a stateless validator/relay. |
| **GlitchTip** | Sentry-compatible, open source, hosted or self-hosted; less project-specific evidence exists for this exact attachment workflow. | Operator controls self-hosted boundary; still needs validation, quotas, and retention. | Same client/relay considerations. | Credible alternative if open/self-hosting is a policy goal, not clearly lower work today. |

The [Sentry pricing page](https://sentry.io/pricing/) checked on 2026-09-16 listed Developer at $0 with one user,
5,000 errors/month, 1 GB attachments, and 30-day lookback; Team at $26/month with 50,000 errors, 1 GB attachments,
unlimited users, and up to 90-day lookback. The [attachment documentation](https://docs.sentry.io/platforms/javascript/enriching-events/attachments/)
states a 20 MB compressed request maximum, 100 MB uncompressed attachments per event, and 30-day attachment
persistence. The proposed 1.312 MiB archive is far below those transport limits but still consumes quota.

[Sentry Stats](https://docs.sentry.io/product/stats/) documents accepted, filtered, rate-limited, quota, spike, and
client/internal drop states. [Issue details](https://docs.sentry.io/product/issues/issue-details/) documents the
difference between searchable tags and contextual data, breadcrumbs, attachments, grouping, and event IDs.
[Organization privacy controls](https://docs.sentry.io/api/organizations/update-an-organization/) expose server
scrubbing, sensitive fields, IP handling, and attachment access; these complement rather than replace local
redaction. Resolve a displayed remote event ID only after server acknowledgement, using the documented
[event-ID lookup](https://docs.sentry.io/api/organizations/resolve-an-event-id/).

The [GlitchTip pricing page](https://glitchtip.com/pricing/) checked the same day listed hosted tiers from a free
1,000 events through $15/month for 100,000 and $50/month for 500,000. Its
[hosted architecture](https://glitchtip.com/documentation/hosted-architecture/) documents US/EU hosting and
90-day event purging; its [installation guide](https://glitchtip.com/documentation/install/) shows the PostgreSQL,
container, upgrades, backups, and retention operations a self-host assumes. Exact attachment compatibility with
this ZIP was not proven, so it is a serious alternative, not a drop-in claim.

For a future Sentry-backed Send, the relay should map closed failure code, stage, game/mod build, API lane, OS
family, and source availability to tags; attach the ZIP; and fingerprint on normalized CouchCoop failure class,
not player prose or a raw address. The local `report_id` remains canonical and is also a tag. Never ship an
organization auth token, management credential, or the game's DSN.

## J. Privacy, redaction, and threat review

Redact before preview, hash, archive, clipboard, or upload. Redaction is idempotent and emits category/count
receipts, never originals.

- Decode under the byte cap with replacement, normalize newlines, strip NUL/control/bidi controls, and record
  invalid UTF-8 replacement.
- Replace authorization, bearer, cookie, password, DSN/API/access/query-token values, credential-shaped
  environment text, and PEM/private-key blocks. Existing Copy-report rules are the minimum, not the whole set.
- Replace home, game, user-data, and cache roots with `<user-home>`, `<game>`, `<user-data>`, and `<cache>`. Exclude
  raw command lines, environment dumps, usernames, hostnames, machine/hardware IDs, Steam IDs, browser storage,
  Workshop paths, and subscription history.
- Represent a network address only as family (`ipv4`/`ipv6`/`unknown`), scope
  (`loopback`/`private_lan`/`link_local`/`public_or_other`/`unknown`), and a report-local relation/alias. Preserve
  same-host/same-subnet relationships when diagnostically necessary. Do not hash private IPs: their low entropy
  makes stable hashes linkable and reversible. Do not record a public IP.
- Treat user description, logs, mod metadata, browser detail, and remote error text as hostile. Cap bytes before
  regex/parse, JSON-escape, render as literal text only, and never use them in filenames, shell commands, URLs,
  issue titles, search expressions, or grouping keys.
- ZIP names are fixed and unique; reject symlinks, absolute/parent paths, duplicates, unknown entries, oversized
  lengths, invalid hashes, and decompression beyond the manifest bounds. A future receiver repeats all validation
  instead of trusting the client.
- The LAN browser cannot trigger collection or select arbitrary files. Snapshot nonce, IDs, slot, and generation
  fence each seat/browser receipt. Replay, mismatch, late arrival, and over-cap data become explicit unavailable
  reasons.
- Local reports are private user data. Provide delete controls, enforce 3/7-day/4-MiB cleanup, and publish the
  future receiver's operator, region, retention, deletion channel, subprocessors, and access policy before Send.

Required redaction fixtures cover credentials in mixed case, home paths on all three platforms, encoded and
duplicate query tokens, IPv4/IPv6/topology relationships, malicious Markdown/HTML/terminal/control/bidi text,
oversized logs, invalid UTF-8, duplicate ZIP entries, traversal names, compression bombs, and conflicting
checksums. Tests assert both removed secrets and preserved diagnostic structure.

## K. Implementation impact and proposed interfaces

No production interface changes are made by this investigation. A future implementation should introduce these
boundaries rather than expanding the Copy formatter into a service client:

| Owner | Proposed responsibility |
| --- | --- |
| CouchCoop mod | `AttemptEvidenceSnapshot`, terminal snapshot store, `ReportSnapshot`, collector/redactor, manifest/ZIP writer, native preview/export UI, optional delivery adapter. |
| Host registry | Freeze existing IDs/facts/timeline/arrivals; preserve retained-issue compatibility; expose closed reason codes. |
| Headless control | New authenticated `diagnostics-request`/`diagnostics-response`, bound to session, client, attempt, slot, generation, nonce, deadline, and caps. |
| Browser protocol | Bounded ring plus nonce-bound `diagnostics-response` over the established relevant WebSocket; no browser-initiated report. |
| spirectl | Read-only loaded-mod diagnostics snapshot preserving runtime `load_index` and path-free `source_class` in host and seat. |
| Future relay | Validate schema/ZIP/redaction receipts/caps, rate limit, retain/delete, and optionally create a normalized Sentry event. |
| Bootstrap loader | Boot ledger writer, link-compiled like `CouchCoopLogLine` (§N.1); refusal codes; the `running` seal. |
| Mod startup | Phase records and risk-window markers, the `ready`/`clean` seals, next-launch sealing, per-phase guarding, safe mode (§N.2, §N.3, §N.6). |
| Degraded host surface | Patch-independent notice and report route when the lobby button is absent (§N.5). |

No collector, redactor, manifest or ZIP type may name a Godot type (§N.7): path resolution is injected, so the
same sources compile into a BCL-only sidecar for a game that will not start, and the whole collector is testable
off-engine.

Collection must not use spirectl semantic actions; it is read-only. It must not block gameplay or shutdown beyond
the local terminal-snapshot boundary. All disk paths are beneath new dedicated user-data roots, and all writes are
temp-file plus atomic rename. The current text Copy report remains available as the lowest-friction fallback.

Expected focused validation when implemented:

- connection registry/arrival/formatter suites, plus terminal-freeze and same-slot retry tests;
- platform path-policy tests and a Linux live failed-seat-to-retry leg under the required leases;
- mock seat/browser boundary tests for wrong generation, nonce replay, timeout, disconnect, and never-reached;
- spirectl host/seat loaded-mod fixtures proving actual process membership and order;
- deterministic manifest/ZIP/checksum/golden tests and the full redaction fixture matrix;
- optional delivery tests with a local/no-op transport, bounded retry/flush/dispose, and zero external network;
- Windows/macOS CI for paths and serialization, followed by honest platform live verification before claiming it.

## L. Phased plan

### Phase 0 — contract and preservation

Implement versioned DTOs, closed reason codes, redactor, caps, deterministic ZIP validator tests, and durable
terminal-attempt snapshots. Add the reusable spirectl loaded-mod ordinal/source-class surface. No UI or network.

Preservation is this phase's remit, so the boot ledger (§N.1), the clean-shutdown seal and next-launch sealing
(§N.2), the risk-window markers (§N.3) and per-phase guarding in `Init` (§N.6) belong here too. They are the
cheapest items in this document and they are the only ones that help a user whose game will not start.

Exit gate: same-slot retry tests prove the previous snapshot remains immutable and host teardown/restart can read
it; malicious/oversized/invalid fixtures pass; the Linux live leg is completed under lock. Additionally, a
killed process leaves a ledger whose last record names its phase, and the next launch seals it.

### Phase 1 — preview and local export (recommended v1)

Add host/current/previous-seat collection, browser ring and authenticated enrichment, native description/preview,
Save ZIP, Copy support text, retention/delete, localization, and export-only user documentation. Keep screenshots
out. No backend credentials or endpoint.

Also the surfaces a broken session needs: the patch-independent degraded surface and startup summary line
(§N.5), the last-resort instructions (§N.8), and the off-engine collector constraint (§N.7) — which is a
constraint on how this phase's collector is written, not extra work.

Exit gate: exact preview-to-archive byte identity, offline operation, all unavailable paths, platform tests, and
artifact-policy review. Observe only voluntarily shared real bundles and support friction.

### Phase 2 — optional private Send

Only if Phase 1 support evidence justifies it, select operator/region/retention, perform legal/privacy review,
provision a private Sentry project and narrow validation relay, add explicit Send/retry/receipt, server-side
revalidation, quotas, abuse controls, deletion, and export fallback. Re-evaluate Sentry and GlitchTip pricing and
capabilities then. Do not reuse the game's telemetry.

Exit gate: local synthetic end-to-end tests, hostile upload tests, quota/drop observability, deletion drill, clear
operator notice, and a no-network/offline fallback. Roll out behind an explicit feature decision, not silently.

### Phase 3 — evidence-led refinements

Tune fingerprints, caps, and selected fields from support outcomes without changing the versioned privacy
contract. Consider an optional screenshot only if text evidence repeatedly fails and preview/redaction can be
made trustworthy. Accounts, a public portal, and automatic GitHub filing remain out unless a separate product
decision overturns that default.

## M. Genuinely unresolved questions

1. **What are the genuine v107 runtime Sentry binaries and load behavior?** Obtain a separately pinned v0.107.1
   installation, verify its release identity, hash/version its assemblies, and rerun the collecting-transport
   harness without global initialization. The stale corpus and compile/reference package cannot answer this.
2. **What exact file survives a real failed-seat-to-same-slot retry?** Complete the leased Linux experiment and
   capture PID, generation, exit code/timing, paths, rotation/truncation, and Sentry startup/shutdown lines. Then
   repeat the relevant behavior on Windows/macOS before claiming parity. Source review predicts the bounded
   excerpt survives and the normal current log rotates, but the live-QA lease prevented proof here.
3. **Who operates a future Send destination and what deletion promise is support willing to publish?** That
   decision determines region, retention, access, cost, abuse controls, and whether Sentry or GlitchTip is the
   better inbox. It is intentionally not answered by code.
4. **Can spirectl expose actual loaded order and a safe source class on both API lanes?** Until it does, membership
   is available but order-sensitive inventory must be marked unavailable rather than inferred.
5. **Do real voluntarily exported bundles support the proposed caps and Phase 2 value?** Phase 1 should collect
   aggregate support outcomes manually, not telemetry, before changing sizes or operating a receiver.
6. **Which OS crash records are actually readable by an ordinary Steam player on each platform?** §N.4 assumes
   the Linux kernel ring, Windows WER entries and macOS `.ips` reports are reachable without elevation. That
   is a per-distribution and per-configuration fact (`kernel.dmesg_restrict` alone can close the Linux case),
   and it decides whether native crash attribution is a normal source or a rare bonus. Measure it on real
   installs before designing around it.
7. **What threshold and scope should safe mode use?** §N.6 proposes disabling after N consecutive launches
   with no `ready` seal, phase-granular where the ledger allows. Both N and the granularity are guesses until
   there is a population of real failed starts to calibrate against — and a safe mode that triggers too
   eagerly turns a transient failure into a player who thinks the mod was removed.
8. **Can a browser `/diagnostics` page satisfy §J's threat model?** §N.5 proposes it as the surface that
   survives a mute game UI, restricted to displaying and downloading what the host already generated. §F and
   §J currently state flatly that the LAN browser cannot initiate collection. Reconciling those two is a
   security review, not a UI decision.

## N. Failures before and outside the reporting path

### N.0 Why this is a separate class

Sections A–M assume a live narrator: a host process that reached `Init`, holds a `ConnectionRegistry` in
memory, shows a native panel, and outlives the seat whose failure it is freezing evidence about. Three failure
classes break that assumption, and they are the ones that arrive from users whose machines cannot be
reproduced locally:

1. **The mod prevents the game from starting.** There is no host process, no registry, no panel.
2. **A native crash kills the process before anything reaches disk.** No managed exception exists for a
   `try` to catch, and the log ends mid-line.
3. **The mod loads but the lobby has no Couch Co-op button.** The player sees "the mod does not work" and has
   no route to a report.

A–M are silent on 1 and 3. On 2 they record only the absence (§C: CouchCoop has no owned crash-upload path).
The governing principle for all three inverts §G's collection model: **evidence must be written forward as it
is produced, flushed before the risky call, and readable by a process that is not the game.** Collection after
the fact has no collector here.

Two facts about the existing code anchor everything below. Both were re-read on 2026-09-18.

- **A checkpoint vocabulary already exists and already goes nowhere durable.**
  [`CouchCoopModEntry.cs`](../../src/CouchCoop.Mod.Loader/CouchCoopModEntry.cs) and
  [`CouchCoopMod.cs`](../../src/CouchCoop.Mod/CouchCoopMod.cs) each define a private `Checkpoint()` that
  writes to stderr and to STS2's logger. A Steam-launched game discards stderr, and `godot.log` is buffered.
  The checkpoints emitted today — `loader-entry`, `loader-version`, `loader-payload`, `loader-invoke`,
  `mod-init`, `harmony-probe-enter`, `harmony-probe-complete` — are already the right phase vocabulary; they
  simply do not survive the process that writes them.
- **`user://couch-coop/` is already a cross-process evidence channel.**
  [`CouchCoopUserFile.cs`](../../src/CouchCoop.Mod/Server/CouchCoopUserFile.cs) resolves it, and the seat's
  status record and browser-port file already use it for exactly "the live channel failed, read it off disk"
  (§E's blocked-POST fallback). A boot record is the same pattern applied one process earlier.

### N.1 The boot ledger

Route the existing `Checkpoint()` calls to an append-only record under `user://couch-coop/`, in addition to
stderr and the logger — one file per launch, the last few launches retained under the §E caps. The last line
written is the phase that died. That single change converts "the game does not start" from a black hole into
`died after loader-payload`, and it is the input every other proposal in this section consumes.

**Flush every record.** The volume is a few dozen lines per launch, so there is no cost worth optimizing, and
the rule has to hold without exception: *a diagnostic that is not flushed before the risky call does not
exist.* A buffered record of a native crash is the crash's own missing log with extra steps.

**The loader phase cannot use `CouchCoopUserFile`.** Its `TryResolve` is gated on
`CouchCoopMod.EngineAvailable`, which is latched inside `Init` and therefore false for every checkpoint the
loader emits — and the gate is not paranoia: `ProjectSettings.GlobalizePath` is native interop that segfaults
rather than throwing when no engine is behind it. There is already an engine-free resolution of the game's
user dir, `HeadlessUserDirSeeder.ResolveHostUserDir`, whose platform switch covers `XDG_DATA_HOME` on Linux,
`APPDATA` on Windows and `~/Library/Application Support` on macOS. The ledger writer should reach that switch
rather than grow a second copy of it.

**The writer must be link-compiled into the loader**, the way
[`CouchCoopLogLine.cs`](../../src/CouchCoop.Mod/Session/CouchCoopLogLine.cs) already is (see the linked-file
comment in `CouchCoop.Mod.Loader.csproj`): a lane payload keeps `CouchCoop.Mod.dll` under `lanes/<version>/`,
off every default probing path, so a call from the loader into that assembly fails to bind on exactly the
paths — lane refusal, bootstrap failure — whose only job is to say why the mod did not load. That inherits
`CouchCoopLogLine`'s two constraints: no reference outside itself, and **no mutable static state**, because a
static in a twice-compiled file is two fields rather than one. Sharing the platform switch therefore means
making the resolution linkable, not calling across the assembly boundary.

**What each ledger carries**, beyond the phase records: the CouchCoop build, the selected lane, the detected
game version, and the mod source (Workshop or `mods/`) — all already available from
`CouchCoopModBuildIdentity` and `CouchCoopLaneSelection`. Lane mismatch and a second installed copy are the
two most common causes of a silently dead mod, and both are already detected today; they are simply detected
somewhere nobody can read afterwards.

### N.2 The clean-shutdown seal, and sealing on the next launch

Three states, written by code that already exists at each point: `running` at loader entry, `ready` when
`CouchCoopMod.Init` returns, `clean` in `CouchCoopMod.Shutdown`. A launch that finds no `clean` seal from the
previous run knows that run crashed, and the ledger tells it where.

**Seal on the next launch rather than running a watchdog process.** The alternative — a sidecar started with
the host that polls its PID and seals on abnormal exit — is the only way to observe an exit code or signal
directly, and the repository already has the two halves it would need (`HeadlessHostWatchdog` does exactly
this poll in the seat→host direction, and `tools/CouchCoop.CacheQuota` shows the BCL-only sidecar build).
Reject it anyway: it spends a process on every launch of a game that is usually not in co-op at all, against
the mod's standing contract that an unused install is indistinguishable from no install — and the exit signal
it would buy is recoverable from the OS instead (N.4).

Sealing copies, before anything can rotate or truncate it, the previous run's `godot.log` (Godot rotates to a
timestamped prior file — §E) plus that run's ledger and any OS crash record, into the §E snapshot store:
**same store, same caps, same redaction, keyed to a process rather than to a join attempt.** Then the lobby
carries one notice offering Save diagnostic ZIP, and §F's bundle contract is unchanged.

### N.3 Risk-window markers, and closing the class instead

Write a paired `begin`/`end` record around every window in which the mod frees or replaces engine-global
state: the FMOD shutdown, Harmony patching, texture eviction, viewport reconfiguration, input-map isolation.
A crash inside such a window is then attributable from the ledger alone.

The FMOD case is the worked example and the reason this is not hypothetical. A seat died with three SIGSEGVs
inside the FMOD GDExtension's shared library at a null base plus a small offset, with nothing in `godot.log`,
because our own `FmodServer.shutdown()` had freed the native system while the Godot object stayed registered
and valid — so a third-party mod's defensive wrapper passed every guard it could write and then dereferenced
freed memory. Reaching that answer cost a kernel-log read and a decompile of the other mod. A paired marker
would have said `died inside fmod-shutdown` on the first user report.

Two doctrines follow, and belong in the implementation brief rather than only here:

- **Any engine global the mod mutates is a global another mod may hold a reference to, and no guard that mod
  can write will save it.** The fix therefore cannot be a longer list of known callers. Keep a short register
  of CouchCoop's engine-global mutations — singletons, autoloads, input maps, project settings — because that
  register is the list of future crashes of this exact shape.
- **Triage a reported crash first for "can this class be closed?"**
  [`FmodSingletonStub.cs`](../../src/CouchCoop.Mod/Session/FmodSingletonStub.cs) is the model: it re-points
  the singleton name at a no-op stub so the doorway is harmless for callers we will never see. Reporting
  infrastructure exists for the crashes that cannot be designed away, and it is worth saying so in a document
  that is otherwise entirely about reporting.

### N.4 Harvest what the OS recorded; do not install a signal handler

A process that dies in native code cannot describe its own death, but the operating system already wrote it
down. The collector should read, bounded and redacted:

| Platform | Record | What it gives |
| --- | --- | --- |
| Linux | kernel ring / journald segfault lines; core-dump metadata | Faulting shared library and offset — the evidence that solved the FMOD case |
| Windows | Windows Error Reporting entries in the application event log; optional per-executable `LocalDumps` | Faulting module, exception code, offset |
| macOS | `~/Library/Logs/DiagnosticReports/*.ips` | Faulting binary, thread, and signal |

Availability is not guaranteed — `kernel.dmesg_restrict` can close the Linux ring to an unprivileged reader,
and none of the three is present on every configuration — so this is an evidence source with its own
`unavailable` reason (`os_crash_record_unreadable`), never a required one. These records also carry full
filesystem paths and complete loaded-module lists, so §J redaction applies to them in full and nothing here
weakens the "omit raw paths, usernames, hostnames, machine IDs" rule.

**Do not install a `SIGSEGV` handler.** It is the obvious answer and it is wrong here: the CLR, Godot and the
game's own crashpad each own part of that territory, and the repository already documents what happens when
that arrangement is disturbed — [`scripts/disable-sentry-crashpad.sh`](../../scripts/disable-sentry-crashpad.sh)
exists because the shipped crash handler escalated a benign, survivable signal into a process kill on a
scripted run. A mod adding a fourth participant to the same chain risks converting recoverable faults into
crashes in order to report crashes. Read the OS's record afterwards instead.

### N.5 The report UI is behind the thing whose absence is being reported

This is the finding for case 3, and §H currently contradicts it.

`CouchCoopPatchHealth` already raises a single `host-patch-failed` row, and its own remarks already name the
symptom ("no QR button in the lobby"). But that row renders in `CouchCoopConnectionPanel`, which is a field of
[`CouchCoopQrDialog.cs`](../../src/CouchCoop.Mod/HostUi/CouchCoopQrDialog.cs), which opens only from
`CouchCoopQrHostPanel` — a panel mounted by `LobbyScreenMountPatch`, that is, by the very patching that
failed. The panel's controller hotkey is not an escape either: it is bound by the panel *while mounted*
(`CouchCoopQrHostPanel.BindHotkey`), so it dies with the panel. The most common cause of a missing button
therefore also removes every route to the report about it —
[`CouchCoopMod.cs`](../../src/CouchCoop.Mod/CouchCoopMod.cs)'s own `EnsureMonoModCanPatch` comment already
spells out that one failed native precondition costs the lobby its button for the whole session.

Break the circularity with a ladder, most robust first. Implement 1 and 2; treat 3 as a decision, not a
default.

1. **A degraded-state surface that depends on no patch.** A `CanvasLayer` added during `Init`, visible only
   when something is wrong, carrying the reason and the route to a report. `Init` already holds both facts it
   needs — `CouchCoopPatchHealth` and the `_hostUiStartupFailure` snapshot — and adding a layer to the scene
   root needs no Harmony. Recommended as the primary fix. Invisible while healthy, so it does not breach the
   idle-cost contract.
2. **A greppable one-line startup summary** written to `godot.log` at the end of `Init`: build, lane, game
   version, patch health, browser port, whether the lobby surface mounted. One line support can ask a player
   to paste verbatim, at near-zero cost, and the line support would have to reconstruct by hand otherwise.
3. **The browser server as a report surface.** `StartHostUiServices` runs independently of Harmony, so a
   `/diagnostics` route reaches the player's phone even when the game UI is mute — which is precisely the
   population this case describes. It must be weighed against §F and §J's "the LAN browser cannot trigger
   collection" boundary rather than quietly crossing it. The compromise that preserves the threat model: the
   page **displays and downloads what the host has already generated**, selects no files, requests no new
   collection, and sits behind the existing LAN-boundary, quota and confinement work. Whether that is
   sufficient is a genuine open question (§M).
4. **The file on disk** (N.1), when the server did not come up either.

### N.6 Recovery, not only reporting

For case 1, a report is second prize; a game that starts is first. Three measures, in increasing cost:

- **Guard each phase of `Init` individually.** Today a throw from any `Apply()` unwinds to the loader's
  blanket `catch`, which logs and returns — leaving a mod that does nothing at all. Several call sites already
  degrade individually and report through `CouchCoopPatchHealth`; extending that to the whole sequence turns a
  broad class of managed startup failures into "one named hook missing" instead of "no mod".
- **A safe-mode ladder.** After N consecutive launches with no `ready` seal, the next launch skips patches,
  prerender and the browser server, boots only the degraded surface from N.5, and says why. Because the ledger
  names the phase that died, a phase-granular skip list is achievable rather than an all-or-nothing switch —
  `Init` is already a linear sequence of `Apply()` calls. The precedent for refusing early is already in the
  loader: `CouchCoopLaneSelection` refuses a mismatched lane **before loading anything**, on the reasoning
  that a lane built for another build loads fine and then throws from inside a game callback where nothing
  names CouchCoop as the cause.
- **A wider loader refusal vocabulary**, each refusal with a stable code in the ledger: a game build above
  every shipped lane, a second installed copy of CouchCoop (already detected by
  `CouchCoopLaneSelection.DescribeLoadedCopyConflict`), an unsupported platform. A refusal leaves a playable
  game and a named cause. A crash leaves neither.

### N.7 The collector must run without the game

A design constraint for §K, and the one that makes case 1 reportable at all: **no collector, redactor,
manifest or ZIP type may name a Godot type.** Path resolution is injected rather than looked up. Two things
follow. The same sources compile into a BCL-only sidecar exactly as
[`tools/CouchCoop.CacheQuota`](../../tools/CouchCoop.CacheQuota/CouchCoop.CacheQuota.csproj) already does with
the mod's quota policy, so a player whose game will not start can still produce the bundle; and the whole
collector is testable off-engine, which is not a preference here — a managed call into GodotSharp with no
engine behind it segfaults rather than throwing, which is the hazard `CouchCoopMod.EngineAvailable` exists for
and which has already cost this repository a test run.

### N.8 Instructions of last resort

When every mechanism above is unavailable, the only channel left is a human reading a path. Two pieces of
prose, no engineering:

- A short `HOW-TO-REPORT.txt` written into `user://couch-coop/` on every launch, naming the two or three
  files to attach.
- Support text in [`workshop/description.en.md`](../../workshop/description.en.md), which today is fifteen
  lines ending in a bare repository link. The per-platform path prose it needs is already written in
  [`docs/save-recovery.md`](../save-recovery.md) and should be reused rather than rewritten.

### N.9 Decisions

| Decision | Recommendation |
| --- | --- |
| Boot ledger under `user://couch-coop/` | Yes. It is the primitive the rest of this section consumes. |
| Flush every ledger record to disk | Yes. An unflushed record of a native crash does not exist. |
| Paired risk-window markers | Yes, around every mutation of engine-global state. |
| Clean-shutdown seal | Yes — `running` / `ready` / `clean`, written where the code already runs. |
| Seal a crashed run on the next launch | Yes. Reuses the §E store, keyed to a process. |
| Sidecar watchdog process | No. A process per launch against the idle-cost contract; the OS already has the exit. |
| Read OS crash records | Yes, bounded and redacted, as an optional source with its own unavailable reason. |
| Install a `SIGSEGV` handler | No. Four participants in one signal chain; the crashpad precedent is in this repo. |
| Patch-independent degraded surface | Yes. The primary fix for a missing button; invisible while healthy. |
| Greppable startup summary line | Yes. |
| Browser `/diagnostics` page | Yes, display-and-download only, inside the existing LAN boundary — subject to §M. |
| Per-phase guarding in `Init` | Yes. |
| Safe mode after repeated failed starts | Yes, phase-granular, driven by the ledger. |
| Wider loader refusal vocabulary | Yes. A named refusal beats an unexplained crash. |
| Collector free of Godot types | Yes, as a hard constraint — it is what makes case 1 reportable and the code testable. |
