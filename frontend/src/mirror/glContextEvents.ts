// `window.__mirrorGlContextEvents()` — every GL context loss and restore ON THE PAGE, not just the stage's own.
//
// WHY IT IS PAGE-WIDE AND NOT PER-RENDERER. The canvas stage already handles its own context loss and now counts
// it (canvasRenderer's contextLosses/contextRestores). But the stage is one canvas among a dozen: the gsw shader
// and particle runtimes each own theirs, and on the DOM arm they are the ONLY ones there are. When Android's
// lowmemorykiller takes the GPU process — which is what it did during the round-6 device matrix — every context
// on the page dies at once, so a counter attached to one renderer describes a fraction of the event and cannot
// even say whether the rest recovered.
//
// WHY CAPTURE PHASE. `webglcontextlost` does not bubble. A listener on `window` in the BUBBLE phase would never
// fire for a canvas; in the capture phase it sees every one, including canvases created after this module ran,
// which matters because the effect runtimes mint theirs lazily.
//
// This is a REPORTER. It calls no `preventDefault()` and cancels nothing: the arm that owns a canvas decides
// whether its loss is recoverable, and a passive observer that quietly changed that would be a defect wearing an
// instrument's clothes.

export interface MirrorGlContextEventsReport {
  /** `webglcontextlost` events seen anywhere on the page. */
  losses: number;
  /** `webglcontextrestored` events. Fewer than `losses` means something did not come back. */
  restores: number;
  /** `webglcontextcreationerror` — a context that could not be made at all, which is a different failure. */
  creationErrors: number;
  /** ms since page load of the first loss, or null. The one number that says WHEN the GPU went away. */
  firstLossAtMs: number | null;
  /** ms since page load of the most recent event of any kind. */
  lastEventAtMs: number | null;
  /**
   * Up to 20 events, in order: `{ kind, atMs, target }` where `target` is the canvas's class list or a marker
   * naming which population owned it. Capped because a page thrashing its contexts must not fill memory with
   * the record of it.
   */
  events: { kind: string; atMs: number; target: string }[];
}

const EVENT_CAP = 20;

const report: MirrorGlContextEventsReport = {
  losses: 0,
  restores: 0,
  creationErrors: 0,
  firstLossAtMs: null,
  lastEventAtMs: null,
  events: []
};

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

function describeTarget(target: EventTarget | null): string {
  const el = target as Element | null;
  if (!el || typeof el.tagName !== "string") {
    return "(unknown)";
  }
  const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
  return `${el.tagName.toLowerCase()}${cls}`;
}

function note(kind: string, event: Event): void {
  const atMs = Math.round(now());
  if (kind === "webglcontextlost") {
    report.losses += 1;
    if (report.firstLossAtMs === null) {
      report.firstLossAtMs = atMs;
    }
  } else if (kind === "webglcontextrestored") {
    report.restores += 1;
  } else {
    report.creationErrors += 1;
  }
  report.lastEventAtMs = atMs;
  if (report.events.length < EVENT_CAP) {
    report.events.push({ kind, atMs, target: describeTarget(event.target) });
  }
}

let installed = false;

/** Idempotent — a second mirror view on the same page must not double-count every event. */
export function installGlContextEventReporter(): void {
  if (installed || typeof window === "undefined" || typeof window.addEventListener !== "function") {
    return;
  }
  installed = true;
  for (const kind of ["webglcontextlost", "webglcontextrestored", "webglcontextcreationerror"]) {
    window.addEventListener(kind, (event) => note(kind, event), { capture: true, passive: true });
  }
  (window as unknown as Record<string, unknown>).__mirrorGlContextEvents = glContextEventsReport;
}

export function glContextEventsReport(): MirrorGlContextEventsReport {
  return { ...report, events: report.events.slice() };
}

/** TEST-ONLY: zero the counters so one spec's events cannot be read by the next. */
export function __resetGlContextEventsForTest(): void {
  report.losses = 0;
  report.restores = 0;
  report.creationErrors = 0;
  report.firstLossAtMs = null;
  report.lastEventAtMs = null;
  report.events.length = 0;
}
