// Campaign-only event abort. No periodic page probes run inside CPU markers.
export const CONTEXT_LOSS_SIGNAL = "[cpu-campaign:webglcontextlost]";

export function installCampaignContextLossHook() {
  const onLoss = () => {
    console.error("[cpu-campaign:webglcontextlost]");
  };
  window.addEventListener("webglcontextlost", onLoss, true);
  window.__benchCampaignContextLossOff = () => window.removeEventListener("webglcontextlost", onLoss, true);
}

export function selectBenchInitScriptTarget({ connectMode, connectPage, context }) {
  if (!connectMode) return context;
  if (!connectPage) throw Error("connect mode has no owned page for init scripts");
  return connectPage;
}

export function createCampaignPageAbort(page) {
  let reason = null, closed = false, signal;
  const happened = new Promise(resolve => { signal = resolve; });
  const abort = message => {
    if (closed || reason) return;
    reason = new Error(message);
    signal(reason);
  };
  const onConsole = message => {
    if (message?.text?.().includes(CONTEXT_LOSS_SIGNAL)) abort("campaign abort: WebGL context lost");
  };
  const onCrash = () => abort("campaign abort: renderer process crashed");
  page.on("console", onConsole);
  page.on("crash", onCrash);
  return {
    get reason() { return reason; },
    throwIfAborted() { if (reason) throw reason; },
    async wait(work) {
      const completion = Promise.resolve(work).then(
        value => ({ kind: "value", value }), error => ({ kind: "error", error }));
      if (reason) throw reason;
      // Both branches resolve; a loss before a wait cannot create an unhandled
      // rejection, and a losing Playwright promise remains handled.
      const outcome = await Promise.race([
        completion,
        happened.then(error => ({ kind: "abort", error }))
      ]);
      if (outcome.kind !== "value") throw outcome.error;
      return outcome.value;
    },
    close() {
      closed = true;
      page.off("console", onConsole);
      page.off("crash", onCrash);
    }
  };
}
