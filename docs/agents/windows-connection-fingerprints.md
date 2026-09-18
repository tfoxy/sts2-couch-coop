# Windows connection fingerprints (Stage 2)

What a deliberately broken join looks like on Windows, measured rather than assumed. Companion to
[local-network-access.md](local-network-access.md) and to the player-facing
[phone-connection-troubleshooting.md](../workshop/phone-connection-troubleshooting.md).

Measured 2026-09-17 on the libvirt `win11` guest — **Windows 11 Pro, build 10.0.26200.0**, 8 GB, two NICs
(macvtap `192.168.0.7` on the real LAN, NAT `192.168.122.32` for host access). Rig details and the reason
for two NICs: `.agents/memory/windows-vm-qa-rig-sep16.md`.

## 1. The headline result: loopback refusal latency

**A closed loopback port is refused ~2 seconds later on Windows than on Linux**, and the mod's probe
budget used to sit between the two.

| platform | closed loopback port → answer | open port |
| --- | --- | --- |
| Windows 11 (26200) | `ConnectionRefused` after **2008, 2023, 2027, 2032, 2034 ms** | `Accepted` in 0 ms |
| Linux (this host) | `ConnectionRefused` after **0.02-0.09 ms** | `Accepted` in 0 ms |

Five samples each, fresh ports, no listener. The instrument was validated first against a port with a
real listener and a port known closed — an earlier probe reported `MethodException` for *everything*
because PowerShell 5.1 runs .NET Framework and has no
`Socket.ConnectAsync(IPEndPoint, CancellationToken)` overload. **Validate the probe on a known-open and a
known-closed control before believing any latency number from it.**

Consequence, and the bug it caused: `SeatPortAvailability.ProbeTimeout` was 250 ms, so on Windows a
refusal was never observed. A refusal not seen becomes `SeatPortReachability.Unreachable`, documented as
"this machine dropped its own packet", which `SeatReadinessVerdict.Classify` turns into `HostLocalBlock`
— *"Allow Slay the Spire 2 through this computer's firewall or security software."* A seat whose listener
was simply gone therefore produced a firewall accusation on Windows and an honest "still starting" on
Linux. Fixed in `22478308` by splitting the budget: the survey keeps 250 ms (it only asks whether
anything *answers*, and an accept is immediate everywhere), and the classifier gets
`ClassificationProbeTimeout` = 5 s on its failure path only.

## 2. A8 — OS port reservations. Falsified as specified.

The design doc listed A8 as "dynamic port reservation → host port-walks", and this round was asked
whether `HeadlessSeatPortGuard`'s no-walk rule turned it into a regression. **It does not, on two
independent grounds.**

| leg | result |
| --- | --- |
| `netsh int ipv4 add excludedportrange protocol=tcp startport=13357 numberofports=1`, then bind 13357 | **bind OK** — on `0.0.0.0` *and* on `127.0.0.1` |
| same, with the exclusion table printed while in force | table showed `13357 13357 *`, so the reservation was genuinely applied |
| control: reserve **50000**, inside the dynamic range, then bind it explicitly | **bind OK** — before, during and after the reservation |
| `netsh int ipv4 show dynamicportrange tcp` | start **49152**, 16384 ports |

So an administered `excludedportrange` removes a port from **automatic/ephemeral assignment** only; an
explicit `bind()` to that port still succeeds. Seats and the host always bind explicitly. And the dynamic
range (49152+) does not overlap CouchCoop's map (13337, then 13357/13367/13377…) at all, so the
reservations Hyper-V, WSL and Docker create cannot land on a seat port in the first place.

**The honest residual:** the real-world *"An attempt was made to access a socket in a way forbidden by its
access permissions"* failures people report with Hyper-V come from HNS/WinNAT holding an **active**
reservation, which lists in the same table *without* the `*` and is a different mechanism from the
administered exclusion tested here. Reproducing it needs Hyper-V installed, which the design doc puts out
of scope and this guest cannot nest. Untested, and the one A8 question still open.

## 3. Stock firewall state — why the maintainer has never seen a prompt

Captured before anything was changed:

| profile | Enabled | DefaultInboundAction | AllowInboundRules | NotifyOnListen |
| --- | --- | --- | --- | --- |
| Domain | True | NotConfigured | **True** | **True** |
| Private | True | NotConfigured | **True** | **True** |
| Public | True | NotConfigured | **True** | **True** |

So **A6 and A5 are not silently pre-switched on** — the hypothesis in
`.agents/memory/windows-vm-qa-rig-sep16.md` that a profile-level inbound block explained the filtered
ports is **wrong**. The real reason nothing prompts is simpler: two inbound **Allow** rules for
`SlayTheSpire2.exe` already exist, scoped `Domain, Private, Public`, so the prompt was answered once and
covers every profile. Both adapters are categorised **Private**.

The earlier "every port filtered" observation (22/135/445/3389/5985) is explained without a profile block:
no allow rule existed for those ports and `NotConfigured` inbound defaults to block. sshd was not even
installed.

**This matters for the Workshop post:** on a stock Windows box with the game's own allow rule in place,
the seat ports are already permitted, because the rule is per-**program**, not per-port. That is the
evidence behind the post's "allow the program, not a port" advice — it is correct, and now measured.

## 4. Getting the real game running here, and the two things that nearly stopped it

The **product** fingerprint — what the host's Connections panel and the phone actually render per knob —
was blocked at first: the guest's Steam install was **v0.107.1** (buildid 23811903) against this repo's
**v0.111.0** / lane `v111` (buildid 24724944), and the mod is managed IL built against v0.111.0
assemblies, so deploying onto it invites the `TypeLoadException` in
`.agents/memory/lane-mismatch-flat-deploy-sep15.md`.

**The cause was a branch difference, and a case-sensitive grep hid it.** `v0.111.0` is the
**`public-beta`** branch, not default. The key in `appmanifest_2868840.acf` is spelled **`BetaKey`**, so
a `grep -E "betakey"` finds nothing and both installs read as "default branch" — which is exactly the
wrong conclusion. **Match the branch, not just the version, and grep case-insensitively.** Resolved by
switching the guest to `public-beta`; it is now buildid 24724944 / v0.111.0, matching Linux.

One difference that is expected and harmless: `release_info.json`'s `main_assembly_hash` differs between
the two platforms (Linux 1579942752, Windows 222455745). Nothing in the mod reads that field — lane
selection and the cache root key off the **version** — so it is not a mismatch signal.

A `steam://validate` issued over SSH did not start the update and the client then exited: the branch
change needed someone at the guest console.

### The mod deploys and LOADS on Windows — proven from the log

With the branch matched, the Linux install was tarred across and extracted into the guest's
`mods\couchcoop`. Identity matches on both sides: `sourceCommit 3c689be2`, `dirty false`, lane `v111`,
manifest `9999.0.0+dev.3c689be2fd2a`. The guest's own `godot.log` then proves the load rather than the
copy:

```
[INFO] Loading assembly DLL C:\Program Files (x86)\Steam\steamapps\common\Slay the Spire 2\mods\couchcoop\couchcoop.dll
* CouchCoop [couchcoop] (9999.0.0+dev.3c689be2fd2a)
[INFO] [couchcoop] cache game=v0.111.0 hash=222455745 cache=v1+sp1 root=C:/Users/VM/AppData/Roaming/SlayTheSpire2/couch-coop/cache\v0.111.0
```

**That line settles round item 4 on real Windows**, with the mod running: the user dir is
`%APPDATA%\SlayTheSpire2\`, so `%APPDATA%\SlayTheSpire2\logs\godot.log` is correct, and
`%APPDATA%\Godot\app_userdata\SlayTheSpire2\logs` does **not** exist. It also confirms the `[couchcoop]`
prefix on Windows — the spelling the troubleshooting post had wrong.

Note the guest also loads two unrelated Workshop mods (BaseLib, STS2-RitsuLib), so it is not a clean-room
host; RitsuLib runs its own listener on 127.0.0.1:18742.

### …and the game DOES run — in a small window

> **CORRECTED.** The section below originally concluded "the product fingerprint is not obtainable on
> this VM". **That was wrong, and it was an over-reading of a real error.** The game runs fine here when
> its window is made **small**; the maintainer did so and it has been up for minutes with CouchCoop's
> browser server bound on `0.0.0.0:13337` and serving HTTP 200. The D3D12 failure below is real but is a
> **swap-chain-size** failure at the default window size on the Basic Render Driver, not an inability to
> render at all. The general lesson: *"the renderer logged ERR_CANT_CREATE and the process exited"*
> supports "this configuration failed", never "this machine cannot render" — the second needs a
> configuration sweep, and one smaller window falsified it.

The guest has **no GPU**. Godot picks D3D12 and falls back to the *Microsoft Basic Render Driver*, which
at the default window size cannot create the swap chain:

```
D3D12 12_0 - Forward+ - Using Device #1: Microsoft - Microsoft Basic Render Driver
ERROR: Condition "!((HRESULT)(res) >= 0)" is true. Returning: ERR_CANT_CREATE
   at: swap_chain_resize (drivers/d3d12/rendering_device_driver_d3d12.cpp:2854)
```

repeated until the process exits (`.../shots/01-game-launched.png` — the console, with no game window).
Relaunching through Steam with `--rendering-driver opengl3` produced no log at all: Windows ships no
software OpenGL 3.3 and WARP is D3D-only.

**Make the window small and it runs.** Measured with the game live: pid 8396, 452 s of CPU, CouchCoop's
browser server listening on `0.0.0.0:13337`, serving HTTP 200. So the product fingerprint IS obtainable
here — see §6, which is the measurement it unlocked. Frame rate is poor and irrelevant: every knob in
this stage is about whether a connection is accepted.

GPU passthrough remains refused and remains unnecessary: the RTX 2060 is the host's only GPU and drives
every gamescope QA instance.

## 5. The loopback prediction, CONFIRMED against the live product

The round's second priority: *"Windows Firewall does not filter loopback, so a Windows-blocked seat
should make the host's own probe SUCCEED and classify as `seat-network-path`."* Measured with the game
live and CouchCoop's browser server bound on `0.0.0.0:13337`.

Method: one inbound Block rule, `TCP/13337`, `RemoteAddress 192.168.122.1` (the Linux host, standing in
for the phone). Deliberately peer-scoped and port-scoped — `-s <peer>`-style, the same discipline
`connection-diagnostics-round-sep15` insists on, and it keeps the SSH control channel on tcp/22 alive as
a built-in control.

| probe, while that rule is in force | result |
| --- | --- |
| blocked peer → `http://192.168.122.32:13337/` | **dropped**, 3 × 10 s timeout, no RST |
| SSH tcp/22 from the same peer (control) | **connected** — the rule is scoped, not a blackout |
| host's own `http://127.0.0.1:13337/` | **HTTP 200** |
| host's own raw loopback TCP connect (the shape `SeatPortAvailability` probes with) | **Accepted**, 438 ms |
| host's own `http://192.168.122.32:13337/` — its OWN LAN address | **HTTP 200** |
| rule removed (withdrawal half) | **HTTP 200**, 8/8, connect 2-15 ms |

**Windows does not filter a machine's traffic to itself — not even to its own non-loopback address.** So
every host-side check this verdict makes passes: `ListenerResponding == true`,
`TcpReachability == Accepted`, and no device ever arrives so `SeatViewerArrivals == 0` →
`HostSideIsClear` → **`seat-network-path`**. The prediction holds exactly.

The consequence is the defect: that cause's action told the operator to sort out their Wi-Fi and their
router, when the block was Windows Firewall **on the machine they are sitting at** — and a host-side
block is *indistinguishable* from a router problem by any evidence the host can gather. Fixed by naming
this computer's firewall first in the action (all 14 catalogs) and adding a per-OS English detail that
says plainly that reaching the port from itself does not rule its own firewall out.

**This also reproduces the design doc's central trap**, which it warned about and which is easy to
dismiss: *"a self-test from the host machine passes in precisely the case it exists to catch."* Measured
here — the guest answered its own LAN address with 200 while a real peer got nothing. Never accept a
host-side self-test as evidence that a phone can connect.

### One false alarm worth recording, because it nearly became a finding

An earlier remote GET timed out at 15 s while the listener was already bound, and that was briefly read
as "allowed and still blocked" (knob A2) — the game's two inbound Allow rules are textbook-perfect
(TCP + UDP, Any local port, Any remote address, Any interface, all three profiles, Enabled, and zero
enabled inbound Block rules anywhere). **It was not a block.** It was a cold, CPU-starved browser server:
the first loopback request took 6 566 ms and the second 179 ms, and once warm the same remote GET
returned 200 in 37 ms and then 8/8. A slow host can make a bound, permitted, perfectly healthy port look
firewalled for tens of seconds. Re-test after warm-up before concluding anything from a single timeout —
and note this is the field's "it hangs" symptom with no firewall involved at all.

## 5b. What §3 and §5 turned into: the host asks its own firewall

Sections 3 and 5 together say something stronger than either does alone. The block is *readable locally*
(§3: the permission is carried by per-program inbound allow rules, and the stock inbound default is block),
and it is *unreadable over the network* (§5: every host-side check passes while a real peer gets nothing).
That is exactly the shape of a question a process should ask the OS rather than infer from traffic — so
`src/CouchCoop.Mod/Connections/WindowsFirewallProbe.cs` now does, once, on the failure path, when
`HostReachabilityWatch` has already decided to raise its 90 s row.

| what the query finds | row |
|---|---|
| an enabled inbound **Block** rule naming this exe | `host-firewall-blocked` |
| no enabled inbound **Allow** rule naming it | `host-firewall-blocked` |
| allow rules exist but none covers the profile of any active network | `host-firewall-blocked` |
| allowed and covered | the old `host-no-inbound-connections`, plus a sentence **exonerating** the firewall |
| anything else — no PowerShell, a timeout, an unreadable answer, zero rules, zero programs | the old row, unchanged |

Two design points worth keeping:

- **Every uncertain shape is Unknown**, including the two "empty" ones, because "we looked and found nothing"
  and "we could not look" are the same empty list and only one of them is an accusation. The facts therefore
  carry `inboundRuleCount` and `programRuleCount` purely as *did the query run* signals.
- **The exoneration is worth as much as the accusation.** "This game IS allowed inbound, so this PC's own
  firewall is not what is stopping it" is what moves an operator on to the router, the phone and the
  security suite — the §5 defect was a row that sent them to the router when the answer was on their desk.

### Measured live, 2026-09-18, against the shipped query and classifier

Ran `WindowsFirewallProbe.Query` on the guest (exe
`C:\Program Files (x86)\Steam\steamapps\common\Slay the Spire 2\SlayTheSpire2.exe`), captured its JSON in
four firewall states, and fed each through the real `WindowsFirewallProbe.Parse` + `Classify`. The query's
`inboundRuleCount`/`programRuleCount` came back **268 / 481** — both "did the query work" signals healthy —
and the stock rules matched §3 exactly (two enabled inbound Allow, `Domain, Private, Public`; both networks
`Private`).

| firewall state applied (reverted after each) | query rules | **verdict** |
|---|---|---|
| stock | 2× enabled Allow `Domain,Private,Public` | **Allowed** — "…is not what is stopping the connection…" |
| + an enabled inbound Block rule for the exe | the above + 1 Block `Any` | **BlockRule** — names the rule, points at the old "Cancel" |
| the two Allow rules disabled | 2× Allow `enabled=False` | **NoAllowRule** — "There are 2 rules for it that are switched off" |
| the two Allow rules set Public-only, networks Private | 2× enabled Allow `Public` | **ProfileMismatch** — names both networks and their category |

All four are the verdict the design intends, produced by the shipped code on real Windows. The restore was
verified: after the run the firewall was byte-identical to stock. **The previously-owed leg is done** — the
query, the half that had never run outside a unit test, emits JSON the classifier turns into the right
verdict across every reachable state.

One copy fix fell out of seeing the Allowed sentence on live data: the clause read "for Private, **which is
what** this PC's network … is Private", which is ungrammatical; it is now "for Private, **and** this PC's
network … is Private".

The query was also hardened before this run and it is why the above was survivable to get wrong: the first
draft joined rules to application filters on `InstanceID` (a guess about a WMI class's identity that would
match nothing *silently* — an inert probe), and it now follows the documented association
(`$filter | Get-NetFirewallRule`) after narrowing by file name, with `$ErrorActionPreference = 'Stop'` so any
failure yields no JSON, which is `Unknown`.

## 6. A9b reproduced live, on the platform where it is worst

Unplanned, and visible in the startup log above — the host ranked its two adapters:

```
[couchcoop] lan-address candidate rank=0 192.168.0.7    if=Ethernet   score=55 gw=1 tier=2 range=rfc1918 origin=Dhcp
[couchcoop] lan-address candidate rank=1 192.168.122.32 if=Ethernet 2 score=55 gw=1 tier=2 range=rfc1918 origin=Dhcp
```

**An exact tie at the maximum score**, 32+16+4+2+1 = 55 on both. `LanAddressRanking.Rank` is
`OrderByDescending(ScoreOf)` and LINQ's sort is stable with no further tiebreak, so which address the QR
advertises is decided purely by **OS enumeration order**. Here rank 0 happened to be the LAN address a
phone can reach; nothing made it so.

Worse on Windows than the design doc expected. The doc noted that the DHCP tiebreak is inert off Windows
because `ReadPrefixOrigin` throws on Linux — here it is live, both candidates report `origin=Dhcp`, and it
*still* cannot separate them. This is the A9b shape (host on one subnet, phone on another) with no virtual
adapters contrived: any Windows box with two gateway-carrying Ethernet adapters — Hyper-V's Default
Switch, WSL, a VPN NIC, a second physical port — is one enumeration-order flip away from advertising an
address no phone can reach. The mitigations still stand (the QR dialog lists every adapter group and
`COUCHCOOP_ADVERTISED_HOST` overrides outright), which is exactly why the post leads with "pick a
different row".

Everything in sections 1-3 needed no game, which is what the design doc's Stage 2 fallback anticipated.
Sections marked owed here move to Stage 3 on physical Windows, or back to this guest once the game
matches.

## Control channel

SSH as `VM@192.168.122.32` with the `couchcoop-qa` ed25519 key (`ssh win11-qa` via the `~/.ssh/config`
alias). The default shell is `cmd`, and PowerShell in the guest is **5.1 / .NET Framework** — .NET-Core-only
overloads are not available there, which is what broke the first probe. **There is no QEMU guest agent
installed**, so SSH is the only remote channel: anything that can close port 22 — `AllowInboundRules False`
above all — needs a `schtasks` auto-revert scheduled *before* it is applied, with no fallback but the
console. The SSH allow rules are scoped `Any` (`OpenSSH QA`, `CouchCoopQA-SSH`), so a per-program game block
or a network→Public flip does not touch them.

### Restoring access after the key is lost

The `couchcoop-qa` **private** key lives at `~/.ssh/couchcoop-qa` on the Linux QA host — durable, not a
scratchpad (a scratchpad copy is exactly what was lost on Sep-18, taking access with it). Its **public** half,
which is not a secret, is:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHbi32SCm6pKjBcEb2IoTWMvK34goKMAX6enAxwkET6g couchcoop-qa
```

If the private key is ever lost again, or the guest is rebuilt:

1. `192.168.122.32` is a **static DHCP reservation** for the guest's NAT NIC (`52:54:00:ca:79:41`) in the
   libvirt `default` network — it will not drift. (`virsh net-dumpxml default` shows the `<host>` entry; to
   re-add it: `virsh net-update default add ip-dhcp-host "<host mac='52:54:00:ca:79:41' ip='192.168.122.32'/>" --live --config`.)
2. Regenerate the key into `~/.ssh` (never a scratchpad): `ssh-keygen -t ed25519 -f ~/.ssh/couchcoop-qa -N ""`.
3. Get the new public key into the guest. sshd is installed and running and port 22 is open, so the only
   thing missing is authorization. With no remote channel, hand it in on a **virtual CD**: put an
   `authorize.ps1` (append the pubkey to `%ProgramData%\ssh\administrators_authorized_keys` — the account
   `VM` is an admin, so the per-user file is ignored — then `icacls <file> /inheritance:r /grant
   'Administrators:F' 'SYSTEM:F'`) and a self-elevating `INSTALL.bat` into a dir, `xorriso -as mkisofs -R -J
   -o key.iso <dir>`, `virsh change-media win11 sdb key.iso --insert --live`, and have someone run it once at
   the console (`virsh screenshot win11` confirms the desktop state; the guest is usually left logged in with
   an elevated PowerShell open, in which case `D:\authorize.ps1` is the whole of it). Eject with
   `virsh change-media win11 sdb --eject --live`.

An SSH session for the admin `VM` account can run elevated cmdlets directly (measured — `New-NetFirewallRule`
succeeds), so once in, no scheduled-task dance is needed for firewall work; the auto-revert discipline above
is only for a change that could sever port 22 itself.
