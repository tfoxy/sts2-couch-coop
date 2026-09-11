# Browser localization

The browser SPA's typed source catalog is [frontend/src/i18n/messages.ts](../frontend/src/i18n/messages.ts).
`en` is authoritative; `zhHans` must have the same keys, placeholders, and no blank entries. The integrity
test is [frontend/src/i18n/__tests__/locale.spec.ts](../frontend/src/i18n/__tests__/locale.spec.ts).

Locale selection is intentionally browser-only. `frontend/src/i18n/locale.ts` checks `navigator.languages` in
order, then `navigator.language`, normalising case and `_`. It supports English, Simplified Chinese, German,
Spanish (Spain and Latin America), French, Italian, Japanese, Korean, Polish, Brazilian Portuguese, Russian,
Thai, and Turkish. Traditional Chinese and unsupported explicit regional variants are not substituted; English is
the fallback. Every supported BCP-47 catalog name is a non-persisted `?lang=` QA override. A `languagechange` updates both
Vue and the document `lang`; this never follows the host/game locale.

The public-origin boot page must remain Vue-free. It uses `src/boot/localize.ts`, which imports only the plain
catalog and selector. `offline.html` is self-contained and must retain an inline detector plus bilingual recovery
and port-probe messages. The host and public HTML shells select `manifest.zh-Hans.webmanifest` before the app
loads; manifests retain product and browser proper names.

To add a locale:

1. Add the locale to `SupportedLocale`, negotiation rules, and `messages`.
2. Copy every English key, preserve every `{placeholder}`, and write natural, nonblank UI text.
3. Add the locale-specific host and public manifests and shell selection.
4. Keep bootstrap/offline code independent of Vue and preserve raw player names, URLs, game text, and unknown
   diagnostics.
5. Extend locale, catalog, component, bootstrap, offline, and manifest tests; run `vue-tsc`, Vitest, Playwright,
   and `npm run build:pages`.
