#!/usr/bin/env node
// Dependency-free WebDriver helper for the iOS Simulator's Apple SafariDriver.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyIphoneFailure, validateIphoneSurvival } from "./lib/iphone-survival-contract.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((result, value, index, all) => {
  if (value.startsWith("--")) result.push([value.slice(2), all[index + 1]]);
  return result;
}, []));
if (!args.url || !args.artifactDir || !args.webdriver || !args.udid) {
  throw new Error("requires --url --artifactDir --webdriver --udid");
}
if (args.profile !== "baseline" && args.profile !== "field-repro") {
  throw new Error("--profile must be baseline or field-repro");
}

class RunnerFailure extends Error {
  constructor(category, reason) {
    super(reason);
    this.category = category;
    this.reason = reason;
  }
}

const wd = args.webdriver.replace(/\/$/, "");
const request = async (method, path, body, category = "simulator-safaridriver-failure") => {
  let response;
  try {
    response = await fetch(wd + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new RunnerFailure(category, "webdriver-unreachable");
  }
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.value?.error) {
    const webdriverError = String(json.value?.error ?? "");
    if (observedSummary.presentations > 0
      && ["no such window", "invalid session id"].includes(webdriverError)) {
      throw new RunnerFailure("renderer-page-crash", "browser-window-disappeared");
    }
    throw new RunnerFailure(category, "webdriver-command-failed");
  }
  return json.value;
};

const started = performance.now();
const timeline = [];
const at = (kind) => timeline.push({ t: Math.round(performance.now() - started), kind });
let sessionId;
let finalResult;
let diagnosticVisit;
let observedSummary = { presentations: 0, sceneAcks: 0 };
const requiredMessages = args.profile === "field-repro" ? 6 : 2;
const persist = async (result) => {
  await mkdir(args.artifactDir, { recursive: true });
  await writeFile(join(args.artifactDir, "iphone-safari-result.json"), `${JSON.stringify({ ...result, profile: args.profile })}\n`);
  await writeFile(join(args.artifactDir, "iphone-safari-timeline.json"), `${JSON.stringify(timeline)}\n`);
};

const waitForSummary = async () => {
  const until = performance.now() + 20_000;
  let summary = {};
  while (performance.now() < until) {
    let response;
    try {
      const summaryUrl = new URL("/__couchcoop/lifecycle/summary", args.url);
      summaryUrl.searchParams.set("diagnosticVisit", diagnosticVisit ?? "");
      response = await fetch(summaryUrl, { signal: AbortSignal.timeout(2_000) });
      summary = await response.json();
      observedSummary = summary;
    } catch {
      throw new RunnerFailure(observedSummary.presentations > 0 ? "host-socket-close" : "simulator-safaridriver-failure", "summary-unreachable");
    }
    if (summary.viewError === true) throw new RunnerFailure("client-view-error", "client-view-error");
    if ((summary.pagehide === true || summary.navigation === true) && summary.presentations > 0) {
      throw new RunnerFailure("unexpected-reload-navigation", "locked-journey-ended");
    }
    if (summary.seatSocketState === "closed" && summary.presentations > 0) throw new RunnerFailure("seat-socket-close", "socket-disappeared");
    if (summary.hostSocketState === "closed" && summary.presentations > 0) throw new RunnerFailure("host-socket-close", "socket-disappeared");
    if (summary.journeyValid !== true && summary.presentations > 0) throw new RunnerFailure("unexpected-reload-navigation", "locked-journey-ended");
    if (summary.presentations >= requiredMessages && summary.sceneAcks >= requiredMessages && summary.hostSocketState === "open" && summary.seatSocketState === "open") {
      return summary;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (summary.seatSocketState !== "open") throw new RunnerFailure("seat-socket-close", "socket-disappeared");
  if (summary.hostSocketState !== "open") throw new RunnerFailure("host-socket-close", "socket-disappeared");
  if (summary.presentations >= requiredMessages && summary.sceneAcks < requiredMessages) {
    throw new RunnerFailure("missing-acknowledgement", "final-ack-missing");
  }
  throw new RunnerFailure("render-stall", "final-presentation-missing");
};

try {
  const session = await request("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "safari",
        platformName: "iOS",
        "safari:useSimulator": true,
        "safari:deviceUDID": args.udid,
      },
    },
  });
  sessionId = session.sessionId ?? session.value?.sessionId;
  if (!sessionId) throw new RunnerFailure("safaridriver", "session-id-missing");
  const base = `/session/${sessionId}`;
  at("session-open");
  await request("POST", `${base}/url`, { url: args.url }, "page-script");
  at("control-loaded");
  diagnosticVisit = await request("POST", `${base}/execute/sync`, {
    script: "const raw=document.querySelector('meta[name=couchcoop-lifecycle]')?.content;try{return typeof raw==='string'?JSON.parse(atob(raw)).nonce:null}catch{return null}",
    args: [],
  }, "page-script");
  if (typeof diagnosticVisit !== "string" || !/^[0-9a-f]{32}$/.test(diagnosticVisit)) throw new RunnerFailure("page-script", "diagnostic-visit-missing");

  const element = await request("POST", `${base}/element`, {
    using: "css selector",
    value: "[data-testid='iphone-burst-seat']",
  }, "page-script");
  const elementId = element.ELEMENT ?? element["element-6066-11e4-a52e-4f735466cecf"];
  if (!elementId) throw new RunnerFailure("page-script", "seat-selector-missing");
  await request("POST", `${base}/element/${elementId}/click`, undefined, "page-script");
  at("seat-selected");

  const summary = await waitForSummary();
  at("final-ack-observed");
  let responsive = true;
  for (let second = 0; second < 10; second++) {
    const summaryUrl = new URL("/__couchcoop/lifecycle/summary", args.url);
    summaryUrl.searchParams.set("diagnosticVisit", diagnosticVisit);
    let poll;
    try {
      poll = await fetch(summaryUrl, { signal: AbortSignal.timeout(2_000) }).then(response => response.json());
      observedSummary = poll;
    } catch {
      throw new RunnerFailure("host-socket-close", "summary-unreachable");
    }
    if (poll.pagehide || poll.navigation) throw new RunnerFailure("unexpected-reload-navigation", "locked-journey-poll-failed");
    if (poll.seatSocketState !== "open") throw new RunnerFailure("seat-socket-close", "locked-journey-poll-failed");
    if (poll.hostSocketState !== "open") throw new RunnerFailure("host-socket-close", "locked-journey-poll-failed");
    if (poll.journeyValid !== true) throw new RunnerFailure("unexpected-reload-navigation", "locked-journey-poll-failed");
    const tick = await request("POST", `${base}/execute/sync`, { script: "return document.readyState==='complete' && !!document.querySelector('[data-testid=mirror-frame]');", args: [] }, "script-unresponsive");
    responsive &&= tick === true;
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  const frames = await request("POST", `${base}/execute/async`, {
    script: "const done=arguments[0];let n=0;const f=()=>++n>=30?done(n):requestAnimationFrame(f);requestAnimationFrame(f);",
    args: [],
  }, "page-script");
  const trivial = await request("POST", `${base}/execute/sync`, { script: "return document.readyState==='complete' && 2+2===4;", args: [] }, "page-script");
  at("survival-complete");

  const result = {
    presentations: summary.presentations,
    acks: summary.sceneAcks,
    hostSocketOpen: summary.hostSocketState === "open",
    seatSocketOpen: summary.seatSocketState === "open",
    viewError: summary.viewError,
    crash: false,
    animationFrames: Number(frames) || 0,
    responsive: responsive === true && trivial === true,
    requiredMessages,
  };
  const verdict = validateIphoneSurvival(result);
  if (!verdict.ok) {
    at("assertion-failed");
    await mkdir(args.artifactDir, { recursive: true });
    const png = await request("GET", `${base}/screenshot`, undefined, "script-unresponsive");
    await writeFile(join(args.artifactDir, "iphone-safari-failure.png"), Buffer.from(png, "base64"));
    const classification = classifyIphoneFailure({
      ...result,
      rendererPageCrash: result.crash,
      seatSocketClosed: !result.seatSocketOpen,
      hostSocketClosed: !result.hostSocketOpen,
      clientViewError: result.viewError,
      missingAcknowledgement: result.presentations >= requiredMessages && result.acks < requiredMessages,
      renderStall: result.presentations < requiredMessages,
      scriptUnresponsive: !result.responsive || result.animationFrames < 30,
    });
    finalResult = {
      category: classification.category,
      phase: classification.phase,
      failureClass: classification.postFirstFrameBrowserDisappearance ? "post-first-frame-browser-disappearance" : null,
      ...result,
      ...verdict,
    };
    process.exitCode = 1;
  } else {
    at("passed");
    const classification = classifyIphoneFailure(result);
    finalResult = { category: classification.category, phase: classification.phase, failureClass: null, ...result, ...verdict };
  }
} catch (error) {
  const rawCategory = error instanceof RunnerFailure ? error.category : "script-unresponsive";
  const normalized = ["renderer-page-crash", "unexpected-reload-navigation", "seat-socket-close", "host-socket-close", "client-view-error", "missing-acknowledgement", "render-stall", "script-unresponsive", "simulator-safaridriver-failure"].includes(rawCategory) ? rawCategory : "simulator-safaridriver-failure";
  const classification = classifyIphoneFailure({ presentations: Number(observedSummary.presentations) || 0, acks: Number(observedSummary.sceneAcks) || 0, requiredMessages, rendererPageCrash: normalized === "renderer-page-crash", navigation: normalized === "unexpected-reload-navigation", seatSocketClosed: normalized === "seat-socket-close", hostSocketClosed: normalized === "host-socket-close", clientViewError: normalized === "client-view-error", missingAcknowledgement: normalized === "missing-acknowledgement", renderStall: normalized === "render-stall", scriptUnresponsive: normalized === "script-unresponsive", simulatorSafariDriverFailure: normalized === "simulator-safaridriver-failure" });
  const category = classification.category;
  const reason = error instanceof RunnerFailure ? error.reason : "unexpected-runner-error";
  at("failed");
  if (sessionId) {
    try {
      const png = await request("GET", `/session/${sessionId}/screenshot`, undefined, "page-script");
      await mkdir(args.artifactDir, { recursive: true });
      await writeFile(join(args.artifactDir, "iphone-safari-failure.png"), Buffer.from(png, "base64"));
    } catch { /* A crashed page commonly cannot produce the failure-only screenshot. */ }
  }
  finalResult = {
    category: classification.category,
    phase: classification.phase,
    failureClass: classification.postFirstFrameBrowserDisappearance ? "post-first-frame-browser-disappearance" : null,
    ok: false,
    reason,
  };
  process.stderr.write(`${category}: ${reason}\n`);
  process.exitCode = 1;
} finally {
  if (sessionId) {
    try {
      await request("DELETE", `/session/${sessionId}`);
      at("session-closed");
    } catch { /* Cleanup failure cannot replace the already-sanitized verdict. */ }
  }
  await persist(finalResult ?? {
    category: "simulator-safaridriver-failure",
    phase: "pre-first-frame",
    failureClass: null,
    ok: false,
    reason: "result-missing",
  });
}
