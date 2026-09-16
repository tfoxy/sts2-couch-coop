# Changelog

What changed in CouchCoop, written for the people who play with it. Each release on
[GitHub](https://github.com/tfoxy/sts2-couch-coop/releases) carries the section below it verbatim.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html). Sections are drafted from the
`Changelog:` trailers on commits — see [docs/commit-and-release.md](docs/commit-and-release.md).

## [Unreleased]

## [0.2.3] - 2026-09-16

### Fixed

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

[Unreleased]: https://github.com/tfoxy/sts2-couch-coop/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/tfoxy/sts2-couch-coop/releases/tag/v0.2.3
[0.2.2]: https://github.com/tfoxy/sts2-couch-coop/releases/tag/v0.2.2
[0.2.1]: https://github.com/tfoxy/sts2-couch-coop/releases/tag/v0.2.1
[0.2.0]: https://github.com/tfoxy/sts2-couch-coop/releases/tag/v0.2.0
[0.1.1]: https://github.com/tfoxy/sts2-couch-coop/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/tfoxy/sts2-couch-coop/releases/tag/v0.1.0
