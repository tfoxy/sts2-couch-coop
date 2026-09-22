# The physical Windows QA rig (Stage 3)

How to reach a real Windows game host from the Linux dev box, and how to get crash evidence off it. This
is the "Stage 3 on physical Windows" that [windows-connection-fingerprints.md](windows-connection-fingerprints.md)
repeatedly defers work to — it exists now.

**Why it is not the `win11` VM.** That guest has no GPU, so it renders only in a small window on the Basic
Render Driver, and it is not a clean-room host. A physical box gives a real GPU, a real Steam install with
real Workshop subscriptions, real third-party mods, and real DHCP — which is where the interesting failures
actually live.

**The rig's identity is local state and is deliberately not in this file.** Hostname, MAC, addresses and
account live in `.agents/memory/` (git-ignored), and harvested logs/dumps live in `.sts2/research/`. Both
carry full filesystem paths, usernames and loaded-module lists by construction, so the Artifact Policy keeps
them out of the repo. This document is the mechanism; the memory entry tells you which box.

## 1. Windows has no kernel log for a user-mode crash

Say this out loud because the instinct is to go looking for `dmesg`. There is no kernel ring for this, and
the `System` event log will not contain it. The real equivalents of the Linux
`segfault … in <module>` line — same information, faulting module plus offset — are these, and **all of
them are retroactive**, so they already hold a crash that happened before you had any access to the box:

| Source | What it gives |
| --- | --- |
| `%ProgramData%\Microsoft\Windows\WER\ReportArchive\` and `ReportQueue\` → `Report.wer` | Exception code, faulting module + version + offset, loaded-module list |
| Application event log **ID 1000** (Application Error) | Faulting app, faulting module, exception code, fault offset |
| Application event log **ID 1026** (.NET Runtime) | **An unhandled managed exception's type and full managed stack** |
| Application event log ID 1001 | The WER bucket summary for the above |
| `Win32_ReliabilityRecords` | A cheap index of recent app crashes (needs the RACAgent task to have run) |
| `%LOCALAPPDATA%\CrashDumps\<exe>.<pid>.dmp` | A real dump — but only if WER `LocalDumps` is armed |

### Event 1026 is the prize, and event 1000 lies to you

For a **managed** crash — which is what the game mostly produces — event 1000 reports the faulting module
as `coreclr.dll` with exception code `0xc0000005` at a fault offset that is **the same for every unrelated
managed crash on that build**, because it is just coreclr's unhandled-exception path. Two crashes with
completely different causes share it exactly.

So: **never distinguish two managed crashes by event 1000's module or offset.** Only event 1026's stack
separates them. This is the same shared-signature trap recorded for the FMOD `+0x50` faults in
`.agents/memory/issue3-fmod-exit-crash-triage-sep21.md`, and it will mis-attribute a bug in one read.

The upside is large: on Windows a managed crash yields a **full managed stack with no dump and no
symbols**, which is strictly more than the Linux side has ever produced for the same class — there, the
signal-handler chain is broken and a managed NRE dies with only a kernel-log line
(`.agents/memory/sts2-crash-debugging-technique.md`).

### The cheapest test needs none of the above

`HeadlessClientManager` logs `headless exited early slot=N exitCode=X` into the **host's** log. On Windows
an access violation is exit code `-1073741819` (`0xC0000005`); a managed unhandled exception is
`0xE0434352`. That one line answers "was it a segfault" before you touch Windows tooling. Note it only
covers a seat that died inside its launch window — a seat that dies later leaves no such line.

### Whether WER even sees it

The game ships `crashpad_handler.exe`, and its native crash hooks are process-wide. If crashpad claims the
fault, **WER has nothing** and the dump is in the game's own Sentry/crashpad database instead — for a seat,
under that seat's isolated user dir. So collect both and let the evidence say which fired; an empty WER
section means something different depending on whether crashpad is present. The bootstrap script does this
and surfaces `crashpad : PRESENT/absent` in its verdict for exactly this reason.

## 2. Log paths on Windows — confirmed on real hardware

Previously only inferred, and one of them was marked unconfirmed in the player-facing post:

| What | Path |
| --- | --- |
| User data root | `%APPDATA%\SlayTheSpire2\` |
| Host log (+ rotated siblings) | `%APPDATA%\SlayTheSpire2\logs\godot.log`, `godot<timestamp>.log` |
| **Per-player (seat) log** | `%APPDATA%\SlayTheSpire2\couch-coop\headless-slots\slot-<N>\SlayTheSpire2\logs\godot.log` |
| Seat log, no-isolation fallback | `%APPDATA%\SlayTheSpire2\couch-coop\seat-logs\slot-<N>.log` |

`SlayTheSpire2` really does appear twice in the seat path — `HeadlessUserDirSeeder.SlotBase` plus
`SlotUserDir`. Players are numbered from 2.

**Rotation is the reason this is time-critical.** Godot keeps about five logs per directory, so every
further seat launch pushes an older session out; on the no-isolation fallback path, reuse *truncates*
instead of rotating. Harvest before letting anyone start more browser players.

A useful tell when picking the crashed process's log out of several: a clean exit ends in
`Steamworks shutdown succeeded!`. A log that simply **stops mid-sentence** is the one that died.

## 3. The control channel

OpenSSH Server, key-only from the Linux box, scoped to the LAN.

- **Install**: `Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0`. If the capability store
  refuses (metered or WSUS-managed), fall back to the Win32-OpenSSH release zip plus its `install-sshd.ps1`.
- **`sshd` startup type is a security decision, not a default to set and forget.** A fresh install is left
  `Manual` on some boxes, so an always-available channel needs `Automatic` — but on a personal machine
  `Manual` is the safer posture, because the service is then off after every reboot and the exposure window
  is only when the owner deliberately starts it. Check with `sc qc sshd`
  (`2 AUTO_START` vs `3 DEMAND_START`), and **record which one this rig is on**, because on a `Manual` box a
  failed connection after a reboot is expected rather than a fault. Ask the owner before changing it.
- **Prefer key-only over an always-on service.** The stock Windows OpenSSH config enables
  `PasswordAuthentication`, so the account is open to password guessing from anywhere the firewall rule
  allows, with no rate limiting. `PasswordAuthentication no` + `KbdInteractiveAuthentication no` removes
  that entirely and is worth more than any startup-type choice.
  **Insert those before the first `Match` line** — Windows OpenSSH ships a `Match Group administrators`
  block at the end of `sshd_config`, and appending there scopes the directives to admins only while looking
  like it worked. Then **`sshd -t` before restarting**: a malformed config means sshd never comes back, and
  on a remote box that costs a console trip. Confirm on the wire afterwards — a correct result offers
  `publickey` alone.
- **Authorize the key in the right file.** For an **admin** account sshd ignores `~\.ssh\authorized_keys`
  entirely and reads only `%ProgramData%\ssh\administrators_authorized_keys`, and it refuses that file if
  its ACL is too open:
  `icacls <file> /inheritance:r /grant "Administrators:F" "SYSTEM:F"`. Writing only the per-user file is
  the single most common reason key auth "silently does not work" here.
- **Firewall**: one inbound Allow rule, TCP/22, `-RemoteAddress LocalSubnet`. The `win11` guest uses `Any`
  because it is NAT-only; a physical laptop on a real LAN should not. Note the **OpenSSH capability installs
  its own `OpenSSH SSH Server (sshd)` rule scoped `Any`**, so if the owner installed the feature themselves
  there is already a wide-open rule and your narrow one is not the only one in play — check for both.
- Reuse the existing `couchcoop-qa` key rather than minting another. Its private half lives in `~/.ssh` —
  **never a scratchpad**, which is exactly how access to the VM was lost once already.

### Addressing: assume the address drifts

It does. The rig this was written for moved between two addresses inside a month on the same MAC, and the
old lease was still sitting in the neighbour table looking equally plausible. So do not pin an IP in
`~/.ssh/config`; resolve per connect with [`scripts/windows/win-host-addr.sh`](../../scripts/windows/win-host-addr.sh):

```
Host win-home
    User <account>
    IdentityFile ~/.ssh/couchcoop-qa
    IdentitiesOnly yes
    ProxyCommand ~/.ssh/win-host-addr.sh --nc %p
```

`sh` expands the leading `~` in a `ProxyCommand`, so put a small shim in `~/.ssh/` that exports the rig's
identity (`COUCHCOOP_WIN_HOST_NAME`, `COUCHCOOP_WIN_HOST_MAC`) and `exec`s the committed script. Keeping the
identity in the shim is what lets the script itself stay free of personal data.

Two things the resolver knows that are easy to get wrong:

- `nmblookup <name>` **without `-R`**. NetBIOS broadcast works against a stock Windows box; `-R` asks a WINS
  server instead and returns nothing at all on a home LAN, which reads as "host is down".
- For the MAC fallback, **do not filter the neighbour table to `REACHABLE`**. A live host normally sits at
  `STALE` or `DELAY`; `REACHABLE` holds only momentarily after traffic, so that filter rejects the host
  nearly every time — while the stale entry it was meant to exclude looks identical. The table cannot say
  which address is current, so the script probes each candidate on the port you actually want and takes the
  one that answers.

A DHCP reservation on the router is worth adding as belt-and-braces, but the resolver means you do not
depend on it.

## 4. Harvesting: `scripts/windows/couchcoop-qa-bootstrap.ps1`

One script, **evidence first** — the whole harvest completes and the ZIP is written before anything is
installed or changed, so a failure in the setup half cannot cost you the crash you are chasing. It is
PowerShell 5.1 / .NET Framework compatible on purpose: that is what Windows 10 ships, and .NET-Core-only
overloads are a documented trap on these rigs.

```
ssh win-home 'powershell -NoProfile -ExecutionPolicy Bypass -File couchcoop-qa-bootstrap.ps1 \
    -SkipSsh -DumpType 2 -CrashWindowHours 336'
scp win-home:AppData/Local/Temp/couchcoop-evidence-<host>-<stamp>.zip <scratchpad>/
```

It collects host logs + rotated siblings, every per-slot seat log and the fallback, matching WER reports,
events 1000/1001/1026 as both text and `.evtx`, reliability records, crashpad/Sentry dumps and
`%LOCALAPPDATA%\CrashDumps`, plus identity (mod build/lane/cache root, Steam buildid and branch, loaded
mods, Windows build, crashpad presence). Then it prints a verdict block and scans the host log for seat
exit codes, so §1's cheap test is answered from the console alone.

`-DumpType 2` arms WER `LocalDumps` for `SlayTheSpire2.exe` so the **next** crash leaves a full dump
(managed stacks recoverable; roughly 1–3 GB each, `DumpCount` kept). Seats are the same executable, so they
are covered too. `-Revert` removes the registry key, the firewall rule and the authorized key line.

Two details worth knowing before you read its output:

- It reads locked files deliberately (`FileShare.ReadWrite|Delete`). The game is usually **live** while you
  harvest, so it holds `godot.log` open and a plain copy would fail on the one file you most want.
- `Get-WinEvent -FilterHashtable` **throws** on a zero-match filter instead of returning an empty set.
  Reporting that as a failure would claim the query broke when the truth is "this box recorded no crash in
  the window" — the script separates the two, and so should anything else that queries the event log.

### Getting the bundle off when you cannot reach in

Inbound to Windows is blocked by default and outbound is not, so when SSH is not up yet, have Windows push.
Run [`scripts/windows/recv-evidence.py`](../../scripts/windows/recv-evidence.py) on the Linux side (bind
address and port are required arguments, no defaults) and one line on Windows:

```
Invoke-WebRequest -Uri http://<linux-host>:<port>/evidence.zip -Method Put -InFile <zip> -UseBasicParsing
```

## 5. Analysing a dump

**On Windows, not here.** `dotnet-dump analyze` needs a platform-matched DAC, so a Windows minidump will not
open under a Linux `dotnet-dump` even though the tool exists on both. Install the tool on the box over SSH,
run `clrstack -all` there, and copy the *text* back.

Usually you do not need to: for a managed crash, event 1026 already gave you the stack.

## 6. What this rig has already settled

- A browser player's headless seat can be killed at run start by the game's **Ancient event visual
  instantiation** — the Neow event uses that layout, which is why it presents as "crashes when the run
  starts". spirectl already diagnosed and guarded this crash, but its guard sits under `BridgeOnly/` and is
  installed only by the bridge runtime, so CouchCoop's seats never get it. Full stack, build identity, the
  loaded third-party mods and the open questions are in
  `.sts2/research/windows-seat-neow-crash-20260922/results.md`.
- The Windows log paths in §2, including the per-slot seat path, are now confirmed on real hardware rather
  than inferred.
