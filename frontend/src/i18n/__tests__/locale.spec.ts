import { afterEach, describe, expect, it } from "vitest";

import { __resetComposerForTest, createBrowserI18n, installLocaleSync, plainTranslate, translate } from "@/i18n";
import { en, messages } from "@/i18n/messages";
import { negotiateLocale, localeOverride, selectLocale, supportedLocaleFor } from "@/i18n/locale";

describe("browser locale negotiation", () => {
  it("uses navigator.languages in order before navigator.language", () => {
    expect(negotiateLocale({ languages: ["fr-FR", "zh_SG"], language: "en-US" })).toBe("fr");
    expect(negotiateLocale({ languages: ["zh-TW", "en-GB"], language: "zh-CN" })).toBe("en");
    expect(negotiateLocale({ languages: ["fr", "zh-CN", "en"] })).toBe("fr");
    expect(negotiateLocale({ languages: ["fr", "en", "zh-CN"] })).toBe("fr");
  });

  it("accepts Simplified aliases and never maps Traditional Chinese to Simplified", () => {
    for (const tag of ["zh", "ZH_cn", "zh-SG", "zh-Hans"]) expect(supportedLocaleFor(tag)).toBe("zh-Hans");
    for (const tag of ["zh-TW", "zh-HK", "zh-MO", "zh-Hant"]) expect(supportedLocaleFor(tag)).toBeNull();
  });

  it("falls back to English with absent globals and accepts only the QA override", () => {
    expect(negotiateLocale()).toBe("en");
    expect(localeOverride("?lang=zh-Hans")).toBe("zh-Hans");
    expect(localeOverride("?lang=zh-cn")).toBeNull();
    expect(localeOverride("?lang=es-419")).toBe("es-419");
    expect(selectLocale("?lang=en", { languages: ["zh-CN"] })).toBe("en");
    expect(selectLocale("?lang=fr", { languages: ["zh-CN"] })).toBe("fr");
    expect(supportedLocaleFor("es-MX")).toBe("es-419");
    expect(supportedLocaleFor("es-ES")).toBe("es-ES");
    expect(supportedLocaleFor("pt-PT")).toBeNull();
  });

  it("updates Vue and the html language on languagechange", () => {
    const listeners = new Map<string, () => void>();
    const win = {
      location: { search: "" },
      navigator: { languages: ["en"] },
      addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
      removeEventListener: (name: string) => listeners.delete(name)
    };
    const attrs = new Map<string, string>();
    const manifest = { href: "" };
    const i18n = { global: { locale: { value: "en" } } };
    const dispose = installLocaleSync(i18n as never, win as never, {
      documentElement: { setAttribute: (n: string, v: string) => attrs.set(n, v) },
      querySelector: () => manifest
    } as never);
    win.navigator.languages = ["zh-CN"];
    listeners.get("languagechange")?.();
    expect(i18n.global.locale.value).toBe("zh-Hans");
    expect(attrs.get("lang")).toBe("zh-Hans");
    expect(manifest.href).toBe("/manifest.zh-Hans.webmanifest");
    dispose();
  });
});

describe("catalogue integrity", () => {
  it("has exact nonblank key and placeholder parity", () => {
    expect(Object.keys(messages)).toHaveLength(14);
    for (const catalog of Object.values(messages)) {
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(en).sort());
      for (const key of Object.keys(en) as Array<keyof typeof en>) {
        expect(en[key].trim(), key).not.toBe("");
        expect(catalog[key].trim(), key).not.toBe("");
        expect([...en[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort())
          .toEqual([...catalog[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort());
      }
    }
  });

  // The parity above reads `messages`, i.e. AFTER preservePlaceholders, which drops an unknown token and appends
  // the English one — and whose ASCII `\w` never even sees `{値}`, so that token rendered literally. Every
  // catalogue once shipped translated token names past it ({Wert}, {rótulo}, {ラベル}). Assert on what ships.
  it("ships every placeholder under its English name, in any alphabet", () => {
    const raw = import.meta.glob<Record<string, string>>("../catalogs/*.json", { eager: true, import: "default" });
    expect(Object.keys(raw)).toHaveLength(12);
    const tokens = (text: string) => [...new Set([...text.matchAll(/\{([^\s{}]+)\}/g)].map((match) => match[1]))].sort();
    for (const [file, catalog] of Object.entries({ ...raw, zhHans: messages["zh-Hans"] })) {
      for (const key of Object.keys(en) as Array<keyof typeof en>) {
        expect(tokens(catalog[key] ?? ""), `${file} ${key}`).toEqual(tokens(en[key]));
      }
    }
  });

  it("interpolates plain bootstrap strings without Vue", () => {
    expect(plainTranslate("zh-Hans", "picker.joinAs", { name: "Ada" })).toContain("Ada");
    expect(messages.en["picker.controllers"]).toContain("{count}");
  });

  it("uses vue-i18n composition interpolation and plural rules in the SPA", () => {
    const i18n = createBrowserI18n("?lang=zh-Hans", { languages: ["en"] });
    expect(translate("picker.controllers", { count: 1 }, 1)).toBe("1 个控制器");
    (i18n.global.locale as { value: string }).value = "en";
    expect(translate("picker.controllers", { count: 2 }, 2)).toBe("2 controllers");
  });
});
afterEach(() => {
  __resetComposerForTest();
});
