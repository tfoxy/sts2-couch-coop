# Windows connection fingerprints (Stage 2)

What a deliberately broken join looks like on Windows, measured rather than assumed. Companion to
[local-network-access.md](local-network-access.md) and to the player-facing
[phone-connection-troubleshooting.md](../phone-connection-troubleshooting.md).

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

## 4. Not yet measured, and why

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

### …and then the game cannot render, which ends the product half here

The guest has **no GPU**. Godot picks D3D12 and falls back to the *Microsoft Basic Render Driver*, which
cannot create the swap chain:

```
D3D12 12_0 - Forward+ - Using Device #1: Microsoft - Microsoft Basic Render Driver
ERROR: Condition "!((HRESULT)(res) >= 0)" is true. Returning: ERR_CANT_CREATE
   at: swap_chain_resize (drivers/d3d12/rendering_device_driver_d3d12.cpp:2854)
```

repeated until the process exits — the game never reaches a window (`.../shots/01-game-launched.png`
shows the console with no game). Relaunching through Steam with `--rendering-driver opengl3` did not
produce a log at all. Windows ships no software OpenGL 3.3, and WARP is D3D-only.

So **the product fingerprint — what the Connections panel and the phone render per knob — is not
obtainable on this VM**, and that is now a measured fact rather than the prediction in
`windows-connection-fingerprints`' parent memory. GPU passthrough is the only thing that would change it
and is refused for good reason: the RTX 2060 is the host's only GPU and drives every gamescope QA
instance. The product half belongs to Stage 3 on physical Windows.

## 5. A9b reproduced live, on the platform where it is worst

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

SSH as `VM@192.168.122.32` with the `couchcoop-qa` ed25519 key; default shell is `cmd`, and quoting
survives only via `powershell -EncodedCommand` (a `wps` helper doing the UTF-16LE/base64 wrap lives in the
session scratchpad). PowerShell in the guest is **5.1 / .NET Framework** — .NET-Core-only overloads are
not available there, which is what broke the first probe. **There is no QEMU guest agent installed**
(contrary to the earlier round's note), so SSH is the only remote channel: anything that can close port 22
— `AllowInboundRules False` above all — needs a `schtasks` auto-revert scheduled *before* it is applied,
with no fallback but the console.
