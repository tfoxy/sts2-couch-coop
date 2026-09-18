import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  assertSurvival,
  boundedQueryKeyNames,
  classifySharedIphoneFailure,
  INTERNAL_ARTIFACT_ENV,
  resolveIphoneRunPlan,
  socketLifecycle,
  type SocketLifecycle,
  type SurvivalObservation,
  validateSharedIphoneSurvival
} from "./support";

const plan = resolveIphoneRunPlan(process.env);

test.afterEach(async ({ page }, testInfo) => {
  const artifactDir = testInfo.project.metadata[INTERNAL_ARTIFACT_ENV];
  if (plan.kind !== "hermetic" || testInfo.status === testInfo.expectedStatus || typeof artifactDir !== "string") return;
  await page.screenshot({ path: join(artifactDir, "iphone-webkit-failure.png") }).catch(() => {});
});

test("iPhone WebKit survives the selected hosted burst after its final delta", async ({ page }, testInfo) => {
  const observation = observeSurvival(page);
  try {
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

  const firstSummary = await waitForFirstPresentedCheckpoint(page, observation);
  const summary = plan.kind === "hermetic" ? await waitForFinalCheckpoint(page, observation) : firstSummary;
  const animationFrames = await waitForResponsiveSeconds(page, observation, 10);
  let separateTrivialEval = false;
  try {
    separateTrivialEval = await page.evaluate(() => document.readyState === "complete" && 2 + 2 === 4);
  } catch {
    observation.scriptUnresponsive = true;
    throw new Error("The separate post-delta script evaluation did not respond.");
  }
  if (!separateTrivialEval) observation.scriptUnresponsive = true;
  expect(separateTrivialEval).toBe(true);
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
      crash: observation.pageCrashed,
      requiredMessages: expectedMessages()
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
  } catch (error) {
    if (plan.kind === "hermetic") await writeSanitizedHermeticFailure(observation, testInfo);
    throw error;
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
  page.on("close", () => { observation.pageClosed = true; });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && observation.presented) observation.unexpectedNavigation = true;
  });
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
  const nonce = await diagnosticNonce(page);
  if (!nonce) throw new Error("The iPhone burst harness did not provide a diagnostic visit.");
  observation.lockedDiagnosticNonce = nonce;
  const deadline = Date.now() + 20_000;
  let lastSummary: Awaited<ReturnType<typeof readHarnessSummary>> = null;
  while (Date.now() < deadline) {
    assertNotCrashed(observation);
    await assertLockedNonce(page, nonce, observation);
    const summary = await readHarnessSummary(page, nonce);
    lastSummary = summary;
    rememberSummary(observation, summary);
    if (summary && summary.presentations >= 1 && summary.journeyValid) {
      observation.presented = true;
      return summary;
    }
    await page.waitForTimeout(100);
  }
  const sockets = observation.sockets.map((socket) => `${socket.role}:${socket.closed ? "closed" : "open"}`).join(",");
  throw new Error(`The iPhone burst harness did not report the final presented-frame checkpoint (summary=${JSON.stringify(lastSummary)}, sockets=${sockets || "none"}, errors=${observation.pageErrorCategories.join(",") || "none"}).`);
}

async function waitForFinalCheckpoint(page: Page, observation: SurvivalObservation): Promise<NonNullable<Awaited<ReturnType<typeof readHarnessSummary>>>> {
  const nonce = observation.lockedDiagnosticNonce;
  if (!nonce) throw new Error("No diagnostic visit was locked at first presentation.");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await assertLockedNonce(page, nonce, observation);
    const summary = await readHarnessSummary(page, nonce);
    rememberSummary(observation, summary);
    if (summary && summary.presentations >= expectedMessages() && summary.sceneAcks >= expectedMessages() && summary.journeyValid && !summary.pagehide && !summary.navigation) return summary;
    await page.waitForTimeout(100);
  }
  throw new Error("The locked iPhone journey did not reach its final acknowledgement.");
}

async function waitForResponsiveSeconds(page: Page, observation: SurvivalObservation, seconds: number): Promise<number> {
  let animationFrames = 0;
  for (let second = 0; second < seconds; second++) {
    try {
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
    } catch {
      observation.scriptUnresponsive = true;
      throw new Error("The locked iPhone journey stopped responding to animation-frame evaluation.");
    }
    assertNotCrashed(observation);
    if (plan.kind === "hermetic") {
      const nonce = observation.lockedDiagnosticNonce;
      if (!nonce) throw new Error("No diagnostic visit remained locked during the survival window.");
      await assertLockedNonce(page, nonce, observation);
      const summary = await readHarnessSummary(page, nonce);
      rememberSummary(observation, summary);
      if (!summary || !summary.journeyValid || summary.pagehide || summary.navigation
        || !summary.hostSocketOpen || !summary.seatSocketOpen) {
        throw new Error("The locked iPhone journey disappeared during the survival window.");
      }
    }
    observation.responsiveSeconds++;
  }
  return animationFrames;
}

function rememberSummary(
  observation: SurvivalObservation,
  summary: Awaited<ReturnType<typeof readHarnessSummary>>
): void {
  if (!summary) return;
  observation.presentations = summary.presentations;
  observation.acknowledgements = summary.sceneAcks;
  observation.hostSocketOpen = summary.hostSocketOpen;
  observation.seatSocketOpen = summary.seatSocketOpen;
  observation.hostSocketSeen = summary.hostSocketState !== "unseen";
  observation.seatSocketSeen = summary.seatSocketState !== "unseen";
  observation.journeyValid = summary.journeyValid;
  observation.pagehide = summary.pagehide;
  observation.navigation = summary.navigation;
  observation.viewError = summary.viewError;
}

async function readHarnessSummary(page: Page, nonce: string): Promise<{
  sceneAcks: number;
  presentations: number;
  viewError: boolean;
  hostSocketOpen: boolean;
  seatSocketOpen: boolean;
  hostSocketState: "unseen" | "open" | "closed";
  seatSocketState: "unseen" | "open" | "closed";
  journeyValid: boolean;
  visitOrdinal: number;
  journeyOrdinal: number;
  lastCheckpointOrdinal: number;
  lastCheckpointStage: number;
  pagehide: boolean;
  navigation: boolean;
} | null> {
  const body = await page.evaluate(async (lockedNonce) => {
    const response = await fetch(`/__couchcoop/lifecycle/summary?diagnosticVisit=${encodeURIComponent(lockedNonce)}`);
    return response.ok ? await response.json() as Record<string, unknown> : null;
  }, nonce);
  if (!body) return null;
  if (!Number.isSafeInteger(body.sceneAcks) || !Number.isSafeInteger(body.presentations)
    || typeof body.viewError !== "boolean" || !["open", "closed", "unseen"].includes(String(body.hostSocketState)) || !["open", "closed", "unseen"].includes(String(body.seatSocketState)) || typeof body.journeyValid !== "boolean" || !Number.isSafeInteger(body.visitOrdinal) || !Number.isSafeInteger(body.journeyOrdinal) || !Number.isSafeInteger(body.lastCheckpointOrdinal) || !Number.isSafeInteger(body.lastCheckpointStage) || typeof body.pagehide !== "boolean" || typeof body.navigation !== "boolean") {
    throw new Error("The iPhone lifecycle summary must contain sanitized counts and socket/view-error booleans.");
  }
  return {
    sceneAcks: body.sceneAcks,
    presentations: body.presentations,
    viewError: body.viewError,
    hostSocketOpen: body.hostSocketState === "open",
    seatSocketOpen: body.seatSocketState === "open",
    hostSocketState: body.hostSocketState as "unseen" | "open" | "closed",
    seatSocketState: body.seatSocketState as "unseen" | "open" | "closed",
    journeyValid: body.journeyValid,
    visitOrdinal: body.visitOrdinal,
    journeyOrdinal: body.journeyOrdinal,
    lastCheckpointOrdinal: body.lastCheckpointOrdinal,
    lastCheckpointStage: body.lastCheckpointStage,
    pagehide: body.pagehide,
    navigation: body.navigation
  };
}

async function diagnosticNonce(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    try { const raw = document.querySelector('meta[name="couchcoop-lifecycle"]')?.getAttribute("content"); const nonce = raw ? (JSON.parse(atob(raw)) as { nonce?: unknown }).nonce : null; return typeof nonce === "string" && /^[0-9a-f]{32}$/.test(nonce) ? nonce : null; } catch { return null; }
  });
}

async function assertLockedNonce(page: Page, nonce: string, observation: SurvivalObservation): Promise<void> {
  if (await diagnosticNonce(page) !== nonce) {
    if (observation.presented) observation.unexpectedNavigation = true;
    throw new Error("The browser meta diagnostic visit changed after first presentation.");
  }
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
  summary: { sceneAcks: number; presentations: number; viewError: boolean; hostSocketOpen: boolean; seatSocketOpen: boolean; journeyValid: boolean },
  animationFrames: number,
  testInfo: TestInfo
): Promise<void> {
  const classification = await classifySharedIphoneFailure({
    presentations: summary.presentations,
    acks: summary.sceneAcks,
    requiredMessages: expectedMessages()
  });
  await writeSanitizedHermeticResult(observation, testInfo, {
    category: classification.category,
    phase: classification.phase,
    failureClass: null,
    ok: true,
    presentations: summary.presentations,
    acks: summary.sceneAcks,
    animationFrames,
    responsive: observation.responsiveSeconds >= 10,
    crash: observation.pageCrashed,
    viewError: summary.viewError,
    hostSocketOpen: summary.hostSocketOpen,
    seatSocketOpen: summary.seatSocketOpen,
    journeyValid: summary.journeyValid
  });
}

async function writeSanitizedHermeticFailure(observation: SurvivalObservation, testInfo: TestInfo): Promise<void> {
  const presentations = observation.presentations ?? 0;
  const acks = observation.acknowledgements ?? 0;
  const classification = await classifySharedIphoneFailure({
    presentations,
    acks,
    requiredMessages: expectedMessages(),
    rendererPageCrash: observation.pageCrashed || observation.pageClosed,
    navigation: observation.unexpectedNavigation || observation.pagehide || observation.navigation,
    seatSocketClosed: observation.seatSocketSeen && observation.seatSocketOpen === false || observation.sockets.some(socket => socket.role === "seat" && socket.closed),
    hostSocketClosed: observation.hostSocketSeen && observation.hostSocketOpen === false || observation.sockets.some(socket => socket.role === "host" && socket.closed),
    clientViewError: observation.viewError,
    missingAcknowledgement: presentations >= expectedMessages() && acks < expectedMessages(),
    renderStall: presentations < expectedMessages(),
    scriptUnresponsive: observation.scriptUnresponsive
  });
  await writeSanitizedHermeticResult(observation, testInfo, {
    category: classification.category,
    phase: classification.phase,
    failureClass: classification.postFirstFrameBrowserDisappearance ? "post-first-frame-browser-disappearance" : null,
    ok: false,
    presentations,
    acks,
    animationFrames: 0,
    responsive: false,
    crash: observation.pageCrashed,
    viewError: observation.viewError ?? false,
    hostSocketOpen: observation.hostSocketOpen ?? socketIsOpen(observation, "host"),
    seatSocketOpen: observation.seatSocketOpen ?? socketIsOpen(observation, "seat"),
    journeyValid: observation.journeyValid ?? false
  });
}

async function writeSanitizedHermeticResult(
  observation: SurvivalObservation,
  testInfo: TestInfo,
  result: Record<string, unknown>
): Promise<void> {
  const artifactDir = testInfo.project.metadata[INTERNAL_ARTIFACT_ENV];
  if (typeof artifactDir !== "string" || !artifactDir) return;
  await writeFile(join(artifactDir, "iphone-webkit-result.json"), `${JSON.stringify({
    ...result,
    profile: plan.profile,
    pageErrorCategories: observation.pageErrorCategories
  })}\n`);
  await writeFile(join(artifactDir, "iphone-webkit-timeline.json"), `${JSON.stringify(observation.sockets.map((socket) => ({
    role: socket.role,
    closed: socket.closed,
    queryKeys: socket.queryKeys
  }))) }\n`);
}

function expectedMessages(): number {
  return plan.kind === "hermetic" && plan.profile === "field-repro" ? 6 : 2;
}
