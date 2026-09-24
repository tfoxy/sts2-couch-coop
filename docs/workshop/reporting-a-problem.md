# Workshop post — "Having a problem? Post it here"

The notes behind the general bug-report post for the Steam Workshop discussion board. The post itself is
under `workshop/discussions/` — see [The post](#the-post). **It is not published from this repo** — paste
it into a discussion by hand. Discussion title: **Having a problem? Post it here**. Index and house rules:
[README.md](README.md).

## Why it exists, and why it is separate

[phone-connection-troubleshooting.md](phone-connection-troubleshooting.md) is specifically "my phone
cannot reach the join page", already long, and ordered by *connection* causes. Two things it cannot do:

- Take a report that is not a connection problem at all — a crash, a rendering fault, a run that breaks.
  The failure that prompted this post was a player's seat joining the host's lobby and then going silent,
  which is neither a network nor a firewall problem and matches nothing in that post.
- Absorb detail. A reply in a chat or a comment is capped short; a discussion thread is not, so the
  in-channel reply can stay two lines and point here for the evidence.

## Why it is shaped this way

- **The first two items are ranked, the rest are optional.** What happened, and the copyable report,
  are worth more than everything below them, so the post says so rather than presenting a flat form
  nobody finishes.
- **The connection report is conditional.** The `Connections` panel is reached from the lobby's
  **Couch Co-Op QR Code** screen, so a player whose problem happens mid-run may not be able to open it
  at all. Asking everyone for it produces confused reports from the people it does not apply to, so the
  step opens by telling them when to skip it.
- **It asks for the per-player (seat) log.** Each joining player runs as its own game process on the
  host, with its own log, and a join that fails after the lobby is reached leaves its explanation
  *there* — usually not in the host's `godot.log`. This is the file the phone post was missing.
- **It names what a log contains before asking for one.** The board is public; see the table below.
  The default it offers is the `[couchcoop]` and `[ERROR]` lines, not the whole file.
- **It asks which other mods are installed.** Each seat loads the same mod set as the host
  (`SeatCloudSaveIsolationPatch` records why a Steam-less seat is not an option), so another mod can
  stop a player from finishing a join while the host's own game looks perfectly healthy. Players have
  no reason to guess that on their own.
- **Singular voice**, per the house rules.

## What has been checked against the shipped build

Checked on Linux at `ab5f92dd`. A claim belongs in this table only once something in the tree has been
cited for it.

| the post says | the build says |
| --- | --- |
| the panel is **Connections**, on the **Couch Co-Op QR Code** screen | `couchcoop_connection_title` = "Connections"; `couchcoop_qr_button` = "Couch Co-Op QR Code" |
| failures sit under **Connection problems (n)** | `couchcoop_connection_problems` = "Connection problems ({count})" |
| the button is **Copy report** | `couchcoop_connection_copy_report` = "Copy report" — *not* "Copy" |
| the report **names both log paths** | `CaptureConnectionLogsLocked(slot, hostLog, seatLogPath)` attaches the host log and the seat log to the connection record the report is built from |
| players are numbered **from 2** | `HeadlessClientManager.MinSlot` is 2, so the first joiner is slot 2 |
| per-player log at `couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log` | `HeadlessUserDirSeeder.SlotBase` is `<userDir>/couch-coop/headless-slots/slot-N`; `SlotUserDir` appends `SlayTheSpire2` again (`Library/Application Support/SlayTheSpire2` on macOS); the seat is launched with `<SlotUserDir>/logs/godot.log`. **Confirmed on this Linux install**, doubled directory name included |
| the `couch-coop/seat-logs/slot-N.log` fallback | `HeadlessClientManager.SeatLogPath`, used when per-slot isolation could not be prepared |
| log lines look like `[INFO] [couchcoop] …` | `CouchCoopLogLine.Format` prepends `[couchcoop]` to the *message*; Godot's logger prepends the severity, so `[couchcoop]` is never first on the line |
| a log carries a **SteamID64 and the OS user name**, no passwords, no other player's account | Swept the host log and all seven per-slot seat logs on this machine: one unique SteamID64 (the host's own, up to 144 occurrences, in `user://steam/<id>/…`), OS user name in file paths, LAN/VPN-range IPs only. The single `token` match is `PublicKeyToken=null`, a .NET artifact; the heartbeat's per-attempt token is never logged |
| starting a player's game **can take up to a minute** | `DefaultSeatReadyTimeoutSeconds` = 75.0, and a seat's first contact was measured at 4.1 s idle / 9.9 s with every core busy |
| each seat loads the **same mods as the host** | `SeatCloudSaveIsolationPatch` records that Workshop mod discovery sits behind Steam initialization, so a seat cannot be launched Steam-less without loading a different mod set — which is why seats inherit the host's mods |

**Unconfirmed on real hardware:** the **Windows and macOS** per-player log paths. Both are the same code
path resolved through `APPDATA` and `$HOME/Library/Application Support`, and only the Linux one has been
seen on a real install. The post gives the Linux path in full, describes the other two as the same shape
under their platform's folder, and leads with *the report names the exact path* — which is true
everywhere and is what makes an unconfirmed path survivable.

## The post

The English BBCode that is pasted into Steam is
[`workshop/discussions/english/reporting-a-problem.bbcode`](../../workshop/discussions/english/reporting-a-problem.bbcode).
Each other Steam language has a Markdown translation at `workshop/discussions/<language>/reporting-a-problem.md`,
read on GitHub rather than posted to Steam. [README.md](README.md#translations) covers how they differ from
the English and how to keep them in step.
