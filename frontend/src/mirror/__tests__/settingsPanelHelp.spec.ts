import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import SettingsPanel from "@/mirror/SettingsPanel.vue";
import { __resetComposerForTest, createBrowserI18n } from "@/i18n";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import type { MirrorLatency } from "@/mirror/mirrorClient";

// The panel's per-row "?" tips (SettingsHelpTip), which replaced the permanent note paragraphs. What is pinned
// here is the BEHAVIOR a screenshot can't show: every row explains itself, exactly one tip is open at a time, and
// it closes on an outside press, on scroll and when the panel closes. (The ≥28px hit target and the bubble's
// placement are CSS, which jsdom does not compute — those are verified by eye, not here.)

const latency: MirrorLatency = {
  lastMs: 28,
  p50: 12,
  p95: 30,
  count: 7,
  gameLastMs: null,
  gameP50: null,
  gameP95: null,
  gameCount: 0
};

// Every row the panel offers, in DOM order: the 16 controls plus the two latency readouts. `repro` is the one
// row that a BUILD can remove (VITE_REPRO_UI=off, see buildFlags) — it is listed here because vitest runs with
// the flag unset, i.e. as the local/dev build that ships it.
const HELP_IDS = [
  "quality",
  "shaders",
  "particles",
  "staticBg",
  "stretch",
  "raiseCard",
  "unfocus",
  "tapFocus",
  "confirmTap",
  "raiseHand",
  "uiScaling",
  "backstop",
  "repro",
  "refreshRate",
  "tweenReplay",
  "freezeParticles",
  "freezeSpines",
  "freezeDecor",
  "networkRtt",
  "gameRtt",
  "latencyOverlay"
] as const;

function mountPanel(): VueWrapper {
  return mount(SettingsPanel, { props: { latency }, attachTo: document.body });
}

function tip(wrapper: VueWrapper, id: string) {
  return wrapper.get(`[data-testid="mirror-help-${id}"]`);
}

function bubbleExists(wrapper: VueWrapper, id: string): boolean {
  return wrapper.find(`[data-testid="mirror-help-bubble-${id}"]`).exists();
}

beforeEach(() => {
  mirrorSettings.panelOpen = true;
});

afterEach(() => {
  mirrorSettings.panelOpen = false;
  __resetComposerForTest();
});

describe("SettingsPanel — per-row help tips", () => {
  it("renders Chinese headings and the complete Chinese help through the active composition locale", async () => {
    createBrowserI18n("?lang=zh-Hans", { languages: ["en"] });
    const wrapper = mountPanel();
    expect(wrapper.text()).toContain("本设备");
    expect(wrapper.text()).toContain("串流（此玩家）");
    expect(wrapper.text()).toContain("游戏（端到端）");
    expect(wrapper.text()).toContain("（高级）");
    await tip(wrapper, "confirmTap").trigger("click");
    expect(wrapper.get('[data-testid="mirror-help-bubble-confirmTap"]').text()).toContain("双击绝不会花掉一项奖励");
    wrapper.unmount();
  });

  // The heading used to be `app.mirror` + `common.settings`, which read "Spiegel Einstellungen": word order
  // belongs to the language, so the whole heading is one key.
  it("titles the panel from one heading key, in the language's own word order", () => {
    createBrowserI18n("?lang=de", { languages: ["en"] });
    const wrapper = mountPanel();
    expect(wrapper.get(".settings-heading").text()).toBe("Spiegel-Einstellungen");
    wrapper.unmount();
  });

  it("gives EVERY row a tip, and every tip a real description", () => {
    const wrapper = mountPanel();
    const buttons = wrapper.findAll("[data-testid^='mirror-help-']:not([data-testid^='mirror-help-bubble'])");
    expect(buttons).toHaveLength(HELP_IDS.length);
    for (const id of HELP_IDS) {
      const button = tip(wrapper, id);
      // Named for screen readers, and collapsed until asked.
      expect(button.attributes("aria-label")).toMatch(/^About /);
      expect(button.attributes("aria-expanded")).toBe("false");
    }
    wrapper.unmount();
  });

  it("shows a sentence or three of real help text for each row", async () => {
    const wrapper = mountPanel();
    for (const id of HELP_IDS) {
      await tip(wrapper, id).trigger("click");
      const text = wrapper.get(`[data-testid="mirror-help-bubble-${id}"]`).text();
      expect(text.length).toBeGreaterThan(40); // never a placeholder or a bare label echo
      expect(text).toMatch(/\.$/);
    }
    wrapper.unmount();
  });

  it("opens on tap, closes on a second tap, and keeps only ONE open at a time", async () => {
    const wrapper = mountPanel();
    expect(bubbleExists(wrapper, "shaders")).toBe(false);

    await tip(wrapper, "shaders").trigger("click");
    expect(bubbleExists(wrapper, "shaders")).toBe(true);
    expect(tip(wrapper, "shaders").attributes("aria-expanded")).toBe("true");

    // A DIFFERENT row's icon swaps the open tip rather than leaving two up.
    await tip(wrapper, "particles").trigger("click");
    expect(bubbleExists(wrapper, "shaders")).toBe(false);
    expect(bubbleExists(wrapper, "particles")).toBe(true);

    await tip(wrapper, "particles").trigger("click");
    expect(bubbleExists(wrapper, "particles")).toBe(false);
    wrapper.unmount();
  });

  it("closes on a press anywhere outside the help UI", async () => {
    const wrapper = mountPanel();
    await tip(wrapper, "stretch").trigger("click");
    expect(bubbleExists(wrapper, "stretch")).toBe(true);

    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(bubbleExists(wrapper, "stretch")).toBe(false);
    wrapper.unmount();
  });

  it("closes when the panel is scrolled (the bubble is anchored to its row)", async () => {
    const wrapper = mountPanel();
    await tip(wrapper, "backstop").trigger("click");
    expect(bubbleExists(wrapper, "backstop")).toBe(true);

    await wrapper.get('[data-testid="mirror-settings-panel"]').trigger("scroll");
    expect(bubbleExists(wrapper, "backstop")).toBe(false);
    wrapper.unmount();
  });

  it("closes when the panel itself closes — re-opening shows no stale bubble", async () => {
    const wrapper = mountPanel();
    await tip(wrapper, "tweenReplay").trigger("click");
    expect(bubbleExists(wrapper, "tweenReplay")).toBe(true);

    mirrorSettings.panelOpen = false; // the gear, which lives outside this component
    await wrapper.vm.$nextTick();
    mirrorSettings.panelOpen = true;
    await wrapper.vm.$nextTick();

    expect(bubbleExists(wrapper, "tweenReplay")).toBe(false);
    wrapper.unmount();
  });

  it("shows on MOUSE hover and hides on leave, without touching the tapped-open state", async () => {
    const wrapper = mountPanel();
    const button = tip(wrapper, "refreshRate");

    await button.trigger("pointerenter", { pointerType: "mouse" });
    expect(bubbleExists(wrapper, "refreshRate")).toBe(true);
    // A hover is not an "open" tip: the icon still reports collapsed, so a following tap opens (not closes) it.
    expect(button.attributes("aria-expanded")).toBe("false");

    await button.trigger("pointerleave");
    expect(bubbleExists(wrapper, "refreshRate")).toBe(false);
    wrapper.unmount();
  });

  it("ignores the synthetic hover a TOUCH tap produces (no bubble stuck open after a tap)", async () => {
    const wrapper = mountPanel();
    const button = tip(wrapper, "tapFocus");

    await button.trigger("pointerenter", { pointerType: "touch" });
    expect(bubbleExists(wrapper, "tapFocus")).toBe(false);

    // The tap itself still opens it, and a later touch-leave can't close what the tap opened.
    await button.trigger("click");
    expect(bubbleExists(wrapper, "tapFocus")).toBe(true);
    await button.trigger("pointerleave");
    expect(bubbleExists(wrapper, "tapFocus")).toBe(true);
    wrapper.unmount();
  });

  it("pressing the tip icon does NOT toggle the checkbox the row belongs to", async () => {
    // The icon sits OUTSIDE the <label> (a click inside one activates its control), and stops the click anyway.
    mirrorSettings.stretchEnabled = true;
    const wrapper = mountPanel();
    await tip(wrapper, "stretch").trigger("click");
    expect(mirrorSettings.stretchEnabled).toBe(true);
    wrapper.unmount();
  });
});

describe("SettingsPanel — the inline notes it replaced", () => {
  it("drops the permanent explanation paragraphs (the panel's old height)", () => {
    const wrapper = mountPanel();
    const text = wrapper.text();
    expect(text).not.toContain("Static = frozen art");
    expect(text).not.toContain("Lower = less CPU");
    expect(text).not.toContain("While the map, deck or a reward screen is open, stop animating");
    // Exactly ONE note element survives — the dynamic host-performance one.
    expect(wrapper.findAll(".settings-group-note")).toHaveLength(1);
    wrapper.unmount();
  });

  it("KEEPS the dynamic host-performance warning, both wordings", async () => {
    const headless = mountPanel();
    expect(headless.get('[data-testid="mirror-host-perf-note"]').text()).toContain("Doesn't change what you see");
    headless.unmount();

    const direct = mount(SettingsPanel, { props: { latency, directView: true } });
    expect(direct.get('[data-testid="mirror-host-perf-note"]').text()).toContain(
      "freezing changes what the host sees"
    );
    direct.unmount();
  });
});
