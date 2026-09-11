// WS-PERSIST. The device-local persistence bridge for the CLIENT-side settings that used to reset every launch: the
// render-layer effect modes (ClientEffectSettings.ShaderMode / ParticleMode / RenderScale) plus the SettingsPanel
// "This device" toggles (widescreen stretch, raise-held-card, un-focus-on-release, tap-to-focus, disk asset cache).
//
// STORAGE: the EXISTING user://settings.cfg [mirror] section, via Godot ConfigFile — the same file + section that
// already holds lastHost (ConnectScreen / HostDiscoveryClient), lastPlayerName (ConnectionCoordinator) and
// lastAssetToken (AssetDiskCache). Load()/Save() follow those owners' exact load-modify-save shape: Save() ALWAYS
// cfg.Load()s first so it only rewrites OUR keys and never clobbers the three sibling keys. Each owner duplicates the
// path/section constants (the repo's established pattern — see ConnectScreen vs HostDiscoveryClient both spelling out
// "lastHost"), so we do the same for our own keys rather than reaching across namespaces.
//
// OWNERSHIP: this is a plain static class (like ClientEffectSettings + AssetDiskCache) so it has no scene lifetime.
//   * Load() is called ONCE, early in AppShell._Ready (before any render stage mounts), so the first
//     ApplyRenderScaleIfChanged already sees the persisted / platform-default RenderScale. It SEEDS ClientEffectSettings
//     (which stays pure C# / Godot-free — we are its Godot-side loader) and holds the five toggle DEFAULTS as
//     properties the SettingsPanel reads when it builds its CheckBoxes.
//   * Save(...) is called by SettingsPanel from every client-toggle / effect-mode change handler with the panel's live
//     values; it writes ClientEffectSettings.* (the effect statics are the source of truth for those three) plus the
//     five toggles. It also refreshes the held DEFAULTS so a later panel rebuild (Back-to-menu) seeds from the latest.
//
// FIRST RUN (key absent): every toggle keeps its existing code default (ON) and RenderScale is Full — on BOTH
// platforms. Desktop and mobile deliberately start from the SAME picture, so what a phone shows out of the box is
// what the desktop client shows. Android used to default to Half (phones are fill-bound; the half-res stage reaches
// 60 FPS vs ~30 at Full on the Mali-G615) and to directFull=OFF, but both of those trade AWAY text crispness — a
// half-res / design-res-collapsed stage is upscaled to the panel, so card text, relic tooltips and the TopBar never
// resolve sharply. USER-DECIDED 2026-08-01: crisp text beats those frames. Half + un-checking "Native full-scale
// rendering" are still one tap away in the panel for anyone who wants the fps back.
// TWO platform splits survive ON PURPOSE (both explicitly chosen — do NOT "unify" them): shaderMode (Static on
// Android / Dynamic on desktop) and staticBake (ON on Android / OFF on desktop); see their comments below.
// Once the user makes an explicit choice on ANY platform it is persisted and always wins thereafter — the platform /
// fresh-profile defaults here only ever fill in a MISSING key. A corrupt / unknown stored value (e.g. a hand-edited
// bad enum string) falls back to the same default, silently for the user but LOGGED for us.

using System;
using CouchCoop.GodotClient.Scene;
using Godot;

namespace CouchCoop.GodotClient.Ui;

public static class ClientSettingsStore
{
    // Same file + section the three sibling keys live in — NEVER clobber those (Save load-modify-saves).
    private const string SettingsPath = "user://settings.cfg";
    private const string CfgSection = "mirror";

    // Our own keys (camelCase, matching lastHost / lastPlayerName / lastAssetToken). Effect modes + render scale are
    // stored as their enum NAMES ("Dynamic"/"Static"/"Off", "Full"/"Half"/"Quarter") so the cfg is human-readable and
    // a bad hand-edit is caught by an Enum.TryParse + Enum.IsDefined guard rather than silently mis-mapping.
    private const string ShaderModeKey = "shaderMode";
    private const string ParticleModeKey = "particleMode";
    // R9 item 10. Stored as its OWN enum's name ("Auto"/"Dynamic"/"Static"/"Off") — deliberately NOT the shared
    // EffectMode (which has no Auto), so a hand-edited "Auto" in shaderMode still fails its own parse as before.
    private const string SpineModeKey = "spineMode";
    private const string RenderScaleKey = "renderScale";
    private const string RaiseHeldCardKey = "raiseHeldCard";
    private const string UnfocusOnReleaseKey = "unfocusOnRelease";
    private const string TapToFocusKey = "tapToFocus";
    private const string WidescreenStretchKey = "widescreenStretch";
    private const string DiskAssetCacheKey = "diskAssetCache";
    private const string CrispTextKey = "crispText";
    private const string DirectFullKey = "directFull";
    private const string StaticBakeKey = "staticBake";

    // The five toggle DEFAULTS SettingsPanel seeds its CheckBoxes from. Seeded to the existing code defaults (all ON)
    // and overwritten by Load(); Save() keeps them in sync with the panel's live values. (The three effect modes are
    // NOT mirrored here — ClientEffectSettings itself is their live home; Load seeds it and the OptionButtons read it.)
    public static bool RaiseHeldCard { get; private set; } = true;
    public static bool UnfocusOnRelease { get; private set; } = true;
    public static bool TapToFocus { get; private set; } = true;
    public static bool WidescreenStretch { get; private set; } = true;
    public static bool DiskAssetCache { get; private set; } = true;

    // Track-B "Crisp text (Half/Quarter)" toggle (default ON): promote safe static labels to a native-resolution
    // overlay so text stays crisp at a reduced render scale. RAM-only (never sent to the host); the TextOverlay
    // controller gates on it (and is inert at Full anyway). Read by the controller, persisted alongside the siblings.
    public static bool CrispText { get; private set; } = true;

    // WS-FULLRES "Native full-scale rendering" (directFull). On DESKTOP the render pipeline always uses the
    // native-resolution path (this stored value is ignored — DirectFullEffective forces it on there), so the SettingsPanel
    // shows the checkbox DISABLED + CHECKED. On MOBILE it is the interactive toggle, and its fresh-profile default is now
    // ON (was OFF): checked AND render scale Full switches the device from the Viewport-collapse pacing pipeline to the
    // desktop native-raster path (canvas_items + direct root hosting), which is what makes Full actually rasterize at the
    // panel's native pixels instead of upscaling a design-res composite. It is therefore the OTHER half of the crisp-text
    // decision that made Full the default scale — shipping Full with directFull OFF would still hand phones soft text.
    // The measured cost stands (direct-Full under canvas_items was +17% GPU cycles/frame on the fill-bound Mali-G615),
    // so mobile can still uncheck it; AppShell.DirectFullEffective/StretchCollapseEffective read this live, so the flip
    // applies without a restart. Initializer mirrors the Load() fallback so a Load-less path can't silently downgrade it.
    public static bool DirectFull { get; private set; } = true;

    // WS-FULLRES platform gate for the "Native full-scale rendering" UI + effective-value resolution: true on Android.
    // COUCHCOOP_MIRROR_FORCE_MOBILE_UI=1 forces it on desktop for TEST ONLY — so the mobile checkbox (interactive,
    // default unchecked) + the Viewport-collapse ↔ native-raster pipeline flip are exercisable under Xvfb. It gates ONLY
    // the UI enabled/default state + the effective-value resolution; nothing device-real. Read ONCE (repo env pattern).
    private static readonly bool ForceMobileUi =
        System.Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_FORCE_MOBILE_UI") == "1";

    public static bool IsMobileUi => OS.HasFeature("android") || ForceMobileUi;

    // WS-ADDBAKE "Static bake (combat fill)" toggle. Enables the static-bake system; persisted and QA-settable.
    // Platform default: Android depends on StaticBakeAndroidDefault, desktop FALSE. A user's explicit choice always
    // wins once persisted.
    public static bool StaticBake { get; private set; }

    // Android fresh-profile default for staticBake. WS-MISC item 3 (USER-DECIDED): flipped TRUE so phones bake combat
    // fill out of the box for the fps win (the user accepted the known minor additive-particle artifacts). Desktop is
    // always FALSE (opt-in via env or the checkbox). A user's explicit persisted choice always wins over this.
    // KEEP THE SPLIT: this is one of the two deliberate desktop/Android default differences (shaderMode is the other) —
    // the 2026-08-01 defaults unification deliberately left it alone, since the bake buys phone fps without softening
    // text, which is exactly the trade the render-scale change was NOT willing to make.
    private const bool StaticBakeAndroidDefault = true;

    // Read the persisted settings ONCE at startup: seed ClientEffectSettings.* and the toggle DEFAULTS above. A missing
    // file (fresh profile) or a missing key leaves the code default in place, and since 2026-08-01 that fresh-profile
    // picture is IDENTICAL on desktop and Android apart from the two deliberate splits below (shaderMode, staticBake) —
    // render scale is Full and directFull is ON everywhere. Never writes.
    public static void Load()
    {
        var cfg = new ConfigFile();
        bool fileLoaded = cfg.Load(SettingsPath) == Error.Ok; // false on a fresh profile — every key falls to default

        // Android fresh-profile default is Static (device-verified 2026-07-22: stills identical to Dynamic, ~+6fps
        // at Half — only continuous shader motion freezes). KEEP THE SPLIT: this is one of the two deliberate
        // desktop/Android default differences (staticBake is the other), left alone on purpose by the 2026-08-01
        // defaults unification because a frozen shader costs no sharpness. It used to mirror ReadRenderScale's platform
        // split, which is GONE — render scale is now Full everywhere. A user's persisted choice always wins.
        ClientEffectSettings.ShaderMode = ReadEffectMode(cfg, fileLoaded, ShaderModeKey,
            OS.HasFeature("android") ? EffectMode.Static : EffectMode.Dynamic);
        ClientEffectSettings.ParticleMode = ReadEffectMode(cfg, fileLoaded, ParticleModeKey, EffectMode.Dynamic);
        // R9 item 10: the manual spine override. Fresh-profile default is Auto on BOTH platforms — Auto == today's
        // native behavior (the full animated clip), so a fresh profile is byte-identical to before this feature.
        ClientEffectSettings.SpineMode = ReadSpineMode(cfg, fileLoaded, SpineMode.Auto);
        ClientEffectSettings.RenderScale = ReadRenderScale(cfg, fileLoaded);

        RaiseHeldCard = ReadBool(cfg, fileLoaded, RaiseHeldCardKey, true);
        UnfocusOnRelease = ReadBool(cfg, fileLoaded, UnfocusOnReleaseKey, true);
        TapToFocus = ReadBool(cfg, fileLoaded, TapToFocusKey, true);
        WidescreenStretch = ReadBool(cfg, fileLoaded, WidescreenStretchKey, true);
        DiskAssetCache = ReadBool(cfg, fileLoaded, DiskAssetCacheKey, true);
        CrispText = ReadBool(cfg, fileLoaded, CrispTextKey, true);
        DirectFull = ReadBool(cfg, fileLoaded, DirectFullKey, true); // WS-FULLRES: default ON both platforms (desktop ignores it)
        StaticBake = ReadBool(cfg, fileLoaded, StaticBakeKey,
            OS.HasFeature("android") ? StaticBakeAndroidDefault : false);

        // Deterministic-capture / QA override: COUCHCOOP_EFFECTS=off|static|dynamic forces BOTH effect modes, so a
        // --shot parity run can freeze the TIME-driven atmosphere shaders + particle sims that otherwise make a
        // capture differ frame-to-frame (used by the Track-D static-bake AE=0 corpus gate). Unset → the persisted /
        // platform-default modes above stand; this never touches normal play. Read here (the effect-mode seeder) so
        // AppShell's mount path stays untouched.
        var fxOverride = System.Environment.GetEnvironmentVariable("COUCHCOOP_EFFECTS");
        if (fxOverride is not null
            && Enum.TryParse<EffectMode>(fxOverride, ignoreCase: true, out var forcedFx)
            && Enum.IsDefined(forcedFx))
        {
            ClientEffectSettings.ShaderMode = forcedFx;
            ClientEffectSettings.ParticleMode = forcedFx;
            GD.Print($"CLIENT_SETTINGS: COUCHCOOP_EFFECTS override → shaderMode={forcedFx} particleMode={forcedFx}");
        }

        GD.Print($"CLIENT_SETTINGS: loaded fileExisted={fileLoaded} android={OS.HasFeature("android")} " +
                 $"shaderMode={ClientEffectSettings.ShaderMode} particleMode={ClientEffectSettings.ParticleMode} " +
                 $"spineMode={ClientEffectSettings.SpineMode} " +
                 $"widescreenStretch={WidescreenStretch} raiseHeldCard={RaiseHeldCard} " +
                 $"unfocusOnRelease={UnfocusOnRelease} tapToFocus={TapToFocus} diskAssetCache={DiskAssetCache} " +
                 $"crispText={CrispText} directFull={DirectFull} staticBake={StaticBake} " +
                 $"isMobileUi={IsMobileUi}");
        // Reuse the render layer's RENDER_SCALE: line so a --replay run (which does NOT mount the render stage without
        // --shot, so AppShell.ApplyRenderScaleIfChanged never logs) still surfaces the effective resolution for QA.
        GD.Print($"RENDER_SCALE: resolution={ClientEffectSettings.RenderScale} (persisted client settings load)");
    }

    // Persist the current CLIENT settings. Called by SettingsPanel from every relevant change handler with the panel's
    // live toggle values; the three effect modes are read straight off ClientEffectSettings (their source of truth).
    // Load-modify-save: cfg.Load first so the three sibling keys (lastHost / lastPlayerName / lastAssetToken) survive.
    // The optional parameters mirror the corresponding fresh-profile defaults (crispText/directFull ON), so a caller
    // that omits one can never silently persist a value BELOW the default the user would otherwise have had.
    public static void Save(
        bool raiseHeldCard, bool unfocusOnRelease, bool tapToFocus, bool widescreenStretch, bool diskAssetCache,
        bool crispText = true, bool directFull = true, bool? staticBake = null)
    {
        // Keep the held defaults current so a later panel rebuild (Back-to-menu) seeds its CheckBoxes from the latest.
        RaiseHeldCard = raiseHeldCard;
        UnfocusOnRelease = unfocusOnRelease;
        TapToFocus = tapToFocus;
        WidescreenStretch = widescreenStretch;
        DiskAssetCache = diskAssetCache;
        CrispText = crispText;
        DirectFull = directFull;
        StaticBake = staticBake ?? StaticBake; // null ⇒ keep the current value (a caller that doesn't own the toggle)

        var cfg = new ConfigFile();
        cfg.Load(SettingsPath); // ignore result — the file may not exist yet (same as the sibling owners)

        cfg.SetValue(CfgSection, ShaderModeKey, ClientEffectSettings.ShaderMode.ToString());
        cfg.SetValue(CfgSection, ParticleModeKey, ClientEffectSettings.ParticleMode.ToString());
        cfg.SetValue(CfgSection, SpineModeKey, ClientEffectSettings.SpineMode.ToString());
        cfg.SetValue(CfgSection, RenderScaleKey, ClientEffectSettings.RenderScale.ToString());
        cfg.SetValue(CfgSection, RaiseHeldCardKey, raiseHeldCard);
        cfg.SetValue(CfgSection, UnfocusOnReleaseKey, unfocusOnRelease);
        cfg.SetValue(CfgSection, TapToFocusKey, tapToFocus);
        cfg.SetValue(CfgSection, WidescreenStretchKey, widescreenStretch);
        cfg.SetValue(CfgSection, DiskAssetCacheKey, diskAssetCache);
        cfg.SetValue(CfgSection, CrispTextKey, crispText);
        cfg.SetValue(CfgSection, DirectFullKey, directFull);
        cfg.SetValue(CfgSection, StaticBakeKey, StaticBake);

        Error e = cfg.Save(SettingsPath);
        if (e != Error.Ok)
        {
            GD.PrintErr($"CLIENT_SETTINGS: failed to persist to {SettingsPath}: {e}");
            return;
        }

        GD.Print($"CLIENT_SETTINGS: saved shaderMode={ClientEffectSettings.ShaderMode} " +
                 $"particleMode={ClientEffectSettings.ParticleMode} spineMode={ClientEffectSettings.SpineMode} " +
                 $"renderScale={ClientEffectSettings.RenderScale} " +
                 $"widescreenStretch={widescreenStretch} raiseHeldCard={raiseHeldCard} " +
                 $"unfocusOnRelease={unfocusOnRelease} tapToFocus={tapToFocus} diskAssetCache={diskAssetCache} " +
                 $"crispText={crispText} directFull={directFull} staticBake={StaticBake}");
    }

    // Track Q (QA channel): RAM-only flip of the staticBake pref (no disk write), parity with SetCrispTextRuntime.
    // WS-MISC item 3: AppShell.ApplyStaticBakeEnableIfChanged polls this setting each frame and arms/disarms the
    // bound StaticBake, so this takes effect live (no reconnect) — same as SetDirectFullRuntime.
    public static void SetStaticBakeRuntime(bool on) => StaticBake = on;

    // Track Q (QA channel). The debug QA TCP control channel is enabled by a `[qa] port=<n>` key in this same
    // user://settings.cfg (the Android path — the file can be pushed via `run-as` before a session, since Android
    // apps can't set process env). Returns the configured port, or -1 when absent / out of range / the file is
    // missing. Read ONCE by AppShell at startup; never written here (a human / adb hand-edits the [qa] section).
    // Distinct from the [mirror] section above, so it never collides with the persisted client settings.
    public static int ReadQaPort()
    {
        var cfg = new ConfigFile();
        if (cfg.Load(SettingsPath) != Error.Ok || !cfg.HasSectionKey("qa", "port"))
        {
            return -1;
        }

        int port = cfg.GetValue("qa", "port", -1).AsInt32();
        return port is > 0 and < 65536 ? port : -1;
    }

    // Track Q (QA channel). RAM-only flip of the "Crisp text" pref (no disk write), so `setting crispText on|off` over
    // the QA socket mutates the SAME live value the TextOverlay controller polls — parity with how the effect-mode
    // statics (ClientEffectSettings.ShaderMode/ParticleMode/RenderScale) flip RAM-only via the `setting`/`renderscale`
    // verbs. The SettingsPanel's checkbox path persists via Save(); the QA channel deliberately does NOT (a QA session
    // must not pollute the user's persisted settings.cfg).
    public static void SetCrispTextRuntime(bool on) => CrispText = on;

    // WS-FULLRES. RAM-only flip of the "Native full-scale rendering" (directFull) pref (no disk write), so a QA session
    // (`setting directfull on|off`) mutates the SAME live static AppShell.DirectFullEffective/StretchCollapseEffective
    // poll — parity with SetCrispTextRuntime + the effect-mode QA verbs. Lets the mobile-branch simulation drive the
    // runtime content-scale flip over the socket. The SettingsPanel checkbox path persists via Save(); QA does NOT.
    public static void SetDirectFullRuntime(bool on) => DirectFull = on;

    // ---- readers (corrupt / unknown value → default, silently for the user but LOGGED) ---------------------------

    private static bool ReadBool(ConfigFile cfg, bool fileLoaded, string key, bool fallback)
    {
        if (!fileLoaded || !cfg.HasSectionKey(CfgSection, key))
        {
            return fallback;
        }

        // ConfigFile round-trips a bool as a real Variant, so AsBool is exact; a hand-edited garbage value coerces to
        // the Variant's bool default rather than throwing — acceptable for a device-local toggle.
        return cfg.GetValue(CfgSection, key, fallback).AsBool();
    }

    private static EffectMode ReadEffectMode(ConfigFile cfg, bool fileLoaded, string key, EffectMode fallback)
    {
        if (!fileLoaded || !cfg.HasSectionKey(CfgSection, key))
        {
            return fallback;
        }

        var raw = cfg.GetValue(CfgSection, key, "").AsString();
        if (Enum.TryParse<EffectMode>(raw, ignoreCase: true, out var mode) && Enum.IsDefined(typeof(EffectMode), mode))
        {
            return mode;
        }

        GD.PrintErr($"CLIENT_SETTINGS: unknown {key}='{raw}' in {SettingsPath} → default {fallback}");
        return fallback;
    }

    // R9 item 10. Its own parser (not ReadEffectMode) because the spine override has its own 4-value enum — reusing
    // the EffectMode reader would silently accept "Dynamic"/"Static"/"Off" but reject the DEFAULT value, Auto.
    private static SpineMode ReadSpineMode(ConfigFile cfg, bool fileLoaded, SpineMode fallback)
    {
        if (!fileLoaded || !cfg.HasSectionKey(CfgSection, SpineModeKey))
        {
            return fallback;
        }

        var raw = cfg.GetValue(CfgSection, SpineModeKey, "").AsString();
        if (Enum.TryParse<SpineMode>(raw, ignoreCase: true, out var mode) && Enum.IsDefined(typeof(SpineMode), mode))
        {
            return mode;
        }

        GD.PrintErr($"CLIENT_SETTINGS: unknown {SpineModeKey}='{raw}' in {SettingsPath} → default {fallback}");
        return fallback;
    }

    private static RenderScale ReadRenderScale(ConfigFile cfg, bool fileLoaded)
    {
        // The fresh-profile / fallback default is Full on EVERY platform — deliberately NOT platform-dependent any more.
        // History: Android defaulted to Half because phones are fill-bound and the half-res stage reached 60 FPS where
        // Full sat around 30 on the Mali-G615. But Half rasterizes the whole stage below the panel's resolution and the
        // present blit upscales it, so card text, relic tooltips and the TopBar are never crisp; the "Crisp text
        // (Half/Quarter)" overlay only rescues the SAFE static labels, not the rest of the frame. USER-DECIDED
        // 2026-08-01: crisp text is worth more than those frames, so desktop and mobile now start at the same
        // resolution. A phone user who prefers the fps picks Half in the panel — one OptionButton click, persisted from
        // then on. That persisted choice (like any explicit choice, on any platform) always wins over this default;
        // only a missing / corrupt key ever lands here.
        const RenderScale freshDefault = RenderScale.Full;

        if (!fileLoaded || !cfg.HasSectionKey(CfgSection, RenderScaleKey))
        {
            return freshDefault;
        }

        var raw = cfg.GetValue(CfgSection, RenderScaleKey, "").AsString();
        if (Enum.TryParse<RenderScale>(raw, ignoreCase: true, out var scale) &&
            Enum.IsDefined(typeof(RenderScale), scale))
        {
            return scale;
        }

        GD.PrintErr($"CLIENT_SETTINGS: unknown {RenderScaleKey}='{raw}' in {SettingsPath} → default {freshDefault}");
        return freshDefault;
    }
}
