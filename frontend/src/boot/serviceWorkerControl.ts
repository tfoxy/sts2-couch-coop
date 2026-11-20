const RELOAD_KEY = "couchCoop:tunnel-control-reload";

/** A hard reload bypasses control even with an active worker. Retry once, without a reload loop. */
export async function awaitServiceWorkerControl(
  sw: ServiceWorkerContainer,
  reload: () => void,
  hardReload: boolean,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">
): Promise<"controlled" | "reloading" | "unavailable"> {
  let changed!: () => void;
  const controlled = new Promise<void>(resolve => {
    changed = () => { if (sw.controller) resolve(); };
    sw.addEventListener("controllerchange", changed);
    changed();
  });
  try {
    await sw.register("/sw.js");
    await sw.ready;
    if (!sw.controller && hardReload) {
      if (storage.getItem(RELOAD_KEY)) return "unavailable";
      storage.setItem(RELOAD_KEY, "1");
      reload();
      return "reloading";
    }
    await controlled;
    storage.removeItem(RELOAD_KEY);
    return "controlled";
  } finally {
    sw.removeEventListener("controllerchange", changed);
  }
}
