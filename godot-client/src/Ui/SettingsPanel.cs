// OWNER: WS-N (UI screens). The Mirror settings chrome — a gear TAB (a left-edge half-pill, vertically centered)
// that opens a LEFT SIDEBAR panel (input-paused via UiRoot.ModalOpen, no dimming scrim).
//
// Native port of frontend/src/mirror/SettingsPanel.vue, split into the same concerns:
//   This device (client)  : raise held card / un-focus on release / tap to focus — RAM-only toggles WS-M reads
//                           off UiRoot.Toggle*; never sent to the game. Default ON.
//   Stream (this player)  : refresh-rate slider (4..60) + 24/30/40/60 presets + tween replay. Sent over the
//                           coordinator's `settings` channel. tween replay is PROCESS-GLOBAL (all viewers).
//   Host performance      : freeze particles / spines / decor — cut headless-host CPU without changing the view.
//   Latency               : network + game RTT (last/p50/p95/count); network green when p95<=50ms else red; a
//                           "floating overlay" checkbox keeps a compact top-right readout after the panel closes.
//
// UiRoot owns the coordinator: it reads the server getters here and calls SubmitSettings on ServerSettingsChanged,
// seeds the refresh rate once, and drives UpdateLatency each frame while probes are on (panel open OR overlay on).

using System;
using System.Globalization;
using CouchCoop.GodotClient.Scene;
using Godot;

namespace CouchCoop.GodotClient.Ui;

public sealed partial class SettingsPanel : Control
{
    private const int TargetMs = 50;
    private const int DefaultRefreshRate = 24;

    // Left-tab / sidebar geometry (design space). The tab is a half-pill flush to the left edge that bulges right
    // (mirrors the web `settings-tab`: 30x60 → scaled up for the 1920x1080 stage + touch); the sidebar sits just to
    // its right, vertically centered, and scrolls when its content overflows. CHROME_V4 grows the half-pill ~30%
    // (54→70 wide, 108→140 tall) for an easier phone touch target; the tab anchors flush-left + vertically-centered so
    // the size change re-anchors automatically (the open panel's OffsetLeft coupling below + GearRect follow from these
    // two values). static readonly (not const) so the env switch selects the size — every downstream use is a plain read.
    private const float TabWidth = 70f;
    private const float TabHeight = 140f;

    // The gear glyph font size — its OWN constant, NOT UiTheme.HeadingSize (shared by ConnectScreen etc.; must stay 34).
    // CHROME_V4 bumps it 34→44 to match the larger tab; "0" keeps the round-3 34 (== the old HeadingSize override).
    private const int GearGlyphSize = 44;

    private const float PanelWidth = 440f;
    private const float PanelPad = 20f;
    private const float ContentWidth = PanelWidth - 2 * PanelPad - 16; // fits inside the vertical scrollbar
    private const float PanelMaxHeight = 1080f * 0.92f;

    // Tab colors (mirror the web settings-tab): translucent black (hover darker), bluish-dark when open.
    private static readonly Color TabBg = new(0f, 0f, 0f, 0.72f);
    private static readonly Color TabHoverBg = new(0f, 0f, 0f, 0.85f);
    private static readonly Color TabOpenBg = new(0.078f, 0.094f, 0.125f, 0.9f);
    private static readonly Color TabBorder = new(1f, 1f, 1f, 0.18f);
    private static readonly Color SidebarBg = new(0.078f, 0.094f, 0.125f, 0.95f);

    // Raised when any SERVER control changes (UiRoot reads the getters and pushes the full settings payload).
    public event Action? ServerSettingsChanged;
    // Raised when the floating-overlay checkbox flips (UiRoot shows/hides LatencyOverlay).
    public event Action<bool>? OverlayEnabledChanged;
    // Native-only session controls (Reload → coordinator.Resync; Back to menu → AppShell.ReturnToMenu). Mirror the
    // ServerSettingsChanged/OverlayEnabledChanged pattern; UiRoot subscribes and drives the coordinator / AppShell.
    public event Action? ReloadRequested;
    public event Action? BackToMenuRequested;

    private bool _open;
    private bool _suppressServerEvent;

    private Button _gear = null!;
    private PanelContainer _panel = null!;

    private CheckBox _raiseHeldCard = null!;
    private CheckBox _unfocusOnRelease = null!;
    private CheckBox _tapToFocus = null!;
    private CheckBox _widescreenStretch = null!;
    private CheckBox _diskAssetCache = null!;
    private CheckBox _crispText = null!;
    private CheckBox _directFull = null!;
    private CheckBox _staticBake = null!;
    private OptionButton _shaderModeOption = null!;
    private OptionButton _particleModeOption = null!;
    private OptionButton _spineModeOption = null!;
    private OptionButton _renderScaleOption = null!;

    private HSlider _refreshSlider = null!;
    private Label _refreshValue = null!;
    private Button[] _presetButtons = Array.Empty<Button>();
    private static readonly int[] RefreshPresets = { 24, 30, 40, 60 };
    private CheckBox _tweenReplay = null!;
    private CheckBox _freezeParticles = null!;
    private CheckBox _freezeSpines = null!;
    private CheckBox _freezeDecor = null!;

    private Label _netLabel = null!;
    private Label _gameLabel = null!;
    private CheckBox _overlayCheck = null!;

    // ---- public surface UiRoot / AppShell read ----------------------------------------------------------------

    public bool PanelOpen => _open;
    public bool OverlayEnabled => _overlayCheck?.ButtonPressed ?? false;

    public bool RaiseHeldCard => _raiseHeldCard?.ButtonPressed ?? true;
    public bool UnfocusOnRelease => _unfocusOnRelease?.ButtonPressed ?? true;
    public bool TapToFocus => _tapToFocus?.ButtonPressed ?? true;

    // M2 WS-R: the "Widescreen stretch" client toggle (RAM-only, default ON) — CheckBox-backed exactly like the
    // sibling client toggles above. UiRoot.ToggleStretch reads this; AppShell/StageStretch poll it live every frame to
    // widen/un-widen the stage. Read-only getter (nothing assigns it — the checkbox is the sole source of truth).
    public bool StretchEnabled => _widescreenStretch?.ButtonPressed ?? true;

    // M3 WS-U: the "Disk asset cache" client toggle (flips AssetDiskCache.Enabled). Exposed as a getter so
    // ClientSettingsStore.Save can persist its live state alongside the other client toggles.
    public bool DiskAssetCache => _diskAssetCache?.ButtonPressed ?? true;

    // Track-B: the "Crisp text (Half/Quarter)" client toggle (RAM-only, default ON). The TextOverlay controller polls
    // ClientSettingsStore.CrispText (which this persists); exposed as a getter for the QA/verifier + Save.
    public bool CrispText => _crispText?.ButtonPressed ?? true;

    // WS-FULLRES: the "Native full-scale rendering" (directFull) client toggle. Desktop: disabled + checked (the desktop
    // pipeline always rasterizes at native res). Mobile: interactive, fresh-profile default ON since 2026-08-01.
    // AppShell.DirectFullEffective reads ClientSettingsStore.DirectFull (which this persists); exposed as a getter for
    // the QA/verifier + Save. The null-guard tracks the default (the checkbox is built before any Toggled handler can
    // fire, so it is unreachable in practice — but it must never be the value that persists on a fresh profile).
    public bool DirectFull => _directFull?.ButtonPressed ?? true;

    // WS-ADDBAKE: the "Static bake (combat fill)" client toggle. WS-MISC item 3 makes AppShell poll the setting each
    // frame, so a flip arms/disarms the live bake without a reconnect. Exposed as a getter for Save; default follows
    // ClientSettingsStore.
    public bool StaticBake => _staticBake?.ButtonPressed ?? false;

    // WS-EFFECTS-NATIVE: the client-side effect modes (Dynamic / Static / Off), RAM-only, NOT sent to the host. The
    // OptionButtons are the sole writer of ClientEffectSettings (which the render layer reads); these getters mirror
    // the checkbox-getter pattern above so a test/verifier can read the panel's live selection.
    public EffectMode ShaderMode => _shaderModeOption is null ? EffectMode.Dynamic : (EffectMode)_shaderModeOption.Selected;
    public EffectMode ParticleMode => _particleModeOption is null ? EffectMode.Dynamic : (EffectMode)_particleModeOption.Selected;

    public RenderScale RenderResolution => _renderScaleOption is null
        ? RenderScale.Full
        : RenderScaleFromIndex(_renderScaleOption.Selected);

    public int RefreshRate => _refreshSlider is null ? DefaultRefreshRate : (int)Math.Round(_refreshSlider.Value);
    public bool TweenReplay => _tweenReplay?.ButtonPressed ?? true;
    public bool FreezeParticles => _freezeParticles?.ButtonPressed ?? true;
    public bool FreezeSpines => _freezeSpines?.ButtonPressed ?? true;
    public bool FreezeDecor => _freezeDecor?.ButtonPressed ?? true;

    public Rect2 GearRect => _gear.GetGlobalRect();
    // The open sidebar's rect (design space) so UiRoot.IsPointOverChrome covers just the panel, not the whole surface.
    public Rect2 PanelRect => _panel.GetGlobalRect();

    public override void _Ready()
    {
        // A CanvasLayer-child Control does not anchor to the viewport, so size it explicitly to the LIVE design space
        // (viewport visible rect == ContentScaleSize). The tab + sidebar anchor to the LEFT edge, so they stay pinned
        // left at any width; filling the true width just keeps the design-space rects honest. Kept current by _Process.
        FitToViewport();
        MouseFilter = MouseFilterEnum.Ignore;

        BuildPanel();
        BuildGear(); // added AFTER the panel so the tab draws on top and stays clickable
    }

    // Re-fit to the live design width whenever it changes (StageStretch widening / un-widening); cheap size compare.
    public override void _Process(double delta)
    {
        if (Size != GetViewport().GetVisibleRect().Size)
        {
            FitToViewport();
        }
    }

    private void FitToViewport()
    {
        Position = Vector2.Zero;
        Size = GetViewport().GetVisibleRect().Size;
    }

    public void SetOpen(bool open)
    {
        _open = open;
        _panel.Visible = open;
        _gear.Text = open ? "×" : "⚙";
        _gear.AddThemeStyleboxOverride("normal", TabStyle(open ? TabOpenBg : TabBg));
    }

    // Seed the refresh-rate slider once from the host's real baseline (clamped 4..60; out-of-range/0 → 60). This
    // only updates the displayed value; it does NOT push settings (matches the web — only user edits push).
    public void SeedRefreshRate(int reported)
    {
        int clamped = reported is >= 4 and <= 60 ? reported : 60;
        _suppressServerEvent = true;
        _refreshSlider.Value = clamped;
        _suppressServerEvent = false;
        UpdateRefreshUi();
    }

    // ---- test hooks (WS-N verification only; driven by UiRoot from env vars) ----------------------------------

    // Programmatically enable/disable the floating overlay (fires OverlayEnabledChanged like a user click).
    public void ForceOverlay(bool on)
    {
        if (_overlayCheck.ButtonPressed != on)
        {
            _overlayCheck.ButtonPressed = on;
        }
    }

    // Flip one server control so a settings push fires without external input automation.
    public void TestFlipServerControl()
    {
        _freezeParticles.ButtonPressed = !_freezeParticles.ButtonPressed;
    }

    // Set the widescreen-stretch client toggle (RAM-only) so WS-R can OBSERVE StretchEnabled → UiRoot.ToggleStretch
    // track the checkbox offline (proving it isn't just the `?? true` fallback). The live relayout flip is verified at
    // integration once StageStretch.DefaultEnabled is on.
    public void TestSetStretch(bool on)
    {
        if (_widescreenStretch.ButtonPressed != on)
        {
            _widescreenStretch.ButtonPressed = on;
        }
    }

    public void UpdateLatency(Net.LatencySnapshot net, Net.LatencySnapshot game)
    {
        bool ok = net.P95 is { } p95 && p95 <= TargetMs;
        _netLabel.Text = $"Network   last {Fmt(net.LastMs)}   p50 {Fmt(net.P50)}   p95 {Fmt(net.P95)}   n={net.Count}";
        _netLabel.AddThemeColorOverride("font_color", net.Count == 0 ? UiTheme.Muted : (ok ? UiTheme.Good : UiTheme.Bad));

        _gameLabel.Text = game.Count == 0
            ? "Game (end-to-end)   —"
            : $"Game (e2e)   last {Fmt(game.LastMs)}   p50 {Fmt(game.P50)}   p95 {Fmt(game.P95)}   n={game.Count}";
    }

    // ---- build --------------------------------------------------------------------------------------------------

    // A LEFT SIDEBAR (not a centered modal): a fixed-rect panel just right of the tab, vertically centered, with a
    // ScrollContainer so the content never overflows the phone screen. Input is paused via UiRoot.ModalOpen while it
    // is open (touch-safe), so there is no dimming scrim.
    private void BuildPanel()
    {
        _panel = UiTheme.Qa(UiTheme.Panel(SidebarBg, pad: (int)PanelPad), "settings_panel");
        _panel.Visible = false;
        _panel.MouseFilter = MouseFilterEnum.Stop; // clicks on the sidebar body must NOT reach the game underneath
        _panel.AnchorLeft = 0f;
        _panel.AnchorRight = 0f;
        _panel.AnchorTop = 0.5f;
        _panel.AnchorBottom = 0.5f;
        _panel.OffsetLeft = TabWidth + 8;
        _panel.OffsetRight = TabWidth + 8 + PanelWidth;
        _panel.OffsetTop = -PanelMaxHeight / 2f;
        _panel.OffsetBottom = PanelMaxHeight / 2f;
        AddChild(_panel);

        var scroll = new ScrollContainer
        {
            HorizontalScrollMode = ScrollContainer.ScrollMode.Disabled, // width is authored to fit; never scroll sideways
            SizeFlagsHorizontal = SizeFlags.ExpandFill,
            SizeFlagsVertical = SizeFlags.ExpandFill,
            // WS-SCROLLFIX: while the sidebar is modal the app GestureMachine is bypassed, so raw Godot Control input
            // wins and emulate_mouse_from_touch makes every touch a press — a drag-to-scroll was toggling the checkbox
            // under the finger. A touch-slop deadzone (~18 design px, larger than the 8px tap slop) lets a deliberate
            // drag-scroll cancel the child press and pan, while a stationary tap still falls inside the deadzone and
            // toggles. Tunable on-device by the main session.
            ScrollDeadzone = 18,
        };
        _panel.AddChild(scroll);

        var col = new VBoxContainer();
        col.AddThemeConstantOverride("separation", 6);
        col.SizeFlagsHorizontal = SizeFlags.ExpandFill;
        col.CustomMinimumSize = new Vector2(ContentWidth, 0);
        scroll.AddChild(col);

        // Header.
        var header = new HBoxContainer();
        var heading = UiTheme.MakeLabel("Mirror settings", UiTheme.HeadingSize, UiTheme.Text);
        heading.SizeFlagsHorizontal = SizeFlags.ExpandFill;
        header.AddChild(heading);
        var close = UiTheme.MakeButton("Close", UiTheme.SmallSize);
        close.Pressed += () => SetOpen(false);
        header.AddChild(close);
        col.AddChild(header);

        BuildSessionGroup(col);
        BuildClientGroup(col);
        BuildStreamGroup(col);
        BuildHostGroup(col);
        BuildLatencyGroup(col);
    }

    // Native-only session controls (no web analog): re-sync the mirror (fresh keyframe) or drop back to the Connect
    // screen. Raised as events UiRoot forwards to the coordinator / AppShell.
    private void BuildSessionGroup(VBoxContainer col)
    {
        GroupHeader(col, "Session");
        var row = new HBoxContainer();
        row.AddThemeConstantOverride("separation", 8);

        var reload = UiTheme.Qa(UiTheme.MakeButton("Reload", UiTheme.SmallSize), "settings_reload");
        reload.SizeFlagsHorizontal = SizeFlags.ExpandFill;
        reload.Pressed += () => ReloadRequested?.Invoke();
        row.AddChild(reload);

        var back = UiTheme.Qa(UiTheme.MakeButton("Back to menu", UiTheme.SmallSize), "settings_back_to_menu");
        back.SizeFlagsHorizontal = SizeFlags.ExpandFill;
        back.Pressed += () => BackToMenuRequested?.Invoke();
        row.AddChild(back);

        col.AddChild(row);
    }

    private void BuildClientGroup(VBoxContainer col)
    {
        // WS-PERSIST: every "This device" control seeds from ClientSettingsStore (loaded once at startup from
        // user://settings.cfg) instead of a hard-coded default, and calls PersistClientSettings() from its change
        // handler so the choice survives the next launch. The effect OptionButtons already seed from
        // ClientEffectSettings, which Load() seeded before this panel built — so they inherit persistence for free.
        GroupHeader(col, "This device");
        _raiseHeldCard = UiTheme.Qa(
            ClientToggle(col, "Raise held card", ClientSettingsStore.RaiseHeldCard), "toggle_raise_held_card");
        _raiseHeldCard.Toggled += _ => PersistClientSettings();
        _unfocusOnRelease = UiTheme.Qa(
            ClientToggle(col, "Un-focus card on release", ClientSettingsStore.UnfocusOnRelease), "toggle_unfocus_on_release");
        _unfocusOnRelease.Toggled += _ => PersistClientSettings();
        _tapToFocus = UiTheme.Qa(
            ClientToggle(col, "Tap to focus", ClientSettingsStore.TapToFocus), "toggle_tap_to_focus");
        _tapToFocus.Toggled += _ => PersistClientSettings();

        // M2 WS-R: widescreen stretch (default ON). No server push — AppShell/StageStretch poll
        // UiRoot.ToggleStretch → StretchEnabled every frame and re-widen the stage when it flips.
        _widescreenStretch = UiTheme.Qa(
            ClientToggle(col, "Widescreen stretch", ClientSettingsStore.WidescreenStretch), "toggle_widescreen_stretch");
        _widescreenStretch.Toggled += on =>
        {
            GD.Print($"M2_STRETCH: widescreen-stretch toggle → {on}");
            PersistClientSettings();
        };

        // M3 WS-U: disk asset cache (runtime flip of the static AssetDiskCache.Enabled, default ON). The env
        // COUCHCOOP_ASSET_CACHE=0 is the authoritative construction-time kill switch; this toggle flips the live flag
        // that every store's fetch seam re-reads. No server push — purely a device-local cache control (now persisted;
        // AssetDiskCache.Create honors the saved value as its enabled default when the env is unset).
        _diskAssetCache = UiTheme.Qa(
            ClientToggle(col, "Disk asset cache", ClientSettingsStore.DiskAssetCache), "toggle_disk_asset_cache");
        _diskAssetCache.Toggled += on =>
        {
            AssetDiskCache.Enabled = on;
            GD.Print($"M3_CACHE: disk-asset-cache toggle → {on}");
            PersistClientSettings();
        };

        // WS-EFFECTS-NATIVE: native effect modes (Dynamic / Static / Off), device-local client prefs (NOT sent to
        // host). Dynamic = the full animated effect; Static = the art rendered FROZEN (visible, zero per-frame cost);
        // Off = not rendered. Distinct from the host-side "Freeze particles/spines" savers below (those cut headless-
        // HOST CPU without changing the view). Each row seeds from + writes ClientEffectSettings, whose Generation bump
        // the reconciler polls to live-refresh the render stage — no server push (same shape as the widescreen toggle).
        _shaderModeOption = UiTheme.Qa(
            EffectModeRow(col, "Shader effects", (int)ClientEffectSettings.ShaderMode), "mode_shader_effects");
        _shaderModeOption.ItemSelected += idx =>
        {
            ClientEffectSettings.ShaderMode = (EffectMode)(int)idx;
            GD.Print($"EFFECTS_NATIVE: shader-mode → {(EffectMode)(int)idx}");
            PersistClientSettings();
        };

        _particleModeOption = UiTheme.Qa(
            EffectModeRow(col, "Particle effects", (int)ClientEffectSettings.ParticleMode), "mode_particle_effects");
        _particleModeOption.ItemSelected += idx =>
        {
            ClientEffectSettings.ParticleMode = (EffectMode)(int)idx;
            GD.Print($"EFFECTS_NATIVE: particle-mode → {(EffectMode)(int)idx}");
            PersistClientSettings();
        };

        // R9 item 10: the manual SPINE override. Its own 4-value enum (Auto keeps today's behavior — the full animated
        // clip on native, the device's tier decision on the web twin), so it deliberately does NOT reuse the shared
        // Dynamic/Static/Off EffectMode row values. Static requests the single `&still=1` frame the clip store already
        // knows how to build and stops the per-frame advance; Off detaches the layer entirely (SpineAttachment.Sync).
        // Same Generation-poll live-apply as the two rows above — no reconnect.
        _spineModeOption = UiTheme.Qa(
            SpineModeRow(col, "Spine animations", (int)ClientEffectSettings.SpineMode), "mode_spine_animations");
        _spineModeOption.ItemSelected += idx =>
        {
            ClientEffectSettings.SpineMode = (SpineMode)(int)idx;
            GD.Print($"EFFECTS_NATIVE: spine-mode → {(SpineMode)(int)idx}");
            PersistClientSettings();
        };

        // Native mirror render resolution. Fresh-profile default is Full on BOTH desktop and Android since 2026-08-01
        // (Half was the old Android default, traded away because a half-res stage upscales and text stops being crisp —
        // see ClientSettingsStore.ReadRenderScale); Half/Quarter remain one click away here for phone users who want the
        // fps back. The enum values are the actual viewport shrink factors (1/2/4), so the OptionButton's contiguous
        // indices are mapped explicitly rather than cast.
        _renderScaleOption = UiTheme.Qa(
            RenderResolutionRow(col, "Render resolution", RenderScaleIndex(ClientEffectSettings.RenderScale)),
            "render_resolution");
        _renderScaleOption.ItemSelected += idx =>
        {
            ClientEffectSettings.RenderScale = RenderScaleFromIndex(idx);
            GD.Print($"RENDER_SCALE: resolution={ClientEffectSettings.RenderScale}");
            PersistClientSettings();
        };

        // Track-B: "Crisp text (Half/Quarter)" — promote safe static labels to a native-resolution overlay so text
        // stays crisp at a reduced render scale (inert at Full). Device-local, no server push (same shape as the
        // sibling client toggles); the TextOverlay controller polls ClientSettingsStore.CrispText which this persists.
        _crispText = UiTheme.Qa(
            ClientToggle(col, "Crisp text (Half/Quarter)", ClientSettingsStore.CrispText), "toggle_crisp_text");
        _crispText.Toggled += on =>
        {
            GD.Print($"TEXT_OVERLAY: crisp-text toggle → {on}");
            PersistClientSettings();
        };

        // WS-FULLRES: "Native full-scale rendering" — at Full render scale, rasterize the mirror stage at the native
        // window resolution (canvas_items content scale + direct root hosting) instead of the design-res Viewport
        // collapse, so card text + TopBar icons stay crisp on a hidpi screen. DESKTOP always uses this path, so the
        // checkbox is disabled and checked on desktop.
        // MOBILE: interactive, and its fresh-profile default is now ON (was OFF) so a phone starts as crisp as desktop —
        // it is the companion of the Full render-scale default; Full without it would still upscale a design-res
        // composite. Unchecking it (or dropping to Half/Quarter) returns to the Viewport-collapse pacing pipeline.
        // Hence the seed below: on mobile it reads the STORE (the persisted value, default true and now starting
        // CHECKED), on desktop it hard-codes true because the stored value is ignored there entirely. AppShell polls
        // ClientSettingsStore.DirectFull live and flips Window.ContentScaleMode at runtime (no restart needed).
        bool mobileUi = ClientSettingsStore.IsMobileUi;
        _directFull = UiTheme.Qa(
            ClientToggle(col, "Native full-scale rendering", mobileUi ? ClientSettingsStore.DirectFull : true),
            "toggle_direct_full");
        _directFull.Disabled = !mobileUi; // desktop: greyed + checked (always-on); mobile: interactive opt-in
        _directFull.Toggled += on =>
        {
            GD.Print($"FULLRES: native-full toggle → {on}");
            PersistClientSettings();
        };

        // WS-ADDBAKE: "Static bake (combat fill)" — enables the static-bake system. Device-local. WS-MISC item 3:
        // AppShell polls the setting every frame, so a flip arms/disarms the live bake immediately (no reconnect
        // needed).
        _staticBake = UiTheme.Qa(
            ClientToggle(col, "Static bake (combat fill)", ClientSettingsStore.StaticBake), "toggle_static_bake");
        _staticBake.Toggled += on =>
        {
            GD.Print($"STATIC_BAKE: static-bake toggle → {on}");
            PersistClientSettings();
        };
    }

    // WS-PERSIST: write the current "This device" settings to user://settings.cfg. Reads the panel's live toggle
    // getters + ClientEffectSettings.* (the effect statics being the source of truth for the three modes). Called from
    // every client-toggle / effect-mode change handler; host-stream knobs (refresh rate, freeze*, tween replay) stay
    // session-scoped and are NOT persisted here.
    private void PersistClientSettings() =>
        ClientSettingsStore.Save(RaiseHeldCard, UnfocusOnRelease, TapToFocus, StretchEnabled, DiskAssetCache, CrispText,
            DirectFull, StaticBake);

    // A labeled effect-mode selector row (label + Dynamic/Static/Off OptionButton), seeded to `selected`. Returns the
    // OptionButton so the caller wires its ItemSelected. Mirrors the sibling ClientToggle rows' layout.
    private OptionButton EffectModeRow(VBoxContainer col, string label, int selected)
    {
        var row = new HBoxContainer();
        row.AddThemeConstantOverride("separation", 8);
        var lbl = UiTheme.MakeLabel(label, UiTheme.SmallSize);
        lbl.SizeFlagsHorizontal = SizeFlags.ExpandFill;
        // WS-SCROLL: the ExpandFill label spans most of the row — let a drag over it pass to the ScrollContainer so
        // the settings list still pans there (same seam as the refresh-rate row; the OptionButton stays a tap island).
        lbl.MouseFilter = MouseFilterEnum.Pass;
        row.AddChild(lbl);
        var opt = UiTheme.MakeOptionButton(new[] { "Dynamic", "Static", "Off" }, selected, UiTheme.SmallSize);
        row.AddChild(opt);
        col.AddChild(row);
        return opt;
    }

    // R9 item 10: the spine-override row — EffectModeRow's shape with the four SpineMode values (Auto first, so the
    // enum's default is index 0 exactly like the EffectMode rows' Dynamic).
    private OptionButton SpineModeRow(VBoxContainer col, string label, int selected)
    {
        var row = new HBoxContainer();
        row.AddThemeConstantOverride("separation", 8);
        var lbl = UiTheme.MakeLabel(label, UiTheme.SmallSize);
        lbl.SizeFlagsHorizontal = SizeFlags.ExpandFill;
        lbl.MouseFilter = MouseFilterEnum.Pass; // WS-SCROLL: let a drag over the label pan the settings list
        row.AddChild(lbl);
        var opt = UiTheme.MakeOptionButton(new[] { "Auto", "Dynamic", "Static", "Off" }, selected, UiTheme.SmallSize);
        row.AddChild(opt);
        col.AddChild(row);
        return opt;
    }

    private OptionButton RenderResolutionRow(VBoxContainer col, string label, int selected)
    {
        var row = new HBoxContainer();
        row.AddThemeConstantOverride("separation", 8);
        var lbl = UiTheme.MakeLabel(label, UiTheme.SmallSize);
        lbl.SizeFlagsHorizontal = SizeFlags.ExpandFill;
        lbl.MouseFilter = MouseFilterEnum.Pass;
        row.AddChild(lbl);
        var opt = UiTheme.MakeOptionButton(new[] { "Full", "Half", "Quarter" }, selected, UiTheme.SmallSize);
        row.AddChild(opt);
        col.AddChild(row);
        return opt;
    }

    private static int RenderScaleIndex(RenderScale scale) => scale switch
    {
        RenderScale.Full => 0,
        RenderScale.Half => 1,
        RenderScale.Quarter => 2,
        _ => 0,
    };

    private static RenderScale RenderScaleFromIndex(long index) => index switch
    {
        1 => RenderScale.Half,
        2 => RenderScale.Quarter,
        _ => RenderScale.Full,
    };

    private void BuildStreamGroup(VBoxContainer col)
    {
        GroupHeader(col, "Stream (this player)");

        var sliderRow = new HBoxContainer();
        sliderRow.AddThemeConstantOverride("separation", 8);
        // Let a drag that starts over the row's label pass through to the ScrollContainer so the settings list still
        // pans there (the HSlider beside it stays its own tap/drag island — acceptable). Mirrors the checkbox fix in
        // UiTheme.MakeCheck; the drag-scroll seam for a row that pairs a label with a non-checkbox control.
        var refreshLabel = UiTheme.MakeLabel("Refresh rate", UiTheme.SmallSize);
        refreshLabel.MouseFilter = MouseFilterEnum.Pass;
        sliderRow.AddChild(refreshLabel);
        _refreshSlider = UiTheme.Qa(new HSlider { MinValue = 4, MaxValue = 60, Step = 1, Value = DefaultRefreshRate }, "refresh_rate_slider");
        _refreshSlider.CustomMinimumSize = new Vector2(120, 40);
        _refreshSlider.SizeFlagsHorizontal = SizeFlags.ExpandFill;
        _refreshSlider.SizeFlagsVertical = SizeFlags.ShrinkCenter;
        _refreshSlider.ValueChanged += _ => OnRefreshChanged();
        sliderRow.AddChild(_refreshSlider);
        _refreshValue = UiTheme.MakeLabel($"{DefaultRefreshRate} fps", UiTheme.SmallSize, UiTheme.Muted);
        _refreshValue.CustomMinimumSize = new Vector2(80, 0);
        sliderRow.AddChild(_refreshValue);
        col.AddChild(sliderRow);

        // Quick presets.
        var presetRow = new HBoxContainer();
        presetRow.AddThemeConstantOverride("separation", 8);
        _presetButtons = new Button[RefreshPresets.Length];
        for (int i = 0; i < RefreshPresets.Length; i++)
        {
            int preset = RefreshPresets[i];
            var button = UiTheme.MakeButton(preset.ToString(CultureInfo.InvariantCulture), UiTheme.SmallSize);
            button.SizeFlagsHorizontal = SizeFlags.ExpandFill;
            button.Pressed += () => _refreshSlider.Value = preset; // triggers ValueChanged → push
            presetRow.AddChild(button);
            _presetButtons[i] = button;
        }

        col.AddChild(presetRow);
        Note(col, "Lower = less CPU on weak phones (card motion stays smooth via tween replay).");

        _tweenReplay = UiTheme.Qa(ServerToggle(col, "Tween replay", true), "toggle_tween_replay");
        Note(col, "Tween replay applies to ALL viewers (process-global).");
    }

    private void BuildHostGroup(VBoxContainer col)
    {
        GroupHeader(col, "Host performance");
        Note(col, "Cuts headless-host CPU. Doesn't change what you see.");
        _freezeParticles = UiTheme.Qa(ServerToggle(col, "Freeze particles", true), "toggle_freeze_particles");
        _freezeSpines = UiTheme.Qa(ServerToggle(col, "Freeze spines", true), "toggle_freeze_spines");
        _freezeDecor = UiTheme.Qa(ServerToggle(col, "Freeze decor (advanced)", true), "toggle_freeze_decor");
    }

    private void BuildLatencyGroup(VBoxContainer col)
    {
        GroupHeader(col, "Latency");
        var block = new VBoxContainer();
        block.AddThemeConstantOverride("separation", 4);
        UiTheme.Qa(block, "latency_block");
        col.AddChild(block);

        _netLabel = UiTheme.MakeLabel("Network   —", UiTheme.SmallSize, UiTheme.Muted);
        block.AddChild(_netLabel);
        _gameLabel = UiTheme.MakeLabel("Game (end-to-end)   —", UiTheme.SmallSize, UiTheme.Muted);
        block.AddChild(_gameLabel);

        _overlayCheck = UiTheme.MakeCheck("Show floating overlay", false, UiTheme.SmallSize);
        _overlayCheck.Toggled += on => OverlayEnabledChanged?.Invoke(on);
        col.AddChild(_overlayCheck);
    }

    // The always-present LEFT tab: a half-pill flush to the left edge, vertically centered, that bulges right (only
    // the right corners are rounded). Mirrors the web settings-tab; the glyph flips ⚙↔× in SetOpen.
    private void BuildGear()
    {
        _gear = UiTheme.Qa(new Button { Text = "⚙" }, "settings_gear");
        _gear.AddThemeFontSizeOverride("font_size", GearGlyphSize); // WS-MISC item 7: gear glyph scales with the tab (CHROME_V4)
        _gear.AddThemeColorOverride("font_color", new Color(1f, 1f, 1f, 0.85f)); // centered gear at ~85% opacity
        _gear.AddThemeStyleboxOverride("normal", TabStyle(TabBg));
        _gear.AddThemeStyleboxOverride("hover", TabStyle(TabHoverBg));
        _gear.AddThemeStyleboxOverride("pressed", TabStyle(TabOpenBg));

        // WS-MISC item 8: no focus outline on the gear (CHROME_V4). A Button defaults to FocusModeEnum.All, so a click
        // grabs keyboard focus and the theme draws a focus ring around the tab; None makes it unfocusable (a pure
        // pointer button), and an empty focus StyleBox guarantees no ring even if a theme drew one. "0" keeps the
        // round-3 default focus behavior.
        _gear.FocusMode = FocusModeEnum.None;
        _gear.AddThemeStyleboxOverride("focus", new StyleBoxEmpty());

        // Left edge, vertically centered: a TabWidth x TabHeight half-pill flush to x=0.
        _gear.AnchorLeft = 0f;
        _gear.AnchorRight = 0f;
        _gear.AnchorTop = 0.5f;
        _gear.AnchorBottom = 0.5f;
        _gear.OffsetLeft = 0f;
        _gear.OffsetRight = TabWidth;
        _gear.OffsetTop = -TabHeight / 2f;
        _gear.OffsetBottom = TabHeight / 2f;
        _gear.Pressed += () => SetOpen(!_open);
        AddChild(_gear);
    }

    // Half-pill StyleBoxFlat: ONLY the right corners rounded (radius = height/2), the web tab bg/border colors.
    private static StyleBoxFlat TabStyle(Color bg)
    {
        var sb = new StyleBoxFlat { BgColor = bg, BorderColor = TabBorder };
        sb.CornerRadiusTopLeft = 0;
        sb.CornerRadiusBottomLeft = 0;
        sb.CornerRadiusTopRight = (int)(TabHeight / 2f);
        sb.CornerRadiusBottomRight = (int)(TabHeight / 2f);
        sb.SetBorderWidthAll(1);
        sb.SetContentMarginAll(4);
        return sb;
    }

    // ---- helpers ------------------------------------------------------------------------------------------------

    private CheckBox ClientToggle(VBoxContainer col, string text, bool on)
    {
        var box = UiTheme.MakeCheck(text, on, UiTheme.SmallSize);
        col.AddChild(box);
        return box;
    }

    private CheckBox ServerToggle(VBoxContainer col, string text, bool on)
    {
        var box = UiTheme.MakeCheck(text, on, UiTheme.SmallSize);
        box.Toggled += _ => RaiseServerChanged();
        col.AddChild(box);
        return box;
    }

    private void OnRefreshChanged()
    {
        UpdateRefreshUi();
        RaiseServerChanged();
    }

    private void UpdateRefreshUi()
    {
        int value = RefreshRate;
        _refreshValue.Text = $"{value} fps";
        for (int i = 0; i < _presetButtons.Length; i++)
        {
            bool active = RefreshPresets[i] == value;
            _presetButtons[i].Modulate = active ? UiTheme.Accent : new Color(1f, 1f, 1f, 1f);
        }
    }

    private void RaiseServerChanged()
    {
        if (!_suppressServerEvent)
        {
            ServerSettingsChanged?.Invoke();
        }
    }

    private void GroupHeader(VBoxContainer col, string text)
    {
        col.AddChild(new HSeparator());
        col.AddChild(UiTheme.MakeLabel(text.ToUpperInvariant(), UiTheme.SmallSize, UiTheme.Faint));
    }

    private void Note(VBoxContainer col, string text)
    {
        var note = UiTheme.MakeLabel(text, UiTheme.SmallSize, UiTheme.Muted, wrap: true);
        note.CustomMinimumSize = new Vector2(ContentWidth, 0); // wrap within the sidebar column
        col.AddChild(note);
    }

    private static string Fmt(double? v) =>
        v is { } d ? $"{Math.Round(d)}ms" : "—";
}
