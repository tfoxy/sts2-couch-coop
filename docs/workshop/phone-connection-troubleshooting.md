# Workshop troubleshooting post — "Can't connect from a phone?"

The support post for the Steam Workshop discussion board, kept here so it is maintained with the code it
describes rather than living only in a chat log. **It is not published from this repo** — the maintainer
pastes it into a discussion by hand. Suggested title: **Can't connect from a phone? Read this first**.

## Why it is shaped this way

- It leads with **switching rows in the QR host selector**, not with the firewall: that is the only fix
  which is one tap, needs no admin rights, and covers a whole class of causes at once.
- The Windows advice says **allow the program, not a port**. Opening 13337 alone produces the
  "stuck on Joining…" failure, because each player gets their own port (13357, 13367, 13377, …).
  **Not 13347** — the first seat is slot 2 (`HeadlessClientManager.MinSlot`), so `SlotToPort` starts at
  13357 and nothing ever binds 13347. Two drafts of this post named it; it is a port no player uses.
- The report section is ordered by how much each question narrows things down. The first one — how far it
  gets — is worth more than all the rest combined, because it maps onto a step in the join.
- It asks for the **per-player (seat) log**, not only `godot.log`. The failure this post spends the most
  words on — stuck on *Joining…*, then "Couldn't start your game view" at 75 s — happens inside the
  seat's own process, and the host's log usually cannot show why. Sending a reporter to `godot.log`
  alone for that case asks them for the one file that does not contain the answer.
- The log advice says what a log **contains** before asking anyone to paste one. A Workshop discussion is
  public, and a log carries the poster's SteamID64 and their computer's user name (it carries no
  passwords, and no other player's account — measured, see the table). Naming that is the difference
  between an informed paste and a surprised one, so the post offers "just the `[couchcoop]` and
  `[ERROR]` lines" as the default instead.
- **Singular voice throughout.** One person answers these threads; "we" would imply a support team that
  does not exist. Keep it that way in any edit.

## Deliberately NOT changed

Section 4 says *"There are three you can get"*. That looks like an off-by-one against the four
`SeatReadinessVerdict` codes, and is not: the seat-notice hub speaks only `networkPath`, `portConflict`
and `hostBlock`. The fourth, `startup-timeout`, arrives as a `joinRejection` instead — which is exactly
what the paragraph below that list already describes separately. Leave the count alone.

## What has been checked against the shipped build

Re-checked claim by claim on Linux at `aa1384f0` against
`src/CouchCoop.Mod/Localization/Catalogs/couchcoop.en.json` and `frontend/src/i18n/messages.ts`, and
earlier on screen in `.sts2/artifacts/conndiag-round2/p2-06-crop.png`. **The previous checkpoint
(`36e466af`) covered only the copy keys, so seven claims that were never string-checked at all had gone
stale or had always been wrong — see the commit for the list.** A claim belongs in this table only once
something in the tree has been cited for it.

| the post says | the build says |
| --- | --- |
| panel is called **Connections**, reached from the **Couch Co-Op QR Code** screen | `couchcoop_connection_title`; the panel is a child of `CouchCoopQrDialog` (`AddChild(_connections)`), and the lobby's own control is `couchcoop_qr_button` |
| failures live under **Connection problems (n)** | `couchcoop_connection_problems` — the value carries `({count})` |
| the button is **Copy report** | `couchcoop_connection_copy_report` — *not* "Copy", which an earlier draft said |
| **Show technical details** | `couchcoop_connection_show_technical` |
| the three named causes, verbatim | `seat.notice.networkPath` / `portConflict` / `hostBlock`. Their `*Fix` twins are **paraphrased** in the post, not quoted |
| the progress line, at **step 1 of 6** | `join.progress.line` plus its six stage keys; `ConnectionStageSteps.Current` maps `Connecting => 1` (an earlier draft said step 2, which the product cannot print) |
| the blocked case shows **Loading…**, not Joining… | `MirrorApp.vue` clears `pendingName` on the seat redirect ("the wait from here is the headless streaming its first frame"); `SeatNoticeSpeaker` records that the browser's 90 s join timeout "is disarmed by the redirect, so a blocked viewer waits on Loading… indefinitely", and speaks at `NetworkPathSettlingDelay` = 20 s |
| Linux log path, and the **`[couchcoop]`** prefix | `~/.local/share/SlayTheSpire2/logs/godot.log`; `CouchCoopLogLine.Prefix` is `[couchcoop]`, pinned by `CouchCoopLogPrefixTests`. The post said `[couch-coop]`, a spelling `86a87c6e` removed from the mod — it would have matched nothing |
| home-screen icons survive a new host address only from the **Web link** row | `frontend/src/join/hostStore.ts` — a PWA installed from `http://<ip>:13337/` "captures that origin … and is dead the moment the router hands the PC a different address"; the stable public origin re-probes remembered hosts and recovers silently |
| per-player ports **13357, 13367, 13377** | `HeadlessClientManager.MinSlot` is 2 and `SlotToPort` is `13337 + slot*10`; `SeatPortTruthTests` asserts the first player takes `SlotToPort(2)`, and a `--seats` run logs `slot=2 port=13357` / `slot=3 port=13367` / `slot=4 port=13377`. Earlier drafts said 13347, which nothing binds |
| log lines look like **`[INFO] [couchcoop] …`**, and `[ERROR]` lines count too | `CouchCoopLogLine.Format` prepends `[couchcoop]` to the *message*; Godot's logger prepends the severity, so `[couchcoop]` is never at the start of the line. The post previously said "lines starting with `[couchcoop]`", which matches nothing |
| the **per-player log** path, `couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log` | `HeadlessUserDirSeeder.SlotBase` is `<userDir>/couch-coop/headless-slots/slot-N` and `SlotUserDir` appends `SlayTheSpire2` again (`Library/Application Support/SlayTheSpire2` on macOS); `HeadlessClientManager` launches the seat with `<SlotUserDir>/logs/godot.log`. **Confirmed on this Linux install**, doubled directory name and all. The `couch-coop/seat-logs/slot-N.log` fallback is `HeadlessClientManager.SeatLogPath`, used when per-slot isolation could not be prepared |
| the **Copy report** names both log paths | `CaptureConnectionLogsLocked(slot, hostLog, seatLogPath)` — the host log and the seat log are both attached to the connection record the report is built from |
| a log contains a **SteamID64 and the OS user name**, no passwords, no other player's account | Swept this machine's host log and all seven per-slot seat logs: one unique SteamID64 (the host's own, up to 144 occurrences, in `user://steam/<id>/…` paths), OS user name in file paths, LAN/VPN-range IPs only. The single `token` match is `PublicKeyToken=null`, a .NET artifact; the heartbeat's per-attempt token is never logged |

**One line is still unconfirmed on real hardware: the Windows `%APPDATA%\SlayTheSpire2\logs\godot.log`
path.** The code builds it from `user://logs/godot.log`
(`ProjectSettings.GlobalizePath`, `src/CouchCoop.Mod/CouchCoopMod.cs`). The `use_custom_user_dir`
question an earlier draft left open **is already answered in the tree**: `HeadlessUserDirSeeder` records
that the game sets `use_custom_user_dir=true` / `custom_user_dir_name="SlayTheSpire2"`, and that Godot
resolves that directory from `XDG_DATA_HOME` on Linux, **`APPDATA` on Windows**, and
`$HOME/Library/Application Support` on macOS. So the path in the post is what the code implies; what is
outstanding is only one look at a real Windows install, which is the Windows stage of
`~/.claude/plans/some-people-are-having-wise-seal.md`.

The same gap applies to the **per-player log paths**: the Linux one is confirmed against a real install,
and the Windows and macOS ones are the same code path resolved through `APPDATA` and
`$HOME/Library/Application Support`. The post states the Linux path in full and describes the other two
as "the same shape under their folders above" rather than spelling out two paths nobody has seen — and
it leads with **Copy report names the exact path**, which is true on every platform and is the reason
an unconfirmed path is survivable here.

## The post, as Steam BBCode

```
[h1]Can't connect from a phone or tablet?[/h1]

Most connection problems come down to a handful of causes. This list is roughly ordered from most to least common, so it is worth going in order.

[i]If your phone reaches the join page fine and the trouble is something else - a crash, a player that never finishes joining, something wrong in the game itself - post in [url=PLACEHOLDER_REPORTING_URL]Having a problem? Post it here[/url] instead.[/i]

[hr][/hr]
[h1]Things to try[/h1]

[h3]1. Pick a different address on the QR screen[/h3]
The QR screen has a selector with several ways to reach the host. If the one you scanned does not work, choose another and scan again.

Prefer the plain numeric address (something like [b]192.168.1.5:13337[/b]). It has the fewest moving parts. The [b].local[/b] name and the web link both depend on things outside the mod - your router, an internet connection, browser permissions - so they can fail on a network where the numeric address works fine.

[h3]2. Make sure the phone is really on the same network[/h3]
[list]
[*]Same Wi-Fi as the host computer, and not the [b]Guest[/b] network. Guest networks usually block devices from talking to each other, which is exactly what this needs.
[*]Not on mobile data. If the Wi-Fi has no internet access, phones will sometimes switch to mobile data on their own without telling you.
[*][b]Turn off any VPN on the phone.[/b] This one catches a lot of people. Ad blockers and "private DNS" apps that run as a VPN count too.
[/list]

[h3]3. Read what the page tells you while it is joining[/h3]
Starting a player's game can take up to a minute, and that is normal rather than a fault. While that happens the page now tells you where it has got to, on a line under [i]Joining…[/i]:

[i]Reaching the host — step 1 of 6, 14s so far. This can take up to a minute, so keep this page open.[/i]

If that line is counting up and changing stage, it is working - keep the page open. The six stages are reaching the host, waiting for the host, starting this player's game, connecting this player to the game, loading the game view, almost ready.

[h3]4. If it stops, the page now tells you WHY[/h3]
When something actually goes wrong, your device is told which of several unrelated things it was - in two sentences, plus a grey technical line. [b]Please include all of it in any report.[/b] There are three you can get, and they need completely different fixes:

[list]
[*][b]"Your game is running on the host computer, but this device couldn't reach it."[/b]
This is the network path between your phone and the host - guest Wi-Fi, a VPN, or a router keeping devices apart. Nothing is wrong with the host's game. See sections 2 and 6.
[*][b]"Another program on the host computer is using the port your game needs."[/b]
Nothing to change on your device. On the host, something else is holding one of the ports each player needs - most often a leftover player process from an earlier session. Whoever is hosting should close it (restarting Slay the Spire 2 clears it).
[*][b]"The host computer is blocking the port your game is served on."[/b]
Also nothing to change on your device. The host's own firewall or security software is blocking it - see section 5.
[/list]

[b]The most common blocked case does not say [i]Joining…[/i] at all.[/b] If your device reached the host but cannot reach the port your own player was given, the join [i]succeeds[/i] - and the page then switches to [i]Loading…[/i] and stays there. There is no progress line and no countdown on that screen, because from the host's side nothing has failed. The first useful thing you will see is the [b]"couldn't reach it"[/b] message above, about [b]20 seconds[/b] after the page changes. So: if you are stuck on [i]Loading…[/i], wait half a minute for that message rather than reloading - reloading starts the whole wait again.

If instead it sits on [i]Joining…[/i] and never changes, the host gives up at 75 seconds with [i]Couldn't start your game view - please try again[/i] and a grey line under it. That is a different failure from the one above. Either way, copy what it says.

[h3]5. Each player uses their own port[/h3]
The lobby is on [b]13337[/b], and then each player uses [b]13357[/b], [b]13367[/b], [b]13377[/b] and so on. A firewall rule that opens only 13337 lets you reach the player list and then fails at the second step. If you (or a guide you followed) added one, remove it and allow [b]the game program[/b] instead - that covers every port it needs.

[h3]6. Windows: allow the game through the firewall[/h3]
First check the network type, because this alone blocks a lot of connections:
[list]
[*][b]Settings > Network & Internet > Wi-Fi[/b] (or Ethernet) > click your network > set [b]Network profile type[/b] to [b]Private[/b].
[/list]
Then allow the game:
[list]
[*][b]Settings > Privacy & security > Windows Security > Firewall & network protection > Allow an app through firewall[/b]
[*]Find [b]Slay the Spire 2[/b] in the list and make sure [b]Private[/b] is ticked. If it is not in the list, use [b]Allow another app...[/b] and browse to the game's .exe.
[/list]
If you answered "Cancel" on a Windows firewall prompt at some point, Windows remembers that as a block rule and will never ask again. In that case you have to remove the entry above and re-add it.

Only tick [b]Public[/b] if your network is set to Public and you cannot change it. Ticking it makes the game reachable on any network you join, including cafes and hotels.

[h3]7. The router[/h3]
Some routers stop devices on the same Wi-Fi from reaching each other. Look for a setting called [b]AP isolation[/b], [b]Client isolation[/b] or [b]Wireless isolation[/b] and turn it off.

Also worth knowing: a Wi-Fi extender or powerline adapter set up in [b]router[/b] mode instead of [b]bridge[/b] / [b]access point[/b] mode puts your phone on a separate network from the host, even though the Wi-Fi name looks the same.

[h3]8. Browser settings that block plain addresses[/h3]
Some browsers try to force every address to HTTPS, which the plain numeric address does not use. (The [b]Secure link[/b] row on the QR screen is the one that does - so if HTTPS-forcing is the problem, that row is also worth trying.) If the address bar shows a security warning instead of the game, turn these off and try again:
[list]
[*]Chrome: [b]Settings > Privacy and security > Security > Always use secure connections[/b]
[*]Firefox: [b]Settings > Privacy & Security > HTTPS-Only Mode[/b]
[/list]
On iPhone, also check [b]Settings > Apps > Safari[/b] for iCloud Private Relay and "Hide IP Address".

[h3]9. Antivirus with its own firewall[/h3]
Security suites such as ESET, Bitdefender, Norton, Kaspersky and Avast have their own firewall, separate from Windows. Allowing the game in Windows does nothing for those. Check the suite's own network or firewall settings, or pause its firewall briefly to see whether that is what is blocking it.

[h3]10. If it used to work and then stopped[/h3]
The host computer's address can change when it reconnects to Wi-Fi or after a router restart. Open the QR screen again and rescan - the new address will be there.

If you added the client to your home screen, what happens next depends on which row you installed it from:
[list]
[*]Installed from the [b]Web link[/b] row: it keeps working and finds the new address by itself. Just open it - no rescan needed.
[*]Installed from the [b]numeric address[/b] or the [b]Secure link[/b]: the icon points at the old address and cannot recover. Delete it and add it again after rescanning. (Installing from the [b]Web link[/b] row instead avoids this for good.)
[/list]

[hr][/hr]
[h1]Still stuck? Post here[/h1]

No need to answer everything. Even one or two of these makes a report far easier to act on, and the first question is worth more than all the others put together.

[h3]How far does it get?[/h3]
This is the most useful thing you can tell me, because each answer points at a different cause:
[list]
[*]the browser never loads anything at all
[*]the page loads, but the player list never appears
[*]you can pick a name, but it sits on "Joining..." - tell me what the progress line under it said, and what message you got if you waited
[*]it gets past that and sits on [b]"Loading..."[/b] instead - this one is the port/firewall case, and it is the most common. Tell me whether the "couldn't reach it" message appeared after about 20 seconds
[*]it connected fine, then dropped during the run
[/list]

[h3]Anything else you can add[/h3]
[list]
[*]The exact message the phone shows, including the grey line under it. A photo of the screen is perfect.
[*]Which address you scanned - the numeric one, the [b].local[/b] name, or the web link.
[*]Host operating system, and phone/tablet model and browser.
[*]Does it fail on [b]every[/b] device, or just one? If one phone works and another does not, that rules out a lot.
[*]Did it ever work before, and did anything change since?
[*]Host on Wi-Fi or Ethernet. Any VPN running on the host or the phone. Any antivirus with a firewall.
[/list]

[h3]Three things the host computer can hand you[/h3]
[list]
[*][b]The connection panel.[/b] On the host, open the [b]Couch Co-Op QR Code[/b] screen - the [b]Connections[/b] panel is on it, under the code. Devices that got far enough to appear there are listed, and anything that went wrong is kept under [b]Connection problems[/b] (with a count after it). Select the row and use [b]Copy report[/b] - that copies a report with the failing step, the timings and the host's own diagnosis already in it. Paste it straight into your post. It also names the exact path of both log files below, which saves you hunting for them.
[*][b]The main log file.[/b] On Windows, [i]%APPDATA%\SlayTheSpire2\logs\godot.log[/i]. On Linux, [i]~/.local/share/SlayTheSpire2/logs/godot.log[/i]. On macOS, [i]~/Library/Application Support/SlayTheSpire2/logs/godot.log[/i].
[*][b]The per-player log.[/b] Each player who joins gets their own copy of the game running in the background on the host, and each keeps its own log. [b]If the join reached [i]Joining...[/i] and then timed out, this is the file that explains why[/b] - the main log above usually will not. Players are numbered from 2, so the first person who joins is [b]slot-2[/b]: on Linux that is [i]~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log[/i] (yes, [i]SlayTheSpire2[/i] twice - not a typo), and the Windows and macOS paths follow the same shape under their folders above. On some setups it is a single file at [i]couch-coop/seat-logs/slot-2.log[/i] instead.
[/list]

[b]Which lines matter.[/b] In either log, the useful ones contain [i][couchcoop][/i] - they look like [i][INFO] [couchcoop] ...[/i] - plus any [i][ERROR][/i] lines, even ones that don't mention couchcoop. Those are usually enough on their own.

[b]Before you paste a whole log:[/b] this is a public board, and a log contains your own [b]SteamID64[/b] (a long number starting 7656, which points at your Steam profile) and your computer's [b]user name[/b], in file paths. It does [i]not[/i] contain passwords, and it does not contain other players' accounts - only yours. If you would rather not post that, a find-and-replace on those two before pasting is enough, or just post the [i][couchcoop][/i] and [i][ERROR][/i] lines and I'll ask if I need more.

[hr][/hr]
One last note: everyone who can reach the join address can open the client and play, so use this on a network you trust.
```
