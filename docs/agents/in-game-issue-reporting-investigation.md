# In-game issue reporting investigation

Status: design investigation, 2026-09-16. This document specifies a future contract; it does not add reporting
code, provision a service, or authorize telemetry.

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

The native connection panel is the right owner because it already shows live and retained issues and can correlate
host/seat evidence. V1 needs one entry point and two screens:

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

Exit gate: same-slot retry tests prove the previous snapshot remains immutable and host teardown/restart can read
it; malicious/oversized/invalid fixtures pass; the Linux live leg is completed under lock.

### Phase 1 — preview and local export (recommended v1)

Add host/current/previous-seat collection, browser ring and authenticated enrichment, native description/preview,
Save ZIP, Copy support text, retention/delete, localization, and export-only user documentation. Keep screenshots
out. No backend credentials or endpoint.

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
