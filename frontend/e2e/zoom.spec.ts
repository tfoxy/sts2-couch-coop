import { expect, test, type Page } from "@playwright/test";

// Browser zoom must APPLY to the game instead of being refit away: under desktop
// zoom the surface keeps its 100%-zoom CSS size (zoomStableViewport pins it via
// the `--zoom-stable-*` vars) and #app pans the overflow; mobile pinch (visual-
// viewport zoom) never re-lays-out at all. Desktop zoom z is emulated the way it
// really behaves: CSS viewport ÷ z, deviceScaleFactor × z.
//
// The element under test is the mirror's root, which carries BOTH the shared `.game-surface` chrome class
// (whose `width`/`height` read the `--zoom-stable-*` vars — that is the whole mechanism) and its own
// `mirror-surface` testid. No join is needed: the pinning is layout, not content, so a bare URL sitting on the
// picker exercises exactly the same box and leaves the harness roster untouched for the parallel specs.
test.describe.configure({ mode: "serial" });

test.beforeEach(({ }, testInfo) => {
  test.skip(testInfo.project.name !== "smoke", "zoom behavior only needs one browser project");
});

async function setZoom(page: Page, zoom: number): Promise<void> {
  // The override only lives as long as its CDP session — never detach mid-test.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: Math.round(1280 / zoom),
    height: Math.round(720 / zoom),
    deviceScaleFactor: zoom,
    mobile: false
  });
}

const surfaceBox = (page: Page) =>
  page.evaluate(() => {
    const rect = document.querySelector("[data-testid='mirror-surface']")!.getBoundingClientRect();
    return { width: rect.width, height: rect.height, left: rect.left, top: rect.top };
  });

const appScroll = (page: Page) =>
  page.evaluate(() => {
    const app = document.getElementById("app")!;
    return {
      scrollWidth: app.scrollWidth,
      clientWidth: app.clientWidth,
      scrollHeight: app.scrollHeight,
      clientHeight: app.clientHeight,
      scrollLeft: app.scrollLeft,
      scrollTop: app.scrollTop
    };
  });

const zoomStableWidth = (page: Page) =>
  page.evaluate(() =>
    document.documentElement.style.getPropertyValue("--zoom-stable-width"));

test("desktop zoom enlarges the game and pans instead of refitting", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("mirror-surface")).toBeVisible();

  const baseline = await surfaceBox(page);
  expect(baseline.width).toBe(1280);
  expect(baseline.height).toBe(720);

  // 200% zoom: layout viewport halves, dpr doubles.
  await setZoom(page, 2);
  await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBe(2);
  await expect.poll(() => zoomStableWidth(page)).toBe("1280px");

  const zoomed = await surfaceBox(page);
  expect(zoomed.width).toBeCloseTo(1280, 0);
  expect(zoomed.height).toBeCloseTo(720, 0);

  // The surface overflows the 640×360 layout viewport; #app pans it, centered.
  const scroll = await appScroll(page);
  expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth);
  expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
  expect(scroll.scrollLeft).toBeCloseTo((scroll.scrollWidth - scroll.clientWidth) / 2, 0);
  expect(scroll.scrollTop).toBeCloseTo((scroll.scrollHeight - scroll.clientHeight) / 2, 0);
});

test("50% zoom shrinks and centers the game without scroll", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("mirror-surface")).toBeVisible();

  await setZoom(page, 0.5);
  await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBe(0.5);
  await expect.poll(() => zoomStableWidth(page)).toBe("1280px");

  const box = await surfaceBox(page);
  expect(box.width).toBeCloseTo(1280, 0);
  expect(box.height).toBeCloseTo(720, 0);
  // Centered inside the 2560×1440 layout viewport.
  expect(box.left).toBeCloseTo((2560 - 1280) / 2, 0);
  expect(box.top).toBeCloseTo((1440 - 720) / 2, 0);

  const scroll = await appScroll(page);
  expect(scroll.scrollWidth).toBe(scroll.clientWidth);
  expect(scroll.scrollHeight).toBe(scroll.clientHeight);
});

test("returning to 100% restores the exact legacy fill layout", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("mirror-surface")).toBeVisible();

  await setZoom(page, 2);
  await expect.poll(() => zoomStableWidth(page)).toBe("1280px");

  await setZoom(page, 1);
  await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBe(1);
  await expect.poll(() => zoomStableWidth(page)).toBe("");

  const box = await surfaceBox(page);
  expect(box.width).toBe(1280);
  expect(box.height).toBe(720);
  expect(box.left).toBe(0);
  expect(box.top).toBe(0);
});

test("mobile pinch (visual-viewport zoom) leaves the layout untouched", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("mirror-surface")).toBeVisible();

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });

  await expect.poll(() => page.evaluate(() => window.visualViewport!.scale)).toBe(2);
  expect(await zoomStableWidth(page)).toBe("");

  const box = await surfaceBox(page);
  expect(box.width).toBe(1280);
  expect(box.height).toBe(720);
  const scroll = await appScroll(page);
  expect(scroll.scrollWidth).toBe(scroll.clientWidth);

  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
});
