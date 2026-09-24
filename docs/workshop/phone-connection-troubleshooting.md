# Workshop troubleshooting post — "Can't connect from a phone?"

The notes behind the support post for the Steam Workshop discussion board: why it is shaped the way it is,
and what each claim was checked against. The post itself is under `workshop/discussions/` — see
[The post](#the-post). **It is not published from this repo** — the maintainer pastes it into a discussion
by hand. Discussion title: **Can't connect from a phone? Read this first**.

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
- Two additions came from one field report (Windows 11, mod 0.2.3, zero inbound connections in 90 s, tried
  on a Samsung phone *and* an iPad). The iPad half of that report carried no information at all — the web
  link cannot work there — and the reporter had no way to know, so **section 1 now says so before anyone
  spends an evening on their router**. The other is the self-test in section 6: everybody tries the address
  on the host PC, it always works, and it is the one check that passes *precisely* when the host's own
  firewall is the cause.

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
| an **iPhone or iPad cannot use the Web link row at all**, and it is a browser rule rather than a setting | Measured 2026-09-17, WebKit 26.4 against Chromium 147 — [local-network-access.md](../agents/local-network-access.md) "WebKit refuses the whole mode". Every insecure private-IP subresource of an https page is blocked outright, so there is no permission to grant. The client says it too: `boot.unreachableIos`, gated by `webLinkBlockedByBrowser` in `frontend/src/boot/bootstrap.ts` |
| the row names the post tells an iOS player to pick, **Plain address** and **Secure link** | `couchcoop_qr_method_ipv4_title` / `couchcoop_qr_method_secure_title`. The in-game description of the web row already ends "doesn't work on iPhone yet" (`couchcoop_qr_method_web_description`), so the two screens now agree |
| **opening the address on the host PC proves nothing about the firewall** | [windows-connection-fingerprints.md](../agents/windows-connection-fingerprints.md) §5: with an inbound Block rule in force the guest answered **its own LAN address** with HTTP 200 while the blocked peer got three 10 s timeouts and no RST. Windows does not filter a machine's traffic to itself |
| a log contains a **SteamID64 and the OS user name**, no passwords, no other player's account | Swept this machine's host log and all seven per-slot seat logs: one unique SteamID64 (the host's own, up to 144 occurrences, in `user://steam/<id>/…` paths), OS user name in file paths, LAN/VPN-range IPs only. The single `token` match is `PublicKeyToken=null`, a .NET artifact; the heartbeat's per-attempt token is never logged |

**The Windows paths are now confirmed on real hardware (2026-09-22).** Both
`%APPDATA%\SlayTheSpire2\logs\godot.log` and the per-player
`%APPDATA%\SlayTheSpire2\couch-coop\headless-slots\slot-<N>\SlayTheSpire2\logs\godot.log` were read off a
physical Windows 10 Home 22H2 install with the mod running — doubled directory name and all. The code
builds them from `user://logs/godot.log` (`ProjectSettings.GlobalizePath`,
`src/CouchCoop.Mod/CouchCoopMod.cs`), and `HeadlessUserDirSeeder` records that the game sets
`use_custom_user_dir=true` / `custom_user_dir_name="SlayTheSpire2"`, which Godot resolves from
`XDG_DATA_HOME` on Linux, **`APPDATA` on Windows**, and `$HOME/Library/Application Support` on macOS. So
the post's paths are both what the code implies and what a real install does. Rig and method:
[windows-home-rig.md](../agents/windows-home-rig.md).

The same gap applies to the **per-player log paths**: the Linux one is confirmed against a real install,
and the Windows and macOS ones are the same code path resolved through `APPDATA` and
`$HOME/Library/Application Support`. The post states the Linux path in full and describes the other two
as "the same shape under their folders above" rather than spelling out two paths nobody has seen — and
it leads with **Copy report names the exact path**, which is true on every platform and is the reason
an unconfirmed path is survivable here.

### Localized menu names

Checked 2026-09-24 in all 13 translations. Every Windows, browser, iPhone and router menu name in a
translated post is the product's own string in that language, looked up rather than recalled. The source
for each product:

| product | where the localized names came from |
| --- | --- |
| Windows 11 | Microsoft Support's localized articles (`support.microsoft.com/<ll-cc>/windows/…`: the essential network settings article, and "Risks of allowing apps through Windows Firewall"), checked against the [Microsoft Terminology Collection](https://learn.microsoft.com/en-us/globalization/reference/microsoft-terminology). The articles are machine-translated: they leave "&" inside names ("Red & Internet") and garble ru/tr/th, so where the two disagree, the Terminology Collection wins |
| Chrome | Chrome Help, [Always use secure connections](https://support.google.com/chrome/answer/10468685), `?hl=<lang>` |
| Firefox | Firefox's own shipped strings, `mozilla-l10n/firefox-l10n` `<locale>/browser/browser/preferences/preferences.ftl`. The support site blocks automated reads |
| iPhone, Safari, iCloud | Apple's localized iPhone User Guide, `support.apple.com/<ll-cc>/guide/iphone/…` |
| Android Private DNS | Android Help, `support.google.com/android/answer/9654714?hl=<lang>` |
| guest network, AP isolation, router modes | A major router maker's localized support site (TP-Link, ASUS, NEC Aterm, Keenetic). A local name is used only where one of them uses it; otherwise the English name stays |
| Steam's *Workshop* and *discussion* | The discussion page itself, with `?l=<steam language>` |

**No official source, so the translators' wording stands:**
- The **Private / Public** tick-box columns in the allowed-apps list, in every language. No Microsoft page
  names them. The Italian posts say *Privato / Pubblico*; one third-party guide says *Privata / Pubblica*.
- **Privacy & security** in Windows. The localized articles keep the English "&", so the posts use the
  language's "and" instead, by analogy with the Terminology Collection's "Network & Internet". This is
  least certain in German, where Windows Security's own names do keep "&".
- **Cancel** on the firewall prompt. The word comes from the Terminology Collection's generic button; no
  article quotes the prompt itself.
- **Windows names in the Latin American Spanish posts.** Microsoft has no `es-mx` support pages (they
  redirect to `es-es`), so the Spain Spanish names are used.
- **Turkish Public profile.** The firewall article says *Ortak ağ* and the Settings article says *Genel ağ
  (Önerilen)*. The posts are unchanged.
- **Russian Allow an app through firewall.** Two Microsoft articles disagree, so the post's wording is
  unchanged.
- **Japanese Allow another app, and Privacy & security in ja/ko/zh.** These rest on PC makers' Windows
  support pages (NEC, Samsung, Lenovo), not on Microsoft's.

A Windows 11 install in the language would settle any of these.

**Two paths were corrected on 2026-09-24, in the English post and all 13 translations:**
- **Firefox.** The path follows the redesigned settings, which are on by default in release Firefox (checked
  on 157.0: `browser.settings-redesign.enabled` is `true` in the release branch's
  `browser/app/profile/firefox.js`). The Privacy and security page has a *Connection and software security*
  row, and its **Advanced settings** button opens the sub-page that holds the HTTPS-Only Mode group (the
  `connectionSecurity` entry in `browser/components/preferences/preferences.js`). The old *Privacy &
  Security > HTTPS-Only Mode* path is the pre-redesign layout.
- **iPhone.** iCloud Private Relay is at Settings > *[your name]* > iCloud > Private Relay, per Apple's
  "Protect web browsing with iCloud Private Relay" guide page. Only *Hide IP address* is under Settings >
  Apps > Safari ("Browse privately in Safari"). The post used to send readers to Safari for both.

## The post

The English BBCode that is pasted into Steam is
[`workshop/discussions/english/phone-connection-troubleshooting.bbcode`](../../workshop/discussions/english/phone-connection-troubleshooting.bbcode).
Each other Steam language has a Markdown translation at
`workshop/discussions/<language>/phone-connection-troubleshooting.md`, read on GitHub rather than posted to
Steam. [README.md](README.md#translations) covers how they differ from the English and how to keep them in
step.
