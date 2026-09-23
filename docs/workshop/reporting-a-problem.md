# Workshop post — "Having a problem? Post it here"

The general bug-report post for the Steam Workshop discussion board, kept here so it is maintained with
the code it describes. **It is not published from this repo** — paste it into a discussion by hand.
Suggested title: **Having a problem? Post it here**. Index and house rules: [README.md](README.md).

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

## The post, as Steam BBCode

Replace `PLACEHOLDER_PHONE_URL` with the phone post's live URL from [README.md](README.md).

```
[h1]Having a problem? Post it here[/h1]

This is the place for anything that goes wrong - crashes, a player that never finishes joining, something rendering incorrectly, a run that breaks.

[b]If your phone or tablet can't reach the join page at all[/b], read [url=https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/]Can't connect from a phone?[/url] first - that covers Wi-Fi, firewalls and routers in detail, and most connection problems are solved there.

[hr][/hr]
[h1]What to include[/h1]

No need to answer everything - the first two are worth more than the rest put together.

[h3]1. What happened, and what you expected instead[/h3]
One or two sentences is fine. If there was an error message on screen, quote it exactly, including any smaller grey line underneath it. A photo or screenshot is perfect.

[h3]2. If the trouble is with joining or the lobby: the connection report[/h3]
[i]If your problem happens later - during a run, or in the game itself - skip straight to step 3.[/i]

From the lobby, open the [b]Couch Co-Op QR Code[/b] screen. The [b]Connections[/b] panel is on it, under the code. Anything that went wrong is kept under [b]Connection problems[/b] (with a count after it).

Select the row that failed and press [b]Copy report[/b], then paste it into your post. For a joining problem this is the single most useful thing you can attach: it already contains the failing step, the timings, the host's own diagnosis, and the paths to the log files described below.

[h3]3. The log files[/h3]
There are two kinds, and which one matters depends on the problem.

[b]The main game log[/b], on the host computer:
[list]
[*]Windows: [i]%APPDATA%\SlayTheSpire2\logs\godot.log[/i]
[*]Linux: [i]~/.local/share/SlayTheSpire2/logs/godot.log[/i]
[*]macOS: [i]~/Library/Application Support/SlayTheSpire2/logs/godot.log[/i]
[/list]

[b]The per-player log.[/b] Each player who joins gets their own copy of the game running in the background on the host computer, and each one keeps its own log. [b]If a player got stuck joining, this is the file that explains why[/b] - the main log above usually will not.

Players are numbered from 2, so the first person who joins you is [b]slot-2[/b]. On Linux that player's log is at:

[i]~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log[/i]

(Yes, [i]SlayTheSpire2[/i] really does appear twice - that is not a typo.) On Windows and macOS it is the same shape, under the folder from the list above. On some setups it is a single file at [i]couch-coop/seat-logs/slot-2.log[/i] instead. Either way, [b]the report from step 2 names the exact path[/b], so copying that first saves you hunting.

[b]Which lines matter.[/b] In either file, the useful ones contain [i][couchcoop][/i] - they look like [i][INFO] [couchcoop] ...[/i] - plus any [i][ERROR][/i] lines, even ones that don't mention couchcoop. Those lines are usually enough on their own.

[b]Before you paste a whole log:[/b] this is a public board, and a log contains your own [b]SteamID64[/b] (a long number starting 7656, which points at your Steam profile) and your computer's [b]user name[/b], in file paths. It does [i]not[/i] contain passwords, and it does not contain other players' accounts - only yours. If you would rather not post that, a find-and-replace on those two before pasting is enough, or just post the [i][couchcoop][/i] and [i][ERROR][/i] lines and I'll ask if I need more.

[h3]4. Versions and mods[/h3]
[list]
[*]Whether you are on the [b]stable[/b] or [b]public beta[/b] branch of the game.
[*][b]Which other mods are installed.[/b] Each background player copy loads the same mods as the host, so another mod can stop a player from finishing joining even when the host's own game looks perfectly fine.
[*]Host operating system.
[*]The CouchCoop version, if you know it - otherwise I'll assume the latest.
[/list]

[h3]5. Anything that narrows it down[/h3]
[list]
[*]Does it happen every time, or only sometimes?
[*]Does it happen for every player, or just one?
[*]Did it ever work before, and did anything change since - a game update, a new mod?
[/list]

[hr][/hr]
[h1]One thing worth knowing before you report[/h1]

Starting a player's game can take up to a minute, and on a slower machine it will use most of that. That is normal, not a fault. While it is working, the join page counts up and changes stage underneath [i]Joining...[/i] - if that line is still moving, nothing has gone wrong yet, so keep the page open.
```
