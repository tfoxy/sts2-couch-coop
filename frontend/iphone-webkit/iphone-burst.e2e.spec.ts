import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  assertSurvival,
  boundedQueryKeyNames,
  INTERNAL_ARTIFACT_ENV,
  resolveIphoneRunPlan,
  socketLifecycle,
  type SocketLifecycle,
  type SurvivalObservation,
  validateSharedIphoneSurvival
} from "./support";

const plan = resolveIphoneRunPlan(process.env);

test("iPhone WebKit survives the hosted burst after its first presented frame", async ({ page }, testInfo) => {
  const observation = observeSurvival(page);
  await page.goto("/");
  assertNotCrashed(observation);

  // A real run starts nothing and never clicks game controls. If a picker is present, a semantic host/seat
  // selector is the only permitted interaction. The hermetic harness exposes its synthetic Alice seat by testid;
  // real mode has no arbitrary-seat fallback and selects only the roster's semantic host marker.
  const picker = page.getByTestId("player-picker");
  if (plan.kind === "hermetic") {
    const seat = picker.getByTestId("iphone-burst-seat");
    await expect(picker).toBeVisible({ timeout: 10_000 });
    await expect(seat).toBeVisible();
    await seat.click();
  } else if (await picker.isVisible().catch(() => false)) {
    const host = picker.locator('button[data-is-host="true"]');
    await expect(host).toBeVisible();
    await host.click();
  }

  const summary = await waitForFirstPresentedCheckpoint(page, observation);
  const animationFrames = await waitForResponsiveSeconds(page, observation, 10);
  assertSurvival(observation, { requireSeat: plan.kind === "hermetic" });
  if (plan.kind === "hermetic") {
    if (!summary) throw new Error("The iPhone burst harness did not expose its payload-free lifecycle summary.");
    await validateSharedIphoneSurvival({
      presentations: summary.presentations,
      acks: summary.sceneAcks,
      hostSocketOpen: summary.hostSocketOpen && socketIsOpen(observation, "host"),
      seatSocketOpen: summary.seatSocketOpen && socketIsOpen(observation, "seat"),
      viewError: summary.viewError,
      animationFrames,
      responsive: observation.responsiveSeconds >= 10,
      crash: observation.pageCrashed
    });
    await writeSanitizedHermeticArtifacts(observation, summary, animationFrames, testInfo);
  }

  // URL query values may carry player names or machine-local capability choices. Logs expose names only.
  console.log(`[iphone-webkit] url query keys: ${boundedQueryKeyNames(page.url()).join(",") || "(none)"}`);
  for (const socket of observation.sockets) {
    console.log(`[iphone-webkit] ws ${socket.role} lifecycle: ${socket.closed ? "closed" : "open"}; query keys=${socket.queryKeys.join(",") || "(none)"}`);
  }
  if (observation.pageErrorCategories.length) {
    console.log(`[iphone-webkit] sanitized page errors: ${observation.pageErrorCategories.join(",")}`);
  }

  if (plan.kind === "real" && plan.evidenceEnabled) {
    await saveExplicitLocalEvidence(page, testInfo);
  }
});

function observeSurvival(page: Page): SurvivalObservation {
  const observation: SurvivalObservation = {
    presented: false,
    responsiveSeconds: 0,
    pageCrashed: false,
    pageErrorCategories: [],
    sockets: []
  };
  page.on("crash", () => { observation.pageCrashed = true; });
  page.on("pageerror", () => addCategory(observation, "pageerror"));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") addCategory(observation, `console:${message.type()}`);
  });
  page.on("websocket", (socket) => {
    const lifecycle = socketLifecycle(socket.url(), plan.baseURL);
    observation.sockets.push(lifecycle);
    // Intentionally no frame sent/received listeners: browser-frame payloads are not test artifacts.
    socket.on("close", () => { lifecycle.closed = true; });
  });
  return observation;
}

function addCategory(observation: SurvivalObservation, category: string): void {
  if (!observation.pageErrorCategories.includes(category)) observation.pageErrorCategories.push(category);
}

function assertNotCrashed(observation: SurvivalObservation): void {
  if (observation.pageCrashed) throw new Error("iPhone WebKit page crashed.");
}

async function waitForFirstPresentedCheckpoint(
  page: Page,
  observation: SurvivalObservation
): Promise<NonNullable<Awaited<ReturnType<typeof readHarnessSummary>>> | null> {
  if (plan.kind === "real") {
    await expect(page.getByTestId("mirror-frame")).toBeVisible({ timeout: 20_000 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assertNotCrashed(observation);
    observation.presented = true;
    return null;
  }
  const deadline = Date.now() + 20_000;
  let lastSummary: Awaited<ReturnType<typeof readHarnessSummary>> = null;
  while (Date.now() < deadline) {
    assertNotCrashed(observation);
    const summary = await readHarnessSummary(page);
    lastSummary = summary;
    if (summary && summary.presentations >= 2) {
      observation.presented = true;
      return summary;
    }
    await page.waitForTimeout(100);
  }
  const sockets = observation.sockets.map((socket) => `${socket.role}:${socket.closed ? "closed" : "open"}`).join(",");
  throw new Error(`The iPhone burst harness did not report two presented-frame checkpoints (summary=${JSON.stringify(lastSummary)}, sockets=${sockets || "none"}, errors=${observation.pageErrorCategories.join(",") || "none"}).`);
}

async function waitForResponsiveSeconds(page: Page, observation: SurvivalObservation, seconds: number): Promise<number> {
  let animationFrames = 0;
  for (let second = 0; second < seconds; second++) {
    animationFrames += await page.evaluate(() => new Promise<number>((resolve) => {
      let frames = 0;
      const started = performance.now();
      const tick = () => {
        frames++;
        if (performance.now() - started >= 1_000) resolve(frames);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }));
    assertNotCrashed(observation);
    observation.responsiveSeconds++;
  }
  return animationFrames;
}

async function readHarnessSummary(page: Page): Promise<{
  sceneAcks: number;
  presentations: number;
  viewError: boolean;
  hostSocketOpen: boolean;
  seatSocketOpen: boolean;
} | null> {
  const response = await page.request.get("/__couchcoop/lifecycle/summary");
  if (response.status() === 404) return null;
  expect(response.ok()).toBe(true);
  const body = await response.json() as Record<string, unknown>;
  if (!Number.isSafeInteger(body.sceneAcks) || !Number.isSafeInteger(body.presentations)
    || typeof body.viewError !== "boolean" || typeof body.hostSocketOpen !== "boolean" || typeof body.seatSocketOpen !== "boolean") {
    throw new Error("The iPhone lifecycle summary must contain sanitized counts and socket/view-error booleans.");
  }
  return {
    sceneAcks: body.sceneAcks,
    presentations: body.presentations,
    viewError: body.viewError,
    hostSocketOpen: body.hostSocketOpen,
    seatSocketOpen: body.seatSocketOpen
  };
}

function socketIsOpen(observation: SurvivalObservation, role: SocketLifecycle["role"]): boolean {
  return observation.sockets.some((socket) => socket.role === role && !socket.closed);
}

async function saveExplicitLocalEvidence(page: Page, testInfo: TestInfo): Promise<void> {
  // The config forces outputDir under .sts2/research/playwright-iphone-webkit only when the separate local
  // evidence flag is set. The label makes the capture's potentially proprietary status unambiguous.
  const label = testInfo.outputPath("POTENTIALLY_PROPRIETARY.txt");
  await testInfo.attach("POTENTIALLY_PROPRIETARY", { body: "Potentially proprietary real-game evidence.\n", contentType: "text/plain" });
  await page.screenshot({ path: testInfo.outputPath("presented-frame.png") });
  await import("node:fs/promises").then(({ writeFile }) => writeFile(label, "Potentially proprietary real-game evidence.\n"));
}

async function writeSanitizedHermeticArtifacts(
  observation: SurvivalObservation,
  summary: { sceneAcks: number; presentations: number; viewError: boolean; hostSocketOpen: boolean; seatSocketOpen: boolean },
  animationFrames: number,
  testInfo: TestInfo
): Promise<void> {
  const artifactDir = testInfo.project.metadata[INTERNAL_ARTIFACT_ENV];
  if (typeof artifactDir !== "string" || !artifactDir) return;
  await writeFile(join(artifactDir, "iphone-webkit-result.json"), `${JSON.stringify({
    presentations: summary.presentations,
    acks: summary.sceneAcks,
    animationFrames,
    responsive: observation.responsiveSeconds >= 10,
    crash: observation.pageCrashed,
    viewError: summary.viewError,
    hostSocketOpen: summary.hostSocketOpen,
    seatSocketOpen: summary.seatSocketOpen,
    pageErrorCategories: observation.pageErrorCategories
  })}\n`);
  await writeFile(join(artifactDir, "iphone-webkit-timeline.json"), `${JSON.stringify(observation.sockets.map((socket) => ({
    role: socket.role,
    closed: socket.closed,
    queryKeys: socket.queryKeys
  }))) }\n`);
}
