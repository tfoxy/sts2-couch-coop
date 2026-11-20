// The public origin's entry point: the small amount of DOM and sequencing around @/boot/bootstrap.
//
// Everything decision-shaped lives in bootstrap.ts (and is unit-tested there); this file owns the screen
// and the order things happen in.

import {
  candidatesForPage,
  isPermissionGranted,
  rememberResolvedHost,
  stripHostParam,
  webLinkBlockedByBrowser,
  type BootFailure
} from "@/boot/bootstrap";
import { bootWebsite, canTunnel } from "@/boot/websiteBoot";
import { bootLocale, bootText } from "@/boot/localize";

const locale = bootLocale();
document.documentElement.lang = locale;
const t = (key: Parameters<typeof bootText>[1], values?: Record<string, string | number>): string => bootText(locale, key, values);

const boot_ = document.getElementById("boot")!;
const status = document.getElementById("status")!;
const detail = document.getElementById("detail")!;
const connect = document.getElementById("connect") as HTMLButtonElement;
const manual = document.getElementById("manual") as HTMLFormElement;
const manualInput = document.getElementById("manual-host") as HTMLInputElement;

// Static shell copy is present before this module runs for recovery, then immediately replaced so a public-origin
// zh-Hans visit never briefly exposes English controls while waiting for the first permission decision.
status.textContent = t("boot.starting");
connect.textContent = t("boot.connect");
manualInput.setAttribute("aria-label", t("boot.gameAddress"));
const manualSubmit = manual.querySelector("button[type='submit']");
if (manualSubmit) manualSubmit.textContent = t("common.go");

function show(message: string, sub = ""): void {
  status.textContent = message;
  detail.textContent = sub;
}

function showConnectButton(label: string, sub: string): void {
  show(label, sub);
  connect.hidden = false;
  connect.disabled = false;
}

function platform(): Parameters<typeof webLinkBlockedByBrowser>[0] {
  return {
    pageProtocol: location.protocol,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints
  };
}

// The one line the player has to act on when nothing answered. Each failure gets its OWN sentence rather
// than a shared "couldn't connect", because the three causes need three different actions and guessing
// wrong wastes the one thing a player in this state has run out of: patience.
function explain(failure: BootFailure): string {
  switch (failure.kind) {
    case "no-candidates":
      return t("boot.noCandidates");
    case "origin-refused":
      return failure.webOrigin
        ? t("boot.originRefused", { origin: failure.webOrigin })
        : t("boot.originRefusedGeneric");
    case "unreachable":
      // Checked BEFORE the two network sentences: on iOS nothing was ever sent, so "check it's running and
      // that this phone is on the same Wi-Fi" would be advice about a link that cannot work either way.
      if (webLinkBlockedByBrowser(platform(), failure.tried)) return t("boot.unreachableIos");
      return failure.tried.length === 1
        ? t("boot.unreachableOne") : t("boot.unreachableMany");
  }
}

async function boot(explicitHost?: string): Promise<void> {
  connect.disabled = true;
  show(t("boot.looking"));

  const candidates = explicitHost ? [explicitHost] : candidatesForPage(location.href);
  try {
    const outcome = await bootWebsite(candidates, location.href, {
      beforeInject(resolved) {
        rememberResolvedHost(resolved.origin, Date.now(), explicitHost ? null : location.href);
        const stripped = stripHostParam(location.href);
        if (stripped) history.replaceState(null, "", stripped);
        show(t("boot.loading"));
      }
    });
    if (!outcome) return; // The worker will control the replacement document.
    if (!outcome.ok) {
      showConnectButton(t("boot.tryAgain"), explain(outcome.failure));
      manual.hidden = false;
      return;
    }
    boot_.remove();
  } catch {
    showConnectButton(t("boot.tryAgain"), t("boot.loadFailed"));
  }
}

connect.addEventListener("click", () => void boot());

manual.addEventListener("submit", (event) => {
  event.preventDefault();
  const typed = manualInput.value.trim();
  if (!typed) return;
  manual.hidden = true;
  void boot(typed.startsWith("http") ? typed : `http://${typed}`);
});

void (async () => {
  // Said BEFORE the attempt on a browser that cannot make it, rather than after a probe that was never
  // going to leave the device. The button stays — a UA sniff can misfire, and the cost of being wrong must
  // be one line of text, never a screen that refuses to try.
  const candidates = candidatesForPage(location.href);
  if (canTunnel(candidates, location.href)) {
    void boot();
    return;
  }
  if (webLinkBlockedByBrowser(platform(), candidates)) {
    showConnectButton(t("boot.connect"), t("boot.unreachableIos"));
    return;
  }

  // A granted permission means this is a return visit (very often a home-screen launch), so connect with
  // no tap. Otherwise the first local-network request must come from a gesture — not because the API
  // demands one, but because a permission prompt that appears before the player has asked for anything
  // reads as the page being pushy, and gets denied.
  if (await isPermissionGranted()) {
    void boot();
    return;
  }
  showConnectButton(
    t("boot.connect"), t("boot.permission")
  );
})();

// Registered only after the page is interactive, and never awaited: the worker exists to make the SECOND
// join fast, so it must never delay the first. See pages/sw.js for why it may only ever serve cache hits.
if ("serviceWorker" in navigator && new URLSearchParams(location.search).get("sw") !== "off") {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      // A worker that will not register costs durability, nothing else.
    });
  });
}
