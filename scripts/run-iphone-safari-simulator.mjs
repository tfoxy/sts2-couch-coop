#!/usr/bin/env node
// Dependency-free WebDriver helper for the iOS Simulator's Apple SafariDriver.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateIphoneSurvival } from "./lib/iphone-survival-contract.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((result, value, index, all) => {
  if (value.startsWith("--")) result.push([value.slice(2), all[index + 1]]);
  return result;
}, []));
if (!args.url || !args.artifactDir || !args.webdriver || !args.udid) {
  throw new Error("requires --url --artifactDir --webdriver --udid");
}

class RunnerFailure extends Error {
  constructor(category, reason) {
    super(reason);
    this.category = category;
    this.reason = reason;
  }
}

const wd = args.webdriver.replace(/\/$/, "");
const request = async (method, path, body, category = "safaridriver") => {
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
  if (!response.ok || json.value?.error) throw new RunnerFailure(category, "webdriver-command-failed");
  return json.value;
};

const started = performance.now();
const timeline = [];
const at = (kind) => timeline.push({ t: Math.round(performance.now() - started), kind });
let sessionId;
let finalResult;
const persist = async (result) => {
  await mkdir(args.artifactDir, { recursive: true });
  await writeFile(join(args.artifactDir, "iphone-safari-result.json"), `${JSON.stringify(result)}\n`);
  await writeFile(join(args.artifactDir, "iphone-safari-timeline.json"), `${JSON.stringify(timeline)}\n`);
};

const waitForSummary = async () => {
  const until = performance.now() + 20_000;
  let summary = {};
  while (performance.now() < until) {
    let response;
    try {
      response = await fetch(new URL("/__couchcoop/lifecycle/summary", args.url), { signal: AbortSignal.timeout(2_000) });
      summary = await response.json();
    } catch {
      throw new RunnerFailure("websocket", "summary-unreachable");
    }
    if (summary.viewError === true) throw new RunnerFailure("page-script", "client-view-error");
    if (summary.presentations >= 2 && summary.sceneAcks >= 2 && summary.hostSocketOpen && summary.seatSocketOpen) {
      return summary;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!summary.hostSocketOpen || !summary.seatSocketOpen) throw new RunnerFailure("websocket", "socket-disappeared");
  throw new RunnerFailure("assertion", "second-presentation-or-ack-missing");
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

  const element = await request("POST", `${base}/element`, {
    using: "css selector",
    value: "[data-testid='iphone-burst-seat']",
  }, "page-script");
  const elementId = element.ELEMENT ?? element["element-6066-11e4-a52e-4f735466cecf"];
  if (!elementId) throw new RunnerFailure("page-script", "seat-selector-missing");
  await request("POST", `${base}/element/${elementId}/click`, undefined, "page-script");
  at("seat-selected");

  const summary = await waitForSummary();
  at("second-ack-observed");
  const responsive = await request("POST", `${base}/execute/sync`, {
    script: "return document.readyState === 'complete' && !!document.querySelector('[data-testid=mirror-frame]');",
    args: [],
  }, "page-script");
  const frames = await request("POST", `${base}/execute/async`, {
    script: "const done=arguments[0];let n=0;const f=()=>++n>=30?done(n):requestAnimationFrame(f);requestAnimationFrame(f);",
    args: [],
  }, "page-script");
  at("survival-complete");

  const result = {
    presentations: summary.presentations,
    acks: summary.sceneAcks,
    hostSocketOpen: summary.hostSocketOpen,
    seatSocketOpen: summary.seatSocketOpen,
    viewError: summary.viewError,
    crash: false,
    animationFrames: Number(frames) || 0,
    responsive: responsive === true,
  };
  const verdict = validateIphoneSurvival(result);
  if (!verdict.ok) {
    at("assertion-failed");
    const png = await request("GET", `${base}/screenshot`, undefined, "page-script");
    await writeFile(join(args.artifactDir, "iphone-safari-failure.png"), Buffer.from(png, "base64"));
    finalResult = { category: "assertion", ...result, ...verdict };
    process.exitCode = 1;
  } else {
    at("passed");
    finalResult = { category: "success", ...result, ...verdict };
  }
} catch (error) {
  const category = error instanceof RunnerFailure ? error.category : "page-script";
  const reason = error instanceof RunnerFailure ? error.reason : "unexpected-runner-error";
  at("failed");
  if (sessionId) {
    try {
      const png = await request("GET", `/session/${sessionId}/screenshot`, undefined, "page-script");
      await mkdir(args.artifactDir, { recursive: true });
      await writeFile(join(args.artifactDir, "iphone-safari-failure.png"), Buffer.from(png, "base64"));
    } catch { /* A crashed page commonly cannot produce the failure-only screenshot. */ }
  }
  finalResult = { category, ok: false, reason };
  process.stderr.write(`${category}: ${reason}\n`);
  process.exitCode = 1;
} finally {
  if (sessionId) {
    try {
      await request("DELETE", `/session/${sessionId}`);
      at("session-closed");
    } catch { /* Cleanup failure cannot replace the already-sanitized verdict. */ }
  }
  await persist(finalResult ?? { category: "page-script", ok: false, reason: "result-missing" });
}
