# Changelog

What changed in CouchCoop, written for the people who play with it. Each release on
[GitHub](https://github.com/tfoxy/sts2-couch-coop/releases) carries the section below it verbatim.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html). Sections are drafted from the
`Changelog:` trailers on commits — see [docs/commit-and-release.md](docs/commit-and-release.md).

## [Unreleased]

## [0.4.0] - 2026-10-04

### Added

- Mirror viewers can choose a Rust canvas stage in Settings while DOM remains the default, except for WebKit browsers (Safari on macOS and any browser in iOS).
- Add an optional MSDF text setting for the canvas view.

### Fixed

- Canvas specific:
  - Canvas keeps supported map content visible and offers retry on renderer failure.
  - Fixed black reward screens on the canvas stage so reward text and taps work again.
  - Event choices now show styled text and energy icons on the canvas stage.
  - Canvas viewers can see selected-card ripples, rarity glows, and event text.
  - Hand cards stay in the correct place on wide canvas screens.
  - Phones no longer redraw the whole combat every frame once the end-turn button glows
  - Canvas text no longer sits slightly up and to the left of where the game draws it.
  - Fixed outlined/tinted label colours on the canvas renderer matching the game.
  - Dragging the map on the canvas stage no longer makes it jump back and forth.

### Changed

- Canvas specific:
  - The canvas renderer uses noticeably less CPU during busy combat.
  - The canvas renderer uses far less CPU during busy combat.
  - Dragging and aiming cards on wide phones is much smoother.
  - Aiming and dragging cards on wide phones does less work per frame.
  - The canvas renderer copies one fewer full screen per frame, so phones do less work.
  - Phones spend less GPU time presenting each frame of the game view.
  - Idle combat no longer wakes the browser for frames the game view does not draw
  - Idle combat animations cost the browser less CPU on phones
  - Idle animations in combat are smooth on the canvas renderer.
  - Combat uses less battery on phones while nothing is happening.
  - Combat uses less CPU on phones with the canvas renderer.
  - Playing a card no longer makes the browser view stutter while its text redraws.

## [0.3.4] - 2026-09-26

### Fixed

- Drive hosting-end detection off the screen event, not a poll, improving performance
- Read the roster on game signals, not a state subscription
- Read the lobby player cap without a full state snapshot
- Decide detach-versus-release without a full state snapshot
- Read the lobby gates without a full state snapshot
- Lobby character and name changes now reach every connected viewer.

### Changed

- Couch seats that dropped mid-run are now cleared only after you leave the run and lobby.

## [0.3.3] - 2026-09-25

### Fixed

- Fixed couch players getting stuck at run start when a Steam friend joins.
- Stop idle scene monitoring when browsers disconnect while keeping active multiplayer seats available for reconnection with a fresh scene.
- Every translation was reviewed: mistranslated and machine-sounding text is fixed in all 13 languages, the Couch Co-Op name is no longer translated, and phone screens no longer show raw placeholders such as {値}.
- The phone's settings panel title now reads naturally in every language.
- The mod now calls the game 《杀戮尖塔2》 in Simplified Chinese, as the game itself does.

### Changed

- Hosting with phones connected does much less background work per phone, reducing stutter and memory growth during long sessions.

## [0.3.2] - 2026-09-23

### Fixed

- Fix browser taps and keys doing nothing while BaseLib's log window is open.
- A player's game that can't reach the host is no longer reported as a Steam Cloud risk.

## [0.3.1] - 2026-09-23

### Fixed

- A controller on the host PC now controls only the host's game, instead of also moving every browser player's game at the same time. The fix now targets Steam Input (without it it was working fine).
- Players on a phone or browser see the ancient, shop and combat backgrounds again when Static background is on.
- The shop's static background is centred again instead of showing only its top-left corner.

## [0.3.0] - 2026-09-22

### Added

- A gamepad now plays the browser client — phone or Steam Deck — over an HTTPS join link.
- A keyboard attached to the browser client now plays the game.
- Quality is now a mirror setting: pick a level and the effect options follow it.
- The join QR screen can turn off a mod for browser players when it crashes their game.
- The join QR code is now in the pause menu, so a player whose phone dropped out can scan back in without abandoning the run.
- Couch Co-Op now copies your save profile aside before the first browser player joins.
- When co-op can't start because the game runtime never attached, the log now says exactly that instead of reporting the lobby as "not host".
- Add stand in for a creature whose spine art is late or absent
- Add a quiet copy button beside the QR dialog's join URL
- Animate the game's rich-text effects in the browser client

### Fixed

- A player's game is stopped if it cannot promise to leave your Steam Cloud saves alone.
- A player's game that joins then stops responding is no longer reported as a save problem.
- Headless co-op seats no longer respond to the host controller.
- A hand card no longer dips below its place in the fan and drifts back when it stops being focused.
- A hand card no longer dips below its place in the fan and drifts back when it stops being focused on the canvas stage.
- Browser diagnostics now show stage fit without accumulating duplicate animation rules.
- Static backgrounds no longer restore live scenery when a still image fails to load.
- Fixed a crash that could take the game down a few seconds after startup.
- Windows players no longer get a "mod will not be loaded" error in their log at launch.
- Browser players' games no longer crash as a run starts with a mod like Minty Spire 2 on.
- A browser player's game now loads its mods in the same order as the host's.

### Changed

- The mod no longer keeps a timer running four times a second for the whole session — it now only does work while a co-op lobby is actually on screen.
- Reduce initial browser memory use when joining the Neow event.
- Start iPhones with shaders and particles off to avoid crashes. Show baked stills when shaders or particles are off (card ripple and glow)
- Add an opt-in retained canvas subtree cache for performance validation.

## [0.2.3] - 2026-09-16

### Fixed

- The extra games launched for browser players no longer write into your Steam Cloud saves, or take
  over the run you had in progress. If an earlier version overwrote your profile, see
  [docs/save-recovery.md](docs/save-recovery.md) for how to get it back.
- Fix custom sounds from other mods crashing the client (e.g. selecting Downfall character in the character select screen)
- The mod now loads on a macOS install instead of refusing because it could not tell which game build it is.
- macOS browser players now use isolated local game profiles.
- A cache that cannot be set up no longer stops the mod from loading.
- A cache write is no longer refused for the rest of a session when free space cannot be measured.
- The host no longer claims nothing can reach it while phones are already connecting.
- A taken seat port now tells you to close whatever is holding it, rather than to restart the game.
- The host's connection panel now tells you when a player's device cannot reach the game it was given, instead of telling you to reload their browser.
- The host is now warned when another program on the computer is using one of the ports Couch Co-Op gives players, instead of finding out only when a rejoin fails.
- A phone that cannot reach its own game view now waits for it instead of making the host restart that player's game over and over, and a join refused because of a blocked or busy port now says what to do about it.

## [0.2.2] - 2026-09-15

### Changed

- Serve both game branches from one payload

## [0.2.1] - 2026-09-14

### Fixed

- Cache now keeps two version folders at most, named by version

## [0.2.0] - 2026-09-14

### Added

- CouchCoop now runs on the game's public-beta branch.
- Steam Workshop metadata is localized for all supported Slay the Spire 2 languages.
- Log in lobby was replaced with a Connections panel in the QR code dialog. For each device, it shows connection progress and any issue that may have happened.

### Fixed

- Taking a reward on a phone now goes through the game's own button, so a potion you have no room for is declined instead of vanishing
- Fixed a reward row being taken instead of highlighted when you tapped it again after tapping somewhere else
- Hosting with a player-limit mod installed now really admits more than four players.
- CouchCoop's in-game buttons (e.g. QR code dialog button, other buttons inside the QR dialog interface) can now be activated with a controller (such as when hosting from the SteamDeck and using its controller to open/close the QR code dialog).
- A player's game now refuses to join when it is running a different copy of the mod than the host, and says which one it loaded, instead of failing with an unexplained timeout.
- Cached art is now kept per game version and per Steam branch, so switching between the stable and
  beta branches — or playing after a game update — no longer shows art left over from the other
  build. Phones drop their saved copies on the same change, and the host keeps at most two caches
  and clears out anything older.
- A player's game window is no longer closed for taking too long to start on a slower host.
- Player names now appear correctly in the host's activity panel in every language.

### Changed

- Workshop uploads now record which build they came from, so a published item can be traced back to
  the release it was packaged from.

## [0.1.1] - 2026-09-11

### Changed

- Raise-hand cards now start switched off on every device, phones included. Turn them on per device
  if you want them; the setting is remembered, and a `?raiseHand=` link still wins.

## [0.1.0] - 2026-09-11

First public release. Turn the phones, tablets and laptops on your network into browser clients for
a local Slay the Spire 2 co-op session — no app to install on the other devices, and no `sts2` CLI
needed to run the mod.

[Unreleased]: https://github.com/tfoxy/sts2-couch-coop/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/tfoxy/sts2-couch-coop/releases/tag/v0.4.0
[0.3.4]: https://github.com/tfoxy/sts2-couch-coop/releases/tag/v0.3.4
[0.3.3]: https://github.com/tfoxy/sts2-couch-coop/releases/tag/v0.3.3
[0.3.2]: https://github.com/tfoxy/sts2-couch-coop/releases/tag/v0.3.2
[0.3.1]: https://github.com/tfoxy/sts2-couch-coop/releases/tag/v0.3.1
[0.3.0]: https://github.com/tfoxy/sts2-couch-coop/releases/tag/v0.3.0
[0.2.3]: https://github.com/tfoxy/sts2-couch-coop/releases/tag/v0.2.3
[0.2.2]: https://github.com/tfoxy/sts2-couch-coop/releases/tag/v0.2.2
[0.2.1]: https://github.com/tfoxy/sts2-couch-coop/releases/tag/v0.2.1
[0.2.0]: https://github.com/tfoxy/sts2-couch-coop/releases/tag/v0.2.0
[0.1.0]: https://github.com/tfoxy/sts2-couch-coop/releases/tag/v0.1.1
[0.1.0]: https://github.com/tfoxy/sts2-couch-coop/releases/tag/v0.1.0
