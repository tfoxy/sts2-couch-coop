import { createI18n, type I18n } from "vue-i18n";

import { messages, type MessageKey } from "./messages";
import { DEFAULT_LOCALE, htmlLanguage, selectLocale, type LocaleNavigator, type SupportedLocale } from "./locale";

export { type MessageKey, messages };
export * from "./locale";

let composerTranslate: ((key: MessageKey, values: Record<string, string | number>, plural?: number) => string) | null = null;
/** Test seam: component suites must not inherit a composer locale selected by an earlier suite. */
export function __resetComposerForTest(): void { composerTranslate = null; }

/** SPA translation goes through vue-i18n's composition-mode global composer. The plain fallback exists only for
 * isolated component tests before app setup; production always assigns `activeI18n` in createBrowserI18n(). */
export function translate(key: MessageKey, values: Record<string, string | number> = {}, plural?: number): string {
  if (composerTranslate) return composerTranslate(key, values, plural);
  return plainTranslate(DEFAULT_LOCALE, key, values, plural);
}

export function createBrowserI18n(search = globalThis.location?.search ?? "", nav: LocaleNavigator = globalThis.navigator): I18n {
  const i18n = createI18n({
    legacy: false,
    locale: selectLocale(search, nav),
    fallbackLocale: "en",
    messages
  });
  const globalT = i18n.global.t as unknown as (...args: unknown[]) => string;
  composerTranslate = (key, values, plural) => plural === undefined ? globalT(key, values) : globalT(key, plural, values);
  return i18n as I18n;
}

export function syncDocumentLanguage(locale: SupportedLocale, doc = globalThis.document): void {
  doc?.documentElement?.setAttribute("lang", htmlLanguage(locale));
  const manifest = typeof doc?.querySelector === "function"
    ? doc.querySelector<HTMLLinkElement>("#couchcoop-manifest") : null;
  if (manifest) manifest.href = locale === "en" ? "/manifest.webmanifest" : `/manifest.${locale}.webmanifest`;
}

export function installLocaleSync(i18n: I18n, win = globalThis.window, doc = globalThis.document): () => void {
  const update = (): void => {
    const locale = selectLocale(win?.location?.search ?? "", win?.navigator);
    if (typeof i18n.global.locale === "string") {
      i18n.global.locale = locale;
    } else {
      i18n.global.locale.value = locale;
    }
    syncDocumentLanguage(locale, doc);
  };
  update();
  win?.addEventListener("languagechange", update);
  return () => win?.removeEventListener("languagechange", update);
}

/** Plain, Vue-free catalog lookup for the public-origin bootstrap. */
export function plainTranslate(
  locale: SupportedLocale,
  key: MessageKey,
  values: Record<string, string | number> = {},
  plural?: number
): string {
  const message = messages[locale][key];
  const variant = plural === undefined ? message : message.split("|")[plural === 1 ? 1 : plural === 0 ? 0 : 2]?.trim() ?? message;
  return variant.replace(/\{(\w+)\}/g, (_whole, name: string) => String(values[name] ?? `{${name}}`));
}
