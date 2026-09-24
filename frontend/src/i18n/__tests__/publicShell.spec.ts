// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { bootLocale, bootText } from "@/boot/localize";

const root = process.cwd();
const read = (path: string): string => readFileSync(join(root, path), "utf8");

function selectInlineManifest(path: string, search: string, languages: string[]): { lang: string; href: string } {
  const script = read(path).match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error(`missing inline locale selector in ${path}`);
  const documentElement = { lang: "en" };
  const manifest = { href: "/manifest.webmanifest" };
  vm.runInNewContext(script, {
    URLSearchParams,
    location: { search },
    navigator: { languages, language: languages[0] ?? "" },
    document: { documentElement, getElementById: () => manifest }
  });
  return { lang: documentElement.lang, href: manifest.href };
}

function selectOfflineLanguage(search: string, languages: string[]): string {
  const selector = read("public/offline.html").match(/var query[\s\S]*?document\.title = text\.title;/)?.[0];
  if (!selector) throw new Error("missing offline locale selector");
  const documentElement = { lang: "en" };
  vm.runInNewContext(selector, {
    URLSearchParams,
    location: { search },
    navigator: { languages, language: languages[0] ?? "" },
    document: { documentElement, title: "" }
  });
  return documentElement.lang;
}

describe("public-origin localization shell", () => {
  it("uses the Vue-free bootstrap catalog for its immediately visible labels", () => {
    expect(bootLocale("", { languages: ["fr", "zh-CN", "en"] } as unknown as Navigator)).toBe("fr");
    expect(bootText("zh-Hans", "boot.starting")).toBe("正在启动…");
    expect(bootText("zh-Hans", "boot.connect")).toBe("连接游戏");
    expect(bootText("zh-Hans", "boot.gameAddress")).toBe("游戏地址");
  });

  it("keeps both HTML manifest selectors ordered and excludes Traditional Chinese", () => {
    for (const path of ["index.html", "pages/index.html"]) {
      const html = read(path);
      expect(html).toContain("for (var i = 0; i < tags.length; i += 1)");
      expect(html).not.toContain("tags.some(");
      expect(html).toContain('tag === "en" || tag.indexOf("en-") === 0) { locale = "en"; break; }');
      expect(html).toContain('"/manifest." + locale + ".webmanifest"');
    }
  });

  it("lets an invalid lang query fall through to ordered browser negotiation", () => {
    for (const path of ["index.html", "pages/index.html"]) {
      expect(selectInlineManifest(path, "?lang=fr", ["zh-CN", "en"]))
        .toEqual({ lang: "fr", href: "/manifest.fr.webmanifest" });
      expect(selectInlineManifest(path, "?lang=en", ["zh-CN"]))
        .toEqual({ lang: "en", href: "/manifest.webmanifest" });
    }
    expect(selectOfflineLanguage("?lang=fr", ["zh-CN", "en"])).toBe("zh-Hans");
    expect(selectOfflineLanguage("?lang=en", ["zh-CN"])).toBe("en");
  });

  it("ships bilingual offline recovery with ordered selection and a non-persisting Chinese manifest", () => {
    const offline = read("public/offline.html");
    expect(offline).toContain("for (var i = 0; i < tags.length; i += 1)");
    expect(offline).not.toContain("tags.some(");
    expect(offline).toContain("《杀戮尖塔2》主机没有响应");
    expect(offline).toContain('address: "此地址"');

    const manifest = JSON.parse(read("public/manifest.zh-Hans.webmanifest")) as Record<string, string>;
    expect(manifest.start_url).toBe("/");
    expect(manifest.id).toBe("/");
    expect(manifest.description).toContain("《杀戮尖塔2》");
    expect(read("pages/public/sw.js")).toContain('"/manifest.zh-Hans.webmanifest"');
  });
});
