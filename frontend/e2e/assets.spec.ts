import { expect, test } from "@playwright/test";

import { RAW_TEST_RESOURCE_ROUTE } from "./ports";

const cursorDefaultRoute = "/res/images/packed/common_ui/cursor_default.png";
const cursorPressedRoute = "/res/images/packed/common_ui/cursor_tilted.png";
const cursorStyleId = "game-cursor-style";

test("res route serves raw Godot resources and explicit PNG rasters", async ({ request }) => {
  const response = await request.get(RAW_TEST_RESOURCE_ROUTE);

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("text/plain; charset=utf-8");
  expect(response.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect(await response.text()).toBe('[gd_resource type="AtlasTexture" format=3]\n');

  const raster = await request.get(`${RAW_TEST_RESOURCE_ROUTE}?format=png`);
  expect(raster.status()).toBe(200);
  expect(raster.headers()["content-type"]).toBe("image/png");
  expect([...((await raster.body()).subarray(0, 8))]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // Scheme-prefixed keys (including the legacy escaped form) are rejected; model
  // assets ride /models/{path}, which mints the model:// key before hitting the seam.
  const invalid = await request.get("/res/model%3A%2F%2Fcharacters%2Fironclad%2Ficon");
  expect(invalid.status()).toBe(400);

  const legacyEscaped = await request.get("/res/res%3A%2F%2Ftest-resource.tres");
  expect(legacyEscaped.status()).toBe(400);

  const modelKey = await request.get("/models/characters/ironclad/icon");
  expect(modelKey.status()).toBe(404);
  expect((await modelKey.json()).value).toBe("model://characters/ironclad/icon");

  const missing = await request.get("/res/unknown/asset");
  expect(missing.status()).toBe(404);
  expect(await missing.json()).toEqual({
    type: "error",
    requestId: "http",
    code: "missing-asset",
    message: "Asset was not found.",
    field: "key",
    value: "res://unknown/asset",
    notices: [
      {
        code: "missing-asset",
        severity: "error",
        message: "Fake provider has no asset for this key.",
        path: "key"
      }
    ]
  });
});

test("favicon and cursor resources come from the hosted game resource route", async ({ request }) => {
  const favicon = await request.get("/favicon.ico");
  expect(favicon.status()).toBe(200);
  expect(favicon.headers()["content-type"]).toBe("image/x-icon");
  expect(favicon.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");

  for (const route of [cursorDefaultRoute, cursorPressedRoute]) {
    const response = await request.get(route);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");
    expect(response.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
  }
});

test("pressed cursor is worn inline by the element under the pointer, never the document", async ({ page }) => {
  await page.goto("/");

  const html = page.locator("html");

  await expect(html).toHaveClass(/game-cursor/);

  // The DEFAULT cursor is themed by a runtime-injected stylesheet mapping the root
  // selectors to a native `cursor: url(...)`. (The crop+downscale to a <=32px data
  // URL is covered by the computeCursorCrop unit tests; the fake asset provider may
  // serve a stub that does not decode, in which case processing falls back to the
  // raw resource URL — either way the cursor is themed.)
  const cursorStyle = page.locator(`style#${cursorStyleId}`);
  await expect(cursorStyle).toHaveCount(1);
  await expect(async () => {
    const css = (await cursorStyle.textContent()) ?? "";
    expect(css).toContain(".game-cursor *");
    expect(css.match(/cursor: url\(/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
  }).toPass();

  // The PRESSED cursor is an inline `cursor` on exactly the element under the pointer
  // — never a root class, which would restyle every element in the document per tap
  // (the ~594ms/tap style recalc a phone trace measured before the change). Retried
  // as a whole cycle because the pressed image finishes processing asynchronously.
  const wornCount = () =>
    page.evaluate(
      () =>
        Array.from(document.querySelectorAll<HTMLElement>("[style*='cursor']")).filter((el) =>
          el.style.cursor.includes("url(")
        ).length
    );
  await page.mouse.move(320, 180);
  await expect(async () => {
    await page.mouse.down();
    try {
      expect(await wornCount()).toBe(1);
      await expect(html).not.toHaveClass(/game-cursor-pressed/);
    } finally {
      await page.mouse.up();
    }
  }).toPass();

  // Release takes the inline cursor off again; the stylesheet never carried a pressed rule.
  expect(await wornCount()).toBe(0);
  expect((await cursorStyle.textContent()) ?? "").not.toContain("game-cursor-pressed");
});
