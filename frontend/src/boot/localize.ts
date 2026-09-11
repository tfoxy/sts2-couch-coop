// The public-origin bootstrap cannot import Vue. It shares only the plain catalog and locale negotiation layer.
import { messages, type MessageKey } from "@/i18n/messages";
import { selectLocale, type SupportedLocale } from "@/i18n/locale";

export function bootLocale(search = globalThis.location?.search ?? "", nav = globalThis.navigator): SupportedLocale {
  return selectLocale(search, nav);
}

export function bootText(locale: SupportedLocale, key: MessageKey, values: Record<string, string | number> = {}): string {
  return messages[locale][key].replace(/\{(\w+)\}/g, (_whole, name: string) => String(values[name] ?? `{${name}}`));
}
