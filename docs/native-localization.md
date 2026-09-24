# Native localization

The C# mod owns its native in-game strings independently from the browser client. Its embedded catalogs are:

- `src/CouchCoop.Mod/Localization/Catalogs/couchcoop.en.json`
- `src/CouchCoop.Mod/Localization/Catalogs/couchcoop.<game-code>.json`

Every catalog key uses the collision-safe `couchcoop_` prefix. Keep every catalog key-for-key identical,
with nonblank values and identical named placeholders. Add product copy as a catalog key; reserve literal
`CouchCoopText` values for external or unknown diagnostics only.

## Locale and runtime behavior

`CouchCoopLocalization` follows `LocManager.Instance.Language`. The supported game codes are `eng`, `zhs`,
`deu`, `esp`, `fra`, `ita`, `jpn`, `kor`, `pol`, `ptb`, `rus`, `spa`, `tha`, and `tur`; unavailable or future
game locales use English. **The two Spanish codes read backwards:** `esp` is Español (Latinoamérica),
Steam's `latam`, and `spa` is Español (España), Steam's `spanish`. The game's own language picker names
them that way, and each catalog is written in its players' variety. It merges the active catalog into the
existing `static_hover_tips` table and uses `LocString` when that game table is available, with the embedded
catalog as a safe fallback. Locale changes increment its revision and request native panels to refresh.

`CouchCoopGameUiTheme` asks the game's bold substitute-font API for `zhs`, `jpn`, `kor`, `rus`, and `tha`; all other locales retain
the supplied Kreon font or Godot's default. Native panels use the revision to repaint retained activity
rows, dialogs, QR options, hover-title aliases, and fonts without changing an open/collapsed state.

Developer diagnostics stay English: use `CouchCoopText.ResolveForLanguage(CouchCoopLocalization.EnglishLanguage)`
when a semantic player-facing value must be logged. Do not resolve it in the active UI locale for a log.

## Per-language checklist

1. Add the same prefixed key and named placeholders to every JSON catalog.
2. Preserve every English sentence and player-facing caveat when migrating existing native copy.
3. Provide a faithful translation for every supported language, retaining URLs, IPs, player names, codes, and other
   external values unchanged.
4. Store player-facing state as `CouchCoopText`; use named arguments and nested localized arguments where needed.
5. Extend `CouchCoopLocalizationTests` or the affected native copy test for semantic mapping, locale fallback,
   placeholder parity, and any wording that must not be abbreviated.
6. Run `COUCHCOOP_GAME_MODS_DIR=/tmp/cc-mods-i18n-native flock --close /tmp/cc-mod-tests-i18n-native.lock dotnet run --project tests/CouchCoop.Mod.Tests`.
