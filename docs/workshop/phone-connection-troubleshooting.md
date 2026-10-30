# Workshop troubleshooting post — "Can't connect from a phone?"

The notes behind the support post for the Steam Workshop discussion board: why it is shaped the way it is,
and what each claim was checked against. The post itself is under `workshop/discussions/` — see
[The post](#the-post). **It is not published from this repo** — the maintainer pastes it into a discussion
by hand. Discussion title: **Can't connect from a phone? Read this first**.

## Why it is shaped this way

- **One setup for first-time users:** choose the host's normal wired or Wi-Fi interface and plain
  **Direct address** (HTTP). Do not recommend another method as a connection fix. HTTPS methods are
  optional performance and security choices with additional setup or connection requirements.
- Describe the **two selectors** only far enough to identify what to choose. The guide skips
  **PC name (.local)** and distinguishes plain Direct address from its HTTPS alternative. Debug
  interface choices, method comparisons, unavailable-option behavior and certificate setup do not
  help a new user establish the basic connection.
- Separate **the page will not open** from **the page opens but joining stalls**. Readers who can
  already open the page can skip the network checks and go straight to the joining advice.
- The Windows advice says **allow the program through the firewall**, rather than asking readers to
  open ports. Keep the warning that opening the page on the host does not test access from a phone,
  without the longer explanation of the test.
- Lead support collection with **how far it gets**, the error, basic device details and **Copy report**.
  Explain what to do if no connection appears in the panel. The report provides the relevant log paths;
  the linked reporting post already explains log collection, so do not duplicate those paths or the
  background-process explanation here.
- Keep a brief **public-log privacy reminder** before directing readers to log instructions. Logs can
  include the poster's Steam account ID and computer user name.
- **Singular voice throughout.** One person answers these threads; do not imply a support team.

The beginner rewrite removes the old HTTPS-method recommendations from the browser-settings and
home-screen-shortcut sections as well as the QR instructions. It also removes the six-stage enumeration,
separate antivirus section and repeated reporting questions. All 13 translations follow the same seven
steps and support section.

## What has been checked against the shipped build

The rewrite keeps the existing verified network and firewall advice and uses current native and browser
catalog labels. A claim belongs in this table only once something in the tree has been cited for it.

| the post says | checked against |
| --- | --- |
| the QR screen has a network selector on the left and a method selector on the right | `CouchCoopQrDialog` places the two selectors in that order; `QrSelectionModel` resolves their pair |
| choose **Wired (Ethernet)** or **Wi-Fi**, and skip **PC name (.local)** | native `couchcoop_qr_adapter_ethernet_title`, `couchcoop_qr_adapter_wifi_title` and `couchcoop_qr_method_mdns_title`; the adapter descriptions identify normal LAN connections and the name-resolution dependency |
| choose **Direct address**, without the HTTPS suffix, and expect `http://` | native `couchcoop_qr_method_ipv4_title` / `couchcoop_qr_method_direct_https_title` and the plain-method description; `QrSelectionModel` distinguishes the methods |
| HTTPS methods are optional performance and security choices with additional requirements | native method descriptions and [direct-ip-https.md](../direct-ip-https.md); the secure-context browser paths are documented in [local-network-access.md](../agents/local-network-access.md) |
| the panel is **Connections** on the **Couch Co-Op QR Code** screen, with **Connection problems** and **Copy report** | native `couchcoop_qr_button`, `couchcoop_connection_title`, `couchcoop_connection_problems`, `couchcoop_connection_copy_report`; `CouchCoopQrDialog` hosts the panel |
| starting a player's game can take up to a minute; keep the page open while its progress changes stage | `frontend/src/i18n/messages.ts`: `join.progress.line` and the stage messages; localized **Joining…** and **Loading…** come from the browser catalogs |
| the report names the relevant log paths | `CaptureConnectionLogsLocked` attaches host and player log paths to the connection record |
| opening the address on the host does not test whether its firewall allows the phone | [windows-connection-fingerprints.md](../agents/windows-connection-fingerprints.md) §5: with an inbound block rule, the host reached its own LAN address while the peer timed out |
| an old bookmark or home-screen shortcut may need replacing after an address change | `frontend/src/join/hostStore.ts` documents address-bound origins; the guide says to replace a shortcut only if it stops working |
| logs can include the poster's Steam account ID and OS user name | prior host and player-log review found the host's SteamID64 and user name in file paths; detailed collection instructions remain in the reporting post |

The labels named by the connection instructions are pinned for all 14 languages by
`scripts/test-workshop-discussions.sh`. It deliberately does not require the post to name every available
connection method. The English translation links, localized discussion notices and sibling reporting links
remain checked there too.

### Localized menu names

The Windows and browser paths reuse the names checked across all 13 translations on 2026-09-24.
The beginner rewrite removes the iPhone-specific settings and Private DNS advice. Sources for the
remaining menu names:

| product | where the localized names came from |
| --- | --- |
| Windows 11 | Microsoft Support's localized articles (`support.microsoft.com/<ll-cc>/windows/…`: the essential network settings article, and "Risks of allowing apps through Windows Firewall"), checked against the [Microsoft Terminology Collection](https://learn.microsoft.com/en-us/globalization/reference/microsoft-terminology). The articles are machine-translated: they leave "&" inside names ("Red & Internet") and garble ru/tr/th, so where the two disagree, the Terminology Collection wins |
| Chrome | Chrome Help, [Always use secure connections](https://support.google.com/chrome/answer/10468685), `?hl=<lang>` |
| Firefox | Firefox's own shipped strings, `mozilla-l10n/firefox-l10n` `<locale>/browser/browser/preferences/preferences.ftl`. The support site blocks automated reads |
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
- **Russian Allow an app through firewall.** Two Microsoft articles disagree, so the post's wording is
  unchanged.
- **Japanese Allow another app, and Privacy & security in ja/ko/zh.** These rest on PC makers' Windows
  support pages (NEC, Samsung, Lenovo), not on Microsoft's.

A Windows 11 install in the language would settle any of these.

**Firefox's path was corrected on 2026-09-24, in English and all 13 translations.** It follows the
redesigned settings, which were enabled in release Firefox 157.0: the Privacy and security page has a
*Connection and software security* row, and its **Advanced settings** button opens the page containing
HTTPS-Only Mode. The prior *Privacy & Security > HTTPS-Only Mode* path was the older layout.

**Turkish Chrome's setting name was corrected on 2026-10-30.** The old post had an unrelated domain-name
phrase in the browser path. [Google's Turkish Chrome Help](https://support.google.com/chrome/answer/10468685?hl=tr)
names the setting **Her zaman güvenli bağlantılar kullan**; the rewritten translation uses that label.

## The post

The English BBCode that is pasted into Steam is
[`workshop/discussions/english/phone-connection-troubleshooting.bbcode`](../../workshop/discussions/english/phone-connection-troubleshooting.bbcode).
Each other Steam language has a Markdown translation at
`workshop/discussions/<language>/phone-connection-troubleshooting.md`, read on GitHub rather than posted to
Steam. [README.md](README.md#translations) covers how they differ from the English and how to keep them in
step.
