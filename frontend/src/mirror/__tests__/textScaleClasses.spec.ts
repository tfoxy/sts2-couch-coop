import { afterEach, describe, expect, it } from "vitest";

import {
  buildTextScaleClassCss,
  installTextScaleSheet,
  resolveTextScaleClasses,
  ruleSpecificity,
  TEXT_SCALE_CLASS_PREFIX,
  TEXT_SCALE_RULES,
  TEXT_SCALE_STYLE_ID,
  __resetTextScaleSheetForTest
} from "@/mirror/textScaleClasses";

afterEach(() => {
  document.body.innerHTML = "";
  __resetTextScaleSheetForTest();
});

describe("resolved-class text scaling", () => {
  it("stamps matching rules once and leaves unmatched nodes class-free", () => {
    expect(resolveTextScaleClasses("res://scenes/ui/whatever.tscn", "Root/Thing")).toEqual([]);
    expect(resolveTextScaleClasses(null, null)).toEqual([]);
    expect(resolveTextScaleClasses("res://scenes/merchant/merchant_card.tscn", "Item/CardContainer/TitleLabel")).toEqual([
      `${TEXT_SCALE_CLASS_PREFIX}card-title`
    ]);
    expect(
      resolveTextScaleClasses("res://scenes/run.tscn", "Hud/MultiplayerPlayerContainer/P2/HealthBar/HpBarContainer/HpLabel")
    ).toEqual([`${TEXT_SCALE_CLASS_PREFIX}healthbar-hp`, `${TEXT_SCALE_CLASS_PREFIX}mp-run-hp`]);
  });

  it("installs one class-keyed sheet and contains no attribute selectors", () => {
    installTextScaleSheet();
    installTextScaleSheet();
    const sheets = document.querySelectorAll(`style#${TEXT_SCALE_STYLE_ID}`);
    expect(sheets).toHaveLength(1);
    expect(sheets[0].textContent).toContain(`.${TEXT_SCALE_CLASS_PREFIX}card-title`);
    expect(sheets[0].textContent).not.toContain("data-scene-node-path");
  });

  it("emits the base reset and each rule in CSS cascade order", () => {
    const css = buildTextScaleClassCss();
    expect(css.startsWith(".mirror-node { --godot-text-scale: 1; }")).toBe(true);
    for (const rule of TEXT_SCALE_RULES) {
      expect(css).toContain(`.${TEXT_SCALE_CLASS_PREFIX}${rule.key}`);
    }
    const byKey = new Map(TEXT_SCALE_RULES.map((rule, index) => [rule.key, { specificity: ruleSpecificity(rule), index }]));
    const emitted = [...css.matchAll(new RegExp(`\\.${TEXT_SCALE_CLASS_PREFIX}([a-z0-9-]+) \\{`, "g"))]
      .map((match) => match[1]);
    for (let i = 1; i < emitted.length; i++) {
      const previous = byKey.get(emitted[i - 1])!;
      const current = byKey.get(emitted[i])!;
      expect(previous.specificity < current.specificity || (previous.specificity === current.specificity && previous.index < current.index)).toBe(true);
    }
    expect(new Set(TEXT_SCALE_RULES.map((rule) => rule.key)).size).toBe(TEXT_SCALE_RULES.length);
  });
});
