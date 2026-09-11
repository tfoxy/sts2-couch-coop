/** Browser locale selection.  This module deliberately has no Vue or DOM dependency. */
export type SupportedLocale = "en" | "zh-Hans" | "de" | "es-419" | "fr" | "it" | "ja" | "ko" | "pl" | "pt-BR" | "ru" | "es-ES" | "th" | "tr";

export const DEFAULT_LOCALE: SupportedLocale = "en";

/** Normalise enough BCP-47 for browser supplied tags without pretending to support every locale. */
export function normaliseLocaleTag(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const tag = value.trim().replace(/_/g, "-").toLowerCase();
  return tag || null;
}

/** Returns a supported locale, or null when the tag must be skipped. */
export function supportedLocaleFor(value: string | null | undefined): SupportedLocale | null {
  const tag = normaliseLocaleTag(value);
  if (!tag) return null;
  if (tag === "en" || tag.startsWith("en-")) return "en";
  if (tag === "zh" || tag === "zh-cn" || tag === "zh-sg" || tag === "zh-hans") return "zh-Hans";
  if (tag === "de" || tag.startsWith("de-")) return "de";
  if (tag === "fr" || tag.startsWith("fr-")) return "fr";
  if (tag === "it" || tag.startsWith("it-")) return "it";
  if (tag === "ja" || tag.startsWith("ja-")) return "ja";
  if (tag === "ko" || tag.startsWith("ko-")) return "ko";
  if (tag === "pl" || tag.startsWith("pl-")) return "pl";
  if (tag === "ru" || tag.startsWith("ru-")) return "ru";
  if (tag === "th" || tag.startsWith("th-")) return "th";
  if (tag === "tr" || tag.startsWith("tr-")) return "tr";
  if (tag === "pt" || tag === "pt-br") return "pt-BR";
  if (tag === "es" || tag === "es-es") return "es-ES";
  if (tag === "es-419" || tag === "es-us" || /^(es-(ar|bo|cl|co|cr|cu|do|ec|gt|hn|mx|ni|pa|pe|pr|py|sv|uy|ve))$/.test(tag)) return "es-419";
  // In particular, do not silently turn Traditional Chinese into Simplified Chinese.
  return null;
}

export interface LocaleNavigator {
  languages?: readonly string[] | null;
  language?: string | null;
}

/** Browser preference order matters: navigator.languages before its legacy singular fallback. */
export function negotiateLocale(navigatorLike?: LocaleNavigator | null): SupportedLocale {
  const candidates = [
    ...(navigatorLike?.languages ?? []),
    navigatorLike?.language
  ];
  for (const candidate of candidates) {
    const locale = supportedLocaleFor(candidate);
    if (locale) return locale;
  }
  return DEFAULT_LOCALE;
}

/** QA-only override; it is intentionally not stored or copied into any host request. */
export function localeOverride(search: string | null | undefined): SupportedLocale | null {
  try {
    const value = new URLSearchParams(search ?? "").get("lang");
    return (["en", "zh-Hans", "de", "es-419", "fr", "it", "ja", "ko", "pl", "pt-BR", "ru", "es-ES", "th", "tr"] as string[]).includes(value ?? "")
      ? value as SupportedLocale
      : null;
  } catch {
    return null;
  }
}

export function selectLocale(search: string | null | undefined, navigatorLike?: LocaleNavigator | null): SupportedLocale {
  return localeOverride(search) ?? negotiateLocale(navigatorLike);
}

export function htmlLanguage(locale: SupportedLocale): string {
  return locale;
}
