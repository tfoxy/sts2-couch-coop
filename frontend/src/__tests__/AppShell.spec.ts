import { readFileSync } from "node:fs";
import { join } from "node:path";

import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "@/App.vue";
import packageJson from "../../package.json";

const styles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
const sockets: MockWebSocket[] = [];

class MockWebSocket extends EventTarget {
  sent: string[] = [];
  url: string;

  constructor(url: string) {
    super();
    this.url = url;
    sockets.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  send(message: string) {
    this.sent.push(message);
  }

  close() {
    this.dispatchEvent(new Event("close"));
  }

  emitMessage(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  sockets.length = 0;
  sessionStorage.clear();
  localStorage.clear();
  document.body.innerHTML = "";
  // Reset the page URL so the next mount starts unaffiliated.
  window.history.replaceState(null, "", "/");
  delete (window as unknown as { __mirrorSendInput?: unknown }).__mirrorSendInput;
});

describe("App shell", () => {
  it("renders the mirror client by default", () => {
    const wrapper = mount(App);

    expect(wrapper.find('[data-testid="mirror-surface"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="mirror-mode-toggle"]').exists()).toBe(false);
  });

  it("renders Mirror at the canonical root", () => {
    window.history.replaceState(null, "", "/");
    const wrapper = mount(App);

    expect(wrapper.find('[data-testid="mirror-surface"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="mirror-mode-toggle"]').exists()).toBe(false);
  });

  it("reads no view parameter at all", () => {
    // The structural half of the rule above, and the stronger one: the loop can only ever exercise values
    // someone thought to list, whereas this fails the moment a `view` branch comes BACK — which is the actual
    // regression (a second client re-entering through the shell), not any particular spelling of it.
    const shell = readFileSync(join(process.cwd(), "src/App.vue"), "utf8");
    const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(shell)?.[1] ?? "";
    const code = script.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/URLSearchParams|location\.search|\bview\b/);
  });

  it("fills the window without zoom-breaking viewport units", () => {
    // The scene's aspect-ratio fit + letterbox is owned by the mirror's own stage; the surface fills the
    // window at 100% zoom and is pinned to that size by zoomStableViewport under browser zoom (so zoom
    // enlarges the game instead of refitting it). No 100vw/100vh — viewport units would bypass both the
    // `%` chain and the `--zoom-stable-*` override.
    expect(styles).toContain(".game-surface");
    expect(styles).not.toMatch(/100vw|100vh/);
  });

  it("does not install or require a routing dependency", () => {
    const routerPackageName = ["vue", "router"].join("-");
    const dependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies
    };

    expect(dependencies).not.toHaveProperty(routerPackageName);
    expect(JSON.stringify(packageJson.scripts)).not.toContain(routerPackageName);
  });
});
