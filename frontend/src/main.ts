import { createApp } from "vue";
import { godotSceneBaseCss } from "@godot-scene-web/html";

import App from "./App.vue";
import { createBrowserI18n, installLocaleSync } from "./i18n";
import { installBrowserCursor } from "./browserCursor";
import { installServiceWorker } from "./pwa/registerServiceWorker";
import { installScreenWakeLockFromGlobals } from "./pwa/wakeLock";
import { installZoomStableViewport } from "./zoomStableViewport";
import { installPagePressModality } from "./inputModality";
import { installLifecycleTelemetry } from "./lifecycleTelemetry";
import "./styles.css";

// Page lifetime, not component lifetime: a touch in the lobby remains the last press modality when the mirror
// later mounts. Installing before Vue means no application press can be missed.
installPagePressModality(window);

// godot-scene-web's base stylesheet (frame/stage sizing + centering, node positioning,
// Label/RichTextLabel layout). The live `GodotSceneView` builds the DOM but does NOT
// inject this (`includeBaseCss: false`) — it's a host concern, the same way spirectl's
// eager `glue.js` injects it. couch-coop is live-only, so we inject it here once. The
// `.godot-scene-frame` rules (`container-type: size; width/height: 100%; flex-center`) are
// required for the content-scale "keep" fit (App.vue passes `render.contentScale`).
function injectGodotBaseCss(): void {
  const id = "godot-scene-base-css";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = godotSceneBaseCss;
  document.head.appendChild(style);
}

injectGodotBaseCss();
// The game-art cursor is installed only where the browser reports a real cursor.
installBrowserCursor(document.documentElement, window);
installZoomStableViewport();
installLifecycleTelemetry();

// --- secure-context extras ----------------------------------------------------------------------------
// Both are no-ops on the mod's default plain-HTTP LAN URL, which is not a secure context: there
// `navigator.serviceWorker` and `navigator.wakeLock` are both undefined and each installer takes its
// availability branch. They light up on the opt-in HTTPS origin (and on localhost, which counts as
// secure, so they are testable in dev).
//
// Deliberately BEFORE mount and deliberately not awaited: neither may delay first paint, and neither
// may be able to fail the app. `installServiceWorker` swallows registration errors internally; the
// `.catch` here is the belt to that braces, for anything thrown synchronously by a hostile environment.
void installServiceWorker().catch(() => {});
// Stops the phone dimming/sleeping while a player is watching a co-op turn they aren't driving — there
// is no touch input during someone else's turn to keep the display timer alive. Held for the whole
// visible lifetime of the document (see wakeLock.ts for why it is not scoped to the game view).
// Exposed on `window` in the same spirit as the other `__couchCoop*` QA seams: "is the screen actually
// being held awake right now?" is otherwise unobservable from a phone, and that is exactly the question
// a live-device session needs to answer.
window.__couchCoopWakeLock = installScreenWakeLockFromGlobals();

const i18n = createBrowserI18n();
installLocaleSync(i18n);
createApp(App).use(i18n).mount("#app");
