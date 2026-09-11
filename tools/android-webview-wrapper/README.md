# CouchCoop Android WebView wrapper

This is a debuggable, hardware-accelerated profiling shell for the real CouchCoop frontend. It bundles no web
content: launch it with a loopback URL served by the host. The activity only accepts `http://127.0.0.1:<port>/...`,
so an ADB reverse is required for a host server. The launch task creates its own mapping.

The JavaScript bridge is deliberately sparse: `window.CouchCoopMarker.mark("milestone")` logs a device-monotonic
timestamp and accepts at most ten markers per second. It must not be called from animation frames.

Use the `mise` tasks at repository root. Device commands require the shared live-QA lock and only remove ADB
forwards/reverses recorded as created by the wrapper scripts.

For a Chrome-matched debug viewport, pass all five explicit launch options: `--content-width-px`,
`--content-height-px`, `--content-left-px`, `--content-top-px`, and `--density-dpi`. They are validated against the
native display and use pixel layout margins. Omit all five for the native WebView defaults. The density value is
recorded as requested; the debug CDP calibrator applies the actual Chromium
device scale factor. Release builds ignore these extras.

A CDP metrics override can match CSS coordinates while changing the physical size of the WebView output.
Verify both native device screenshots and the canvas backing size against Chrome. If native Android density
needs adjustment, record its original value, use a matching native content rectangle, and restore the original
density before Chrome measurements and cleanup. A matching Playwright screenshot alone is insufficient.

For a debug display-rate request, add `--refresh-rate-hz 60` to the launch command. The wrapper chooses the nearest
same-resolution supported display mode and logs the requested and selected rates; omitting it leaves the system mode.

`android-webview-capture` and `android-webview-export` collect wrapper diagnostics only. They do not claim to
collect Mali counters. `android-webview-profile` runs a bounded gatord capture and preserves the raw APC archive/log;
`android-webview-profile-export` exports its GPU counter timeline. Counters are global GPU scope, with the wrapper PID
recorded separately. A PID selection does not establish per-UID hardware attribution.


Build from the repository root:

```sh
mise run android-webview-setup
mise run android-webview-build
mise run android-webview-toolchain -- /absolute/ignored/capture/toolchain.txt
```

The root `mise.toml` pins Temurin 17.0.19, command-line tools 12.0, platform 35, and build-tools 35.0.0. Gradle reads
those SDK settings from the mise environment; its wrapper pins Gradle 8.11.1 and the build pins AGP 8.6.1.
Device tasks require `ADB_SERIAL`, `COUCHCOOP_LIVEQA_OWNER`, and `COUCHCOOP_LIVEQA_PID` matching the live-QA lock.

Prefer matching native Android density and content geometry when comparing with Chrome. Record and restore any
`adb shell wm density` override yourself; the launcher does not change system density. If a CDP override is needed
for diagnosis, provide `--viewport-width`, `--viewport-height`, and `--device-scale-factor` to
`mise run android-webview-launch -- <options> <url>`. Its persistent sidecar reapplies the override on navigation.
A CDP match alone is insufficient: verify actual `innerWidth`, `innerHeight`, DPR, physical content rectangle,
stage backing size, display mode, and presented cadence. Avoid Playwright screenshots during captures: they can
reset WebView CDP metrics. Use a native device screenshot outside the measured window instead.

Before profiling, place the installed Arm Studio arm64 `gatord` in the debuggable app's private directory, or set
`STREAMLINE_GATORD_PATH` to its device-side path. Enumerate supported counters on the actual device first. Set
`STREAMLINE_COUNTERS_FILE` (exact comma-separated counters), `STREAMLINE_DURATION_SECONDS` (1–99), and
`STREAMLINE_APC_OUT` (new ignored output path), then run `mise run android-webview-profile`. Export with
`STREAMLINE_CLI`, `STREAMLINE_APC_IN`, and `STREAMLINE_TIMELINE_OUT` via `mise run android-webview-profile-export`.
The script temporarily relaxes `security.perf_harden` and restores its previous value while it still owns the lock.
Do not use wrapper process RSS as GPU-process RSS: WebView can host its GPU threads inside the application process.

`mise run android-webview-cleanup` removes only exact mappings and calibrator processes owned by this session.
Restore the foreground page and release the live-QA lock separately after all capture work ends.
