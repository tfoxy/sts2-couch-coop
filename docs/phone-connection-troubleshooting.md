# Workshop troubleshooting post — "Can't connect from a phone?"

The support post for the Steam Workshop discussion board, kept here so it is maintained with the code it
describes rather than living only in a chat log. **It is not published from this repo** — the maintainer
pastes it into a discussion by hand. Suggested title: **Can't connect from a phone? Read this first**.

## Why it is shaped this way

- It leads with **switching rows in the QR host selector**, not with the firewall: that is the only fix
  which is one tap, needs no admin rights, and covers a whole class of causes at once.
- The Windows advice says **allow the program, not a port**. Opening 13337 alone produces the
  "stuck on Joining…" failure, because each player gets their own port (13347, 13357, 13367, …).
- The report section is ordered by how much each question narrows things down. The first one — how far it
  gets — is worth more than all the rest combined, because it maps onto a step in the join.

## What has been checked against the shipped build

Verified on Linux at `36e466af` against `src/CouchCoop.Mod/Localization/Catalogs/couchcoop.en.json` and
`frontend/src/i18n/messages.ts`, and again on screen in `.sts2/artifacts/conndiag-round2/p2-06-crop.png`:

| the post says | the build says |
| --- | --- |
| panel is called **Connections** | `couchcoop_connection_title` |
| failures live under **Connection problems** | `couchcoop_connection_problems` |
| the button is **Copy report** | `couchcoop_connection_copy_report` — *not* "Copy", which an earlier draft said |
| **Show technical details** | `couchcoop_connection_show_technical` |
| the three named causes, verbatim | `seat.notice.networkPath` / `portConflict` / `hostBlock` and their `*Fix` twins |
| the progress line | `join.progress.line` plus its six stage keys |
| Linux log path | `~/.local/share/SlayTheSpire2/logs/godot.log` |

**One line is still unverified: the Windows `%APPDATA%\SlayTheSpire2\logs\godot.log` path.** The code
builds it from `user://logs/godot.log` (`src/CouchCoop.Mod/CouchCoopMod.cs`), and Godot's Windows
`user://` depends on the project's `use_custom_user_dir` setting, so it needs one look at a real Windows
install before the post goes out. That check is the Windows stage of
`~/.claude/plans/some-people-are-having-wise-seal.md`, deferred to a later round.

## The post, as Steam BBCode

```
[h1]Can't connect from a phone or tablet?[/h1]

Most connection problems come down to a handful of causes. This list is roughly ordered from most to least common, so it is worth going in order.

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
Starting a player's game can legitimately take up to a minute. While that happens the page now tells you where it has got to, on a line under [i]Joining…[/i]:

[i]Reaching the host — step 2 of 6, 14s so far. This can take up to a minute, so keep this page open.[/i]

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

If you get none of those and it simply sits there, the host gives up at 75 seconds with [i]Couldn't start your game view - please try again[/i] and a grey line under it. Most people close the tab before that, so if you can, wait it out once and copy what it says.

[h3]5. Each player uses their own port[/h3]
The lobby is on [b]13337[/b], and then each player uses [b]13347[/b], [b]13357[/b], [b]13367[/b] and so on. A firewall rule that opens only 13337 lets you reach the player list and then fails at the second step. If you (or a guide you followed) added one, remove it and allow [b]the game program[/b] instead - that covers every port it needs.

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
Some browsers try to force every address to HTTPS, which the host does not use. If the address bar shows a security warning instead of the game, turn these off and try again:
[list]
[*]Chrome: [b]Settings > Privacy and security > Security > Always use secure connections[/b]
[*]Firefox: [b]Settings > Privacy & Security > HTTPS-Only Mode[/b]
[/list]
On iPhone, also check [b]Settings > Apps > Safari[/b] for iCloud Private Relay and "Hide IP Address".

[h3]9. Antivirus with its own firewall[/h3]
Security suites such as ESET, Bitdefender, Norton, Kaspersky and Avast have their own firewall, separate from Windows. Allowing the game in Windows does nothing for those. Check the suite's own network or firewall settings, or pause its firewall briefly to see whether that is what is blocking it.

[h3]10. If it used to work and then stopped[/h3]
The host computer's address can change when it reconnects to Wi-Fi or after a router restart. Open the QR screen again and rescan - the new address will be there. If you added the client to your home screen, it keeps working; it just needs one fresh scan to learn the new address.

[hr][/hr]
[h1]Still stuck? Post here[/h1]

No need to answer everything. Even one or two of these makes a report far easier to act on, and the first question is worth more than all the others put together.

[h3]How far does it get?[/h3]
This is the most useful thing you can tell us, because each answer points at a different cause:
[list]
[*]the browser never loads anything at all
[*]the page loads, but the player list never appears
[*]you can pick a name, but it sits on "Joining..." - tell us what the progress line under it said, and what message you got if you waited
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

[h3]Two things the host computer can hand you[/h3]
[list]
[*][b]The connection panel.[/b] On the host, the lobby has a [b]Connections[/b] panel. Devices that got far enough to appear there are listed, and anything that went wrong is kept under [b]Connection problems[/b]. Select the row and use [b]Copy report[/b] - that copies a report with the failing step, the timings and the host's own diagnosis already in it. Paste it straight into your post.
[*][b]The log file.[/b] On Windows it is at [i]%APPDATA%\SlayTheSpire2\logs\godot.log[/i]. On Linux, [i]~/.local/share/SlayTheSpire2/logs/godot.log[/i]. Lines starting with [i][couch-coop][/i] are the relevant ones.
[/list]

[hr][/hr]
One last note: everyone who can reach the join address can open the client and play, so use this on a network you trust.
```
