#!/usr/bin/env node
// Dependency-free WebDriver helper for the iOS Simulator's Apple SafariDriver.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { classifyIphoneFailure, validateIphoneSurvival } from "./lib/iphone-survival-contract.mjs";
import { pathToFileURL } from "node:url";
import { retryableSessionReason, sanitizedWebDriverReason } from "./lib/iphone-webdriver-errors.mjs";

export function safariProvenance(env = process.env) {
  return {
    run_id: /^\d{1,20}$/.test(env.GITHUB_RUN_ID ?? "") ? env.GITHUB_RUN_ID : null,
    run_attempt: /^\d{1,10}$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ? env.GITHUB_RUN_ATTEMPT : null,
    head_sha: /^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? "") ? env.GITHUB_SHA : null,
  };
}

export function safeNavigationResult(currentUrl, handles, harnessUrl) {
  let current;
  try { current = new URL(currentUrl); } catch { /* Missing or malformed URLs yield false facts. */ }
  return {
    originEqualsHarness: current?.origin === new URL(harnessUrl).origin,
    pathIsRoot: current?.pathname === "/",
    aboutBlank: current?.href === "about:blank",
    handleCount: Array.isArray(handles) ? handles.length : 0,
  };
}

export function safePageResult(value) {
  return {
    readyState: ["loading", "interactive", "complete"].includes(value?.readyState) ? value.readyState : "unknown",
    lifecycleMetaPresent: value?.lifecycleMetaPresent === true,
    lifecycleNonceValid: value?.lifecycleNonceValid === true,
    seatSelectorPresent: value?.seatSelectorPresent === true,
  };
}

export const SafePageScript = `
const raw=document.querySelector('meta[name=couchcoop-lifecycle]')?.content;
let nonce;try{nonce=typeof raw==='string'?JSON.parse(atob(raw)).nonce:null}catch{}
return {readyState:document.readyState,lifecycleMetaPresent:typeof raw==='string',
lifecycleNonceValid:typeof nonce==='string'&&/^[0-9a-f]{32}$/.test(nonce),
seatSelectorPresent:!!document.querySelector("[data-testid='iphone-burst-seat']")};`;

export function printSafariFailure(result) {
  if (result.ok === false) process.stderr.write(`${result.category}: ${result.reason}\n`);
}

export async function recordShellFailure(directory, category, reason, phase = "pre-first-frame") {
  await mkdir(directory, { recursive: true });
  let previous;
  try { previous = JSON.parse(await readFile(join(directory, "iphone-safari-result.json"), "utf8")); }
  catch { /* Capability failures can precede the WebDriver runner. */ }
  const provenance = previous?.provenance ?? safariProvenance();
  if (!previous) {
    process.stdout.write(`iphone-safari provenance: ${JSON.stringify(provenance)}\n`);
    await writeFile(join(directory, "iphone-safari-timeline.json"), JSON.stringify([{ t: 0, kind: "provenance", provenance }]) + "\n");
  }
  const result = { ...previous, category, reason, phase, ok: false,
    failureClass: category === "renderer-page-crash" ? "post-first-frame-browser-disappearance" : null,
    profile: "field-repro", provenance,
    commands: previous?.commands ?? [], lastSafeResult: previous?.lastSafeResult ?? { navigation: null, page: null } };
  await writeFile(join(directory, "iphone-safari-result.json"), JSON.stringify(result) + "\n");
  printSafariFailure(result);
}

export async function runSafari(args) {
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
  const CommandTimeoutMs = 15_000;
  const SessionCreateTimeoutMs = 120_000;
  const commands = [];
  const lastSafeResult = { navigation: null, page: null };
  const request = async (
    command,
    method,
    path,
    body,
    category = "simulator-safaridriver-failure",
    timeoutMs = CommandTimeoutMs,
  ) => {
    const commandStarted = performance.now();
    let outcome = "error";
    try {
      let response;
      try {
        response = await fetch(wd + path, {
          method,
          headers: { "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (error?.name === "TimeoutError") {
          throw new RunnerFailure(category, "webdriver-command-timeout");
        }
        throw new RunnerFailure(category, "webdriver-unreachable");
      }
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json.value?.error) {
        const webdriverError = String(json.value?.error ?? "");
        if (observedSummary.presentations > 0
          && ["no such window", "invalid session id"].includes(webdriverError)) {
          throw new RunnerFailure("renderer-page-crash", "browser-window-disappeared");
        }
        throw new RunnerFailure(category, sanitizedWebDriverReason(json.value?.error, json.value?.message));
      }
      outcome = "success";
      return json.value;
    } finally {
      commands.push({ command, elapsedMs: Math.round(performance.now() - commandStarted), outcome });
    }
  };

  const started = performance.now();
  const provenance = safariProvenance();
  process.stdout.write(`iphone-safari provenance: ${JSON.stringify(provenance)}\n`);
  const timeline = [{ t: 0, kind: "provenance", provenance }];
  const at = (kind) => timeline.push({ t: Math.round(performance.now() - started), kind });
  let sessionId;
  let finalResult;
  let diagnosticVisit;
  let observedSummary = { presentations: 0, sceneAcks: 0 };
  const requiredMessages = args.profile === "field-repro" ? 6 : 2;
  const persist = async (result) => {
    await mkdir(args.artifactDir, { recursive: true });
    await writeFile(join(args.artifactDir, "iphone-safari-result.json"), `${JSON.stringify({ ...result, profile: args.profile, provenance, commands, lastSafeResult })}\n`);
    await writeFile(join(args.artifactDir, "iphone-safari-timeline.json"), `${JSON.stringify(timeline)}\n`);
    if (args.deferFailureLog !== "true") printSafariFailure(result);
  };

  const waitForPageValue = async (base, script, accept, reason, command) => {
    const until = performance.now() + 30_000;
    while (performance.now() < until) {
      const value = await request(command, "POST", `${base}/execute/sync`, { script, args: [] }, "page-script");
      if (accept(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new RunnerFailure("simulator-safaridriver-failure", reason);
  };

  const readJourneySummary = async () => {
    try {
      const summaryUrl = new URL("/__couchcoop/lifecycle/summary", args.url);
      summaryUrl.searchParams.set("diagnosticVisit", diagnosticVisit ?? "");
      const response = await fetch(summaryUrl, { signal: AbortSignal.timeout(2_000) });
      const summary = await response.json();
      observedSummary = summary;
      return summary;
    } catch {
      throw new RunnerFailure(
        observedSummary.presentations > 0 ? "host-socket-close" : "simulator-safaridriver-failure",
        "summary-unreachable",
      );
    }
  };

  const waitForSeatSocket = async (timeoutMs) => {
    const until = performance.now() + timeoutMs;
    while (performance.now() < until) {
      const summary = await readJourneySummary();
      if (summary.seatSocketState === "open") return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  };

  const clickSemanticElement = async (base, selector) => request("select-seat", "POST", `${base}/execute/sync`, {
    script: "const el=document.querySelector(arguments[0]);if(!el)return false;el.click();return true;",
    args: [selector],
  }, "page-script");

  const createSession = async () => {
    const body = {
      capabilities: {
        alwaysMatch: {
          browserName: "safari",
          platformName: "iOS",
          pageLoadStrategy: "none",
          "safari:useSimulator": true,
          "safari:deviceUDID": args.udid,
        },
      },
    };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await request(
          "create-session",
          "POST",
          "/session",
          body,
          "simulator-safaridriver-failure",
          SessionCreateTimeoutMs,
        );
      } catch (error) {
        if (!(error instanceof RunnerFailure)
          || !retryableSessionReason(error.reason)
          || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
    throw new RunnerFailure("simulator-safaridriver-failure", "session-create-retries-exhausted");
  };

  const waitForSummary = async () => {
    const until = performance.now() + 20_000;
    let summary = {};
    while (performance.now() < until) {
      summary = await readJourneySummary();
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
    const session = await createSession();
    sessionId = session.sessionId ?? session.value?.sessionId;
    if (!sessionId) throw new RunnerFailure("safaridriver", "session-id-missing");
    const base = `/session/${sessionId}`;
    at("session-open");
    await request("navigate-blank", "POST", `${base}/url`, { url: "about:blank" }, "page-script");
    const arithmetic = await request("check-arithmetic", "POST", `${base}/execute/sync`, { script: "return 2+2", args: [] }, "page-script");
    if (arithmetic !== 4) {
      commands.at(-1).outcome = "error";
      throw new RunnerFailure("simulator-safaridriver-failure", "webdriver-arithmetic-failed");
    }
    await request("navigate-harness", "POST", `${base}/url`, { url: args.url }, "page-script");
    at("control-loaded");
    const currentUrl = await request("read-current-url", "GET", `${base}/url`);
    lastSafeResult.navigation = safeNavigationResult(currentUrl, null, args.url);
    const handles = await request("read-window-handles", "GET", `${base}/window/handles`);
    lastSafeResult.navigation = safeNavigationResult(currentUrl, handles, args.url);
    process.stdout.write(`iphone-safari navigation: ${JSON.stringify(lastSafeResult.navigation)}\n`);
    lastSafeResult.page = safePageResult(await request("inspect-page", "POST", `${base}/execute/sync`, { script: SafePageScript, args: [] }, "page-script"));
    process.stdout.write(`iphone-safari page: ${JSON.stringify(lastSafeResult.page)}\n`);
    try {
      diagnosticVisit = await waitForPageValue(
        base,
        "const raw=document.querySelector('meta[name=couchcoop-lifecycle]')?.content;try{return typeof raw==='string'?JSON.parse(atob(raw)).nonce:null}catch{return null}",
        (value) => typeof value === "string" && /^[0-9a-f]{32}$/.test(value),
        "diagnostic-visit-missing",
        "read-diagnostic-visit",
      );
    } catch (error) {
      // Navigation can settle during the wait; retain final facts without replacing its failure.
      try {
        const finalUrl = await request("read-current-url", "GET", `${base}/url`);
        lastSafeResult.navigation = { ...safeNavigationResult(finalUrl, null, args.url),
          handleCount: lastSafeResult.navigation.handleCount };
      } catch { /* Keep the previous navigation facts if the driver cannot read the URL. */ }
      try {
        const finalHandles = await request("read-window-handles", "GET", `${base}/window/handles`);
        lastSafeResult.navigation.handleCount = Array.isArray(finalHandles) ? finalHandles.length : 0;
      } catch { /* A handle failure must not prevent the final page inspection. */ }
      try {
        lastSafeResult.page = safePageResult(await request("inspect-page", "POST", `${base}/execute/sync`,
          { script: SafePageScript, args: [] }, "page-script"));
      } catch { /* Keep the previous page facts if script execution fails. */ }
      throw error;
    }

    await waitForPageValue(
      base,
      "return !!document.querySelector(\"[data-testid='iphone-burst-seat']\");",
      (value) => value === true,
      "seat-selector-missing",
      "find-seat-selector",
    );

    const seatSelector = "[data-testid='iphone-burst-seat']";
    if (!await clickSemanticElement(base, seatSelector)) {
      throw new RunnerFailure("page-script", "seat-selector-missing");
    }
    // Mobile Safari can consume the first synthetic tap as focus while the control view settles. The seat socket is
    // the bounded, payload-free proof that the Vue handler actually ran, so retry activation once when it stays absent.
    if (!await waitForSeatSocket(3_000) && !await clickSemanticElement(base, seatSelector)) {
      throw new RunnerFailure("page-script", "seat-selector-missing");
    }
    at("seat-selected");

    const summary = await waitForSummary();
    at("final-ack-observed");
    let responsive = true;
    for (let second = 0; second < 10; second++) {
      const poll = await readJourneySummary();
      if (poll.pagehide || poll.navigation) throw new RunnerFailure("unexpected-reload-navigation", "locked-journey-poll-failed");
      if (poll.seatSocketState !== "open") throw new RunnerFailure("seat-socket-close", "locked-journey-poll-failed");
      if (poll.hostSocketState !== "open") throw new RunnerFailure("host-socket-close", "locked-journey-poll-failed");
      if (poll.journeyValid !== true) throw new RunnerFailure("unexpected-reload-navigation", "locked-journey-poll-failed");
      const tick = await request("check-responsiveness", "POST", `${base}/execute/sync`, { script: "return document.readyState==='complete' && !!document.querySelector('[data-testid=mirror-frame]');", args: [] }, "script-unresponsive");
      responsive &&= tick === true;
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    const frames = await request("count-animation-frames", "POST", `${base}/execute/async`, {
      script: "const done=arguments[0];let n=0;const f=()=>++n>=30?done(n):requestAnimationFrame(f);requestAnimationFrame(f);",
      args: [],
    }, "page-script");
    const trivial = await request("check-responsiveness", "POST", `${base}/execute/sync`, { script: "return document.readyState==='complete' && 2+2===4;", args: [] }, "page-script");
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
        reason: verdict.failures[0],
      };
      try {
        const png = await request("failure-screenshot", "GET", `${base}/screenshot`, undefined, "script-unresponsive");
        await mkdir(args.artifactDir, { recursive: true });
        await writeFile(join(args.artifactDir, "iphone-safari-failure.png"), Buffer.from(png, "base64"));
      } catch { /* Screenshot errors cannot replace the contract failure. */ }
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
    const reason = error instanceof RunnerFailure ? error.reason : "unexpected-runner-error";
    at("failed");
    if (sessionId) {
      try {
        const png = await request("failure-screenshot", "GET", `/session/${sessionId}/screenshot`, undefined, "page-script");
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
    process.exitCode = 1;
  } finally {
    if (sessionId) {
      try {
        await request("delete-session", "DELETE", `/session/${sessionId}`);
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((result, value, index, all) => {
    if (value.startsWith("--")) result.push([value.slice(2), all[index + 1]]);
    return result;
  }, []));
  if (args.recordFailure) {
    await recordShellFailure(args.artifactDir, args.category, args.reason, args.phase);
  } else if (args.reportResult) {
    printSafariFailure(JSON.parse(await readFile(join(args.artifactDir, "iphone-safari-result.json"), "utf8")));
  } else {
    await runSafari(args);
  }
}
