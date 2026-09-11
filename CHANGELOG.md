# Changelog

What changed in CouchCoop, written for the people who play with it. Each release on
[GitHub](https://github.com/tfoxy/sts2-couch-coop/releases) carries the section below it verbatim.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html). Sections are drafted from the
`Changelog:` trailers on commits — see [docs/commit-and-release.md](docs/commit-and-release.md).

## [Unreleased]

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

[Unreleased]: https://github.com/tfoxy/sts2-couch-coop/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/tfoxy/sts2-couch-coop/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/tfoxy/sts2-couch-coop/releases/tag/v0.1.0
