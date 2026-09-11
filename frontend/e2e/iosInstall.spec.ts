import { expect, test } from "@playwright/test";

// `?iosInstall=force` (see @/join/joinModel's `isIosInstallForced`) pretends to be an iPhone-26 Safari tab
// with no element Fullscreen API, and arms the guided install overlay on load — there is no iPhone in this
// project's browser fleet, so this lever is the only way to drive the whole flow (steps → delayed escape →
// confirm → dismiss → re-open pill) end to end. Dismissal storage is REAL under the lever; only the platform
// gates are faked.
test.describe.configure({ mode: "serial" });

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "smoke", "iOS install flow only needs one browser project");
});

test("forced load shows the steps card with the escape link absent until the delay elapses", async ({ page }) => {
  await page.goto("/?iosInstall=force");

  const overlay = page.getByTestId("ios-install-overlay");
  await expect(overlay).toBeVisible();
  await expect(page.getByText("Add CouchCoop to your Home Screen")).toBeVisible();
  await expect(page.getByTestId("ios-install-stay")).toHaveCount(0);

  // Real 3s delay — no fake timers available in a browser context.
  await expect(page.getByTestId("ios-install-stay")).toBeVisible({ timeout: 5_000 });
});

test("the escape link leads to confirm, not straight out, and back-to-steps returns", async ({ page }) => {
  await page.goto("/?iosInstall=force");

  await expect(page.getByTestId("ios-install-stay")).toBeVisible({ timeout: 5_000 });
  await page.getByTestId("ios-install-stay").click();

  await expect(page.getByText("Stay in the browser tab?")).toBeVisible();
  await expect(page.getByTestId("ios-install-overlay")).toBeVisible();

  await page.getByTestId("ios-install-back").click();
  await expect(page.getByText("Add CouchCoop to your Home Screen")).toBeVisible();
  // Already revealed once this open — no re-imposed delay on return.
  await expect(page.getByTestId("ios-install-stay")).toBeVisible();
});

test("dismissing (without ticking the checkbox) closes it and the re-open pill brings it straight back", async ({
  page
}) => {
  await page.goto("/?iosInstall=force");

  await expect(page.getByTestId("ios-install-stay")).toBeVisible({ timeout: 5_000 });
  await page.getByTestId("ios-install-stay").click();
  await page.getByTestId("ios-install-confirm-stay").click();

  await expect(page.getByTestId("ios-install-overlay")).toHaveCount(0);
  const pill = page.getByTestId("ios-install-button");
  await expect(pill).toBeVisible();
  await expect(page.getByTestId("fullscreen-button")).toHaveCount(0);

  await pill.click();

  // Manual (pill) reopen shows the escape link immediately — no delay.
  await expect(page.getByTestId("ios-install-overlay")).toBeVisible();
  await expect(page.getByTestId("ios-install-stay")).toBeVisible();
});
