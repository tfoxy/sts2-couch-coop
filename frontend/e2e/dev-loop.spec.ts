import { expect, test } from "@playwright/test";

import { DEV_ORIGIN, DIRECT_WS_QUERY, RAW_TEST_RESOURCE_ROUTE } from "./ports";

// The Vite DEV ORIGIN, which is infrastructure rather than product: `npm run dev` must serve the same SPA the
// host serves, with HMR attached, and must proxy the game routes (`/ws`, `/res`, …) through to whatever
// `COUCHCOOP_DEV_PROXY_TARGET` points at — here the e2e harness, in real work a running game. Every leg below
// is about that plumbing; the join protocol itself is covered once, host-served, in mirror-session.spec.ts.
//
// Deliberately JOIN-FREE. These pages sit on the picker, so nothing here mutates the shared harness roster and
// nothing here can race the counted legs in mirror-session.spec.ts under `fullyParallel`.

test.describe.configure({ mode: "serial" });

test.beforeEach(({ }, testInfo) => {
  test.skip(testInfo.project.name !== "smoke", "dev-origin coverage only needs one browser project");
});

test("Vite dev origin serves the SPA with HMR client", async ({ page }) => {
  await page.goto(`${DEV_ORIGIN}/?name=Host`);

  await expect(page).toHaveURL(`${DEV_ORIGIN}/?name=Host`);
  await expect(page.locator("script[type='module'][src='/@vite/client']")).toHaveCount(1);
  await expect(page.getByTestId("mirror-surface")).toBeVisible();
});

test("Vite dev origin proxies same-origin WebSocket session frames", async ({ page }) => {
  await page.goto(`${DEV_ORIGIN}/`);

  // Opened from the PAGE, so it is a same-origin `ws://` to the dev server — which is the thing under test:
  // without the `ws: true` proxy entry this upgrade never reaches the harness at all. The `session` frame is
  // the first protocol message every client gets after the connection is admitted.
  const session = await page.evaluate(async (directWsQuery) => {
    const wsUrl = new URL("/ws", window.location.href);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.search = directWsQuery;

    return await new Promise<{ type?: string }>((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      const timeout = window.setTimeout(() => {
        socket.close();
        reject(new Error("Timed out waiting for a session frame through the dev proxy."));
      }, 5_000);

      socket.addEventListener("message", (event) => {
        const parsed = JSON.parse(String(event.data)) as { type?: string };
        if (parsed.type !== "session") return;
        window.clearTimeout(timeout);
        socket.close();
        resolve(parsed);
      });
      socket.addEventListener("error", () => {
        window.clearTimeout(timeout);
        reject(new Error("WebSocket connection failed."));
      });
    });
  }, DIRECT_WS_QUERY);

  expect(session).toMatchObject({ type: "session" });
});

test("Vite dev origin proxies raw Godot resources and explicit PNG rasters", async ({ request }) => {
  const response = await request.get(`${DEV_ORIGIN}${RAW_TEST_RESOURCE_ROUTE}`);

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("text/plain; charset=utf-8");
  expect(await response.text()).toBe('[gd_resource type="AtlasTexture" format=3]\n');

  const raster = await request.get(`${DEV_ORIGIN}${RAW_TEST_RESOURCE_ROUTE}?format=png`);
  expect(raster.status()).toBe(200);
  expect(raster.headers()["content-type"]).toBe("image/png");
  expect([...((await raster.body()).subarray(0, 8))]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test("Vite dev origin keeps the 16:9 game surface inside the viewport", async ({ page }) => {
  await page.goto(`${DEV_ORIGIN}/`);

  const viewport = page.viewportSize();
  const box = await page.getByTestId("mirror-surface").boundingBox();

  expect(viewport).not.toBeNull();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(viewport!.width);
  expect(box!.height).toBeLessThanOrEqual(viewport!.height);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
  expect(box!.width / box!.height).toBeCloseTo(16 / 9, 2);
});
