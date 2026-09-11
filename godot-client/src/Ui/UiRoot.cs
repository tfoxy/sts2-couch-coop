// OWNER: WS-N (UI screens). The client's UI chrome layer (a CanvasLayer above the mirror scene).
//
// Screens (all CouchCoop's OWN chrome — no game assets):
//   ConnectScreen  (State==Connect)  — IP-only host[:port] entry; persists lastHost; raises ConnectRequested (the
//                  player name is collected post-connect by the JoinPanel).
//   JoinPanel      (overlay in Mirror while !Joined && !DirectView) — JoinModel-driven picker / name / title-only,
//                  rejection banner, "Watch only" dismiss + a small persistent re-open button.
//   SettingsPanel  (left tab, Mirror) — left SIDEBAR: session (reload / back to menu) + client Toggle* + server
//                  settings (→ SubmitSettings) + latency. Input is PAUSED (ModalOpen) while it is open — no scrim.
//   LatencyOverlay (top-right)        — floating RTT readout kept on after the panel closes.
//   Status banner  (top-center)       — Reconnecting… / Disconnected once a connection has been established.
//
// PUBLIC SURFACE — PRESERVE EXACTLY (AppShell + ConnectionCoordinator, both frozen, drive it). WS-M binds
// GestureOptions to the Toggle* getters + IsPointOverChrome + SettingsPanelOpen.
//
// Design space is 1920x1080 (project stretch = canvas_items / keep-aspect), so this CanvasLayer's Control
// coordinates ARE design space: IsPointOverChrome is a plain rect test over the visible chrome, matching the
// design-space points the InputRouter feeds it after inverting the letterbox.

using System;
using CouchCoop.GodotClient.App;
using CouchCoop.MirrorProtocol.Envelopes;
using CouchCoop.MirrorProtocol.Join;
using Godot;

namespace CouchCoop.GodotClient.Ui;

public sealed partial class UiRoot : CanvasLayer
{
    public enum UiState
    {
        Connect,
        Join,
        Mirror,
    }

    public UiState State { get; private set; } = UiState.Connect;

    // Raised with host[:port] when Connect is pressed (blank host → AppShell's default). The name is collected
    // post-connect by the JoinPanel, so the Connect screen no longer supplies one.
    public Action<string>? ConnectRequested;

    // Re-raised from the Settings panel's "Back to menu" button; AppShell subscribes → ReturnToMenu (teardown+rebuild).
    public Action? BackToMenuRequested;

    // True while the Settings panel is open OR the floating latency overlay is enabled — AppShell reads this as
    // "the UI wants RTT probes" and toggles the 250ms ping cadence with it.
    public bool SettingsPanelOpen => (_settings?.PanelOpen ?? false) || (_settings?.OverlayEnabled ?? false);

    // True ONLY while the Settings panel modal is actually open (the floating latency overlay does NOT count).
    // WS-M gates GESTURES on this — a floating latency readout must never suppress gameplay input, whereas the
    // modal panel must. (SettingsPanelOpen stays the probe-cadence gate; ModalOpen is the input-suppression gate.)
    public bool ModalOpen => _settings?.PanelOpen ?? false;

    // WS-M binds the gesture engine's GestureOptions to these (RAM-only, no persistence, default ON).
    public bool ToggleRaiseHeldCard => _settings?.RaiseHeldCard ?? true;
    public bool ToggleUnfocusOnRelease => _settings?.UnfocusOnRelease ?? true;
    public bool ToggleTapToFocus => _settings?.TapToFocus ?? true;

    // M2 WS-O seam (OWNER of the checkbox: WS-R): the "Widescreen stretch" client toggle AppShell reads to gate
    // StageStretch. Default ON; WS-R adds the SettingsPanel checkbox that drives SettingsPanel.StretchEnabled.
    public bool ToggleStretch => _settings?.StretchEnabled ?? true;

    private ConnectionCoordinator? _coordinator;

    private ConnectScreen _connect = null!;
    private JoinPanel _join = null!;
    private SettingsPanel _settings = null!;
    private LatencyOverlay _latency = null!;
    private PanelContainer _bannerPanel = null!;
    private Label _bannerLabel = null!;
    private Button _reopenJoin = null!;

    private bool _joinDismissed;
    private bool _everConnected;
    private bool _refreshRateSeeded;
    private string _lastJoinLog = "";

    // The last join mode RefreshJoin computed. TitleOnly means the panel has NOTHING actionable (no name form, no
    // roster picker — just the watch-only gate), so once dismissed there is no reason to offer re-opening it: the
    // "Show join panel" chrome button stays hidden while a viewer is watching a run (user report 2026-07-18). It
    // reappears the moment the mode turns actionable (lobby form / roster / mid-run rejoin picker).
    private MirrorJoinMode _lastJoinMode = MirrorJoinMode.TitleOnly;

    // Test hooks (WS-N verification only): auto-open the settings panel / enable the floating overlay / flip a
    // server control, so the settings + latency + push evidence can be captured without external input automation.
    private bool _testOpenSettings;
    private bool _testOverlay;
    private bool _testFlip;
    private bool _testHooksApplied;

    public override void _Ready()
    {
        Layer = 64; // above the mirror scene (Node2D at layer 0), below AppShell's own --latency overlay (layer 128)

        _connect = new ConnectScreen();
        _connect.Submitted += host => ConnectRequested?.Invoke(host);
        AddChild(_connect);

        _join = new JoinPanel();
        // (name, playerId) — playerId is non-null only for a roster BUTTON tap, where it pins the exact seat.
        _join.JoinRequested += (name, playerId) => _coordinator?.SubmitJoin(name, playerId);
        _join.WatchOnlyRequested += () => { _joinDismissed = true; ApplyStateVisibility(); };
        AddChild(_join);

        BuildStatusBanner();
        BuildReopenButton();

        _settings = new SettingsPanel();
        _settings.ServerSettingsChanged += PushServerSettings;
        _settings.OverlayEnabledChanged += _ => ApplyStateVisibility();
        _settings.ReloadRequested += () => _coordinator?.Resync();
        _settings.BackToMenuRequested += () => BackToMenuRequested?.Invoke();
        AddChild(_settings);

        _latency = new LatencyOverlay();
        AddChild(_latency);

        _testOpenSettings = OS.GetEnvironment("COUCHCOOP_UI_TEST_SETTINGS") == "1";
        _testOverlay = OS.GetEnvironment("COUCHCOOP_UI_TEST_OVERLAY") == "1";
        _testFlip = OS.GetEnvironment("COUCHCOOP_UI_TEST_FLIP") == "1";

        // M2 WS-R chrome-geometry self-test (state-agnostic; the M1E_CHROME one above only fires in Mirror, which needs
        // a server). Arms a one-shot ~0.7s after mount so the wide-stage anchoring can be proved OFFLINE from any state.
        if (OS.GetEnvironment("COUCHCOOP_UI_CHROME_GEOM") == "1")
        {
            GetTree().CreateTimer(0.7).Timeout += LogChromeGeometry;
        }

        ApplyStateVisibility();
        GD.Print("M1E: UiRoot mounted (WS-N screens)");
    }

    public override void _Process(double delta)
    {
        if (_coordinator is null)
        {
            return;
        }

        MaybeApplyTestHooks();
        MaybeLogChromeSelfTest();

        // RTT snapshots update continuously while probes are on (panel open or overlay enabled); refresh the live
        // readouts here.
        if (_settings.PanelOpen)
        {
            _settings.UpdateLatency(_coordinator.Network, _coordinator.Game);
        }

        if (_latency.Visible)
        {
            _latency.Update(_coordinator.Network);
        }
    }

    // Apply the env-var test hooks once we're mounted in Mirror with a coordinator. A short delay before the
    // settings flip lets the join dance settle (so a directView/joined socket exists to receive the push).
    private double _testHookElapsed;

    private void MaybeApplyTestHooks()
    {
        if (_testHooksApplied || State != UiState.Mirror)
        {
            return;
        }

        if (_testOverlay)
        {
            _settings.ForceOverlay(true);
        }

        if (_testOpenSettings)
        {
            _settings.SetOpen(true);
        }

        _testHookElapsed += GetProcessDeltaTime();
        if (_testFlip && _testHookElapsed >= 4.0)
        {
            _settings.TestFlipServerControl();
            _testHooksApplied = true;
        }
        else if (!_testFlip)
        {
            _testHooksApplied = true;
        }
    }

    public void SetState(UiState state)
    {
        State = state;
        ApplyStateVisibility();
    }

    public void AttachCoordinator(ConnectionCoordinator coordinator)
    {
        _coordinator = coordinator;
        coordinator.StateChanged += OnCoordinatorStateChanged;
        coordinator.SessionUpdated += OnCoordinatorSession;
        RefreshJoin();
        ApplyStateVisibility();
    }

    // True when a design-space point is over interactive chrome (the InputRouter skips gestures there). The Settings
    // sidebar covers only its own panel rect when open (input is separately PAUSED via ModalOpen while it is open),
    // and the always-present left tab is covered via GearRect.
    public bool IsPointOverChrome(Vector2 designPoint)
    {
        if (State == UiState.Connect)
        {
            return _connect.Visible && _connect.ChromeRect.HasPoint(designPoint);
        }

        if (State != UiState.Mirror)
        {
            return false;
        }

        if (_settings.Visible && _settings.PanelOpen && _settings.PanelRect.HasPoint(designPoint))
        {
            return true; // the open left sidebar panel
        }

        if (_settings.Visible && _settings.GearRect.HasPoint(designPoint))
        {
            return true; // the always-present left tab
        }

        if (_join.Visible && _join.ChromeRect.HasPoint(designPoint))
        {
            return true;
        }

        if (_reopenJoin.Visible && _reopenJoin.GetGlobalRect().HasPoint(designPoint))
        {
            return true;
        }

        if (_latency.Visible && _latency.ChromeRect.HasPoint(designPoint))
        {
            return true;
        }

        if (_bannerPanel.Visible && _bannerPanel.GetGlobalRect().HasPoint(designPoint))
        {
            return true;
        }

        return false;
    }

    // ---- coordinator callbacks ---------------------------------------------------------------------------------

    private void OnCoordinatorStateChanged()
    {
        if (_coordinator is null)
        {
            return;
        }

        if (_coordinator.Status == "connected")
        {
            _everConnected = true;
        }

        RefreshJoin();
        ApplyStateVisibility();
    }

    private void OnCoordinatorSession(SessionEnvelope session)
    {
        // Seed the refresh-rate slider once from the host's real baseline (label truth only; no push).
        if (!_refreshRateSeeded && session.RefreshRate is int reported)
        {
            _refreshRateSeeded = true;
            _settings.SeedRefreshRate(reported);
        }

        RefreshJoin();
        ApplyStateVisibility();
    }

    // A one-shot self-test (COUCHCOOP_UI_TEST_CHROME=1) that logs the gear rect + IsPointOverChrome for its centre
    // and a background point — confirming the CanvasLayer's Control rects ARE design space (1920x1080), so the
    // design-space points the InputRouter feeds IsPointOverChrome hit-test correctly.
    private bool _chromeSelfTested;
    private double _chromeElapsed;

    private void MaybeLogChromeSelfTest()
    {
        if (_chromeSelfTested || State != UiState.Mirror || OS.GetEnvironment("COUCHCOOP_UI_TEST_CHROME") != "1")
        {
            return;
        }

        _chromeElapsed += GetProcessDeltaTime();
        if (_chromeElapsed < 2.0)
        {
            return; // let the container layout settle so panel rects are real
        }

        _chromeSelfTested = true;
        var gear = _settings.GearRect;
        var gearCenter = gear.Position + gear.Size / 2f;
        // Over the centered join/roster panel: its TRUE horizontal center (design width / 2), which is 960 at 16:9 and
        // ~1260 on a widened stage — the panel re-centers there, so a hardcoded 960 would miss it when stretched.
        float designW = (float)GetViewport().GetVisibleRect().Size.X;
        var joinCenter = new Vector2(designW / 2f, 360);
        var emptyCorner = new Vector2(120, 980); // clearly outside every chrome element
        GD.Print($"M1E_CHROME: gearRect={gear} joinVisible={_join.Visible} " +
                 $"overGear={IsPointOverChrome(gearCenter)} overJoinCenter={IsPointOverChrome(joinCenter)} " +
                 $"overEmptyCorner={IsPointOverChrome(emptyCorner)} modalOpen={ModalOpen}");
    }

    // M2 WS-R chrome-geometry self-test (COUCHCOOP_UI_CHROME_GEOM=1). Logs the live design width + each chrome panel's
    // global rect so the wide-stage anchoring is provable OFFLINE (all four panels lay out in every state; only the
    // Connect card is also VISIBLE without a server, so the Settings/latency/join rects carry LOG evidence the
    // integration session re-verifies live). Also proves the "Widescreen stretch" checkbox drives StretchEnabled →
    // ToggleStretch: it reads true by default, then false when the box is unchecked (so it isn't just the `?? true`).
    private void LogChromeGeometry()
    {
        float designW = (float)GetViewport().GetVisibleRect().Size.X;
        GD.Print($"M2_CHROME_GEOM: designW={designW} state={State} (trueCenterX={designW / 2f})");
        GD.Print($"M2_CHROME_GEOM: connectCard={_connect.ChromeRect} joinPanel={_join.ChromeRect}");
        GD.Print($"M2_CHROME_GEOM: settingsTab={_settings.GearRect} settingsPanel={_settings.PanelRect}");
        GD.Print($"M2_CHROME_GEOM: latencyOverlay={_latency.ChromeRect}");

        GD.Print($"M2_CHROME_GEOM: stretchEnabled={_settings.StretchEnabled} toggleStretch={ToggleStretch} (default ON)");
        _settings.TestSetStretch(false);
        GD.Print($"M2_CHROME_GEOM: stretchEnabled={_settings.StretchEnabled} toggleStretch={ToggleStretch} (after uncheck)");
        _settings.TestSetStretch(true); // restore the default so we don't leave the toggle flipped

        // The join panel is invisible in Connect state, so its CenterContainer hasn't sorted (the rect above reads its
        // un-sorted top-left position, NOT a centering bug — it's the same construction as the proven-centered connect
        // card). Briefly show it, then re-log a few frames later once the sort has run, and restore visibility.
        bool joinWasVisible = _join.Visible;
        bool reopenWasVisible = _reopenJoin.Visible;
        _join.Visible = true;
        _reopenJoin.Visible = true; // its BottomWide CenterContainer holder is the same CanvasLayer-anchor pattern
        GetTree().CreateTimer(0.2).Timeout += () =>
        {
            float w = (float)GetViewport().GetVisibleRect().Size.X;
            GD.Print($"M2_CHROME_GEOM: joinPanel(shown, sorted)={_join.ChromeRect} designW={w}");
            GD.Print($"M2_CHROME_GEOM: reopenBtn(shown, sorted)={_reopenJoin.GetGlobalRect()} designW={w}");
            _join.Visible = joinWasVisible;
            _reopenJoin.Visible = reopenWasVisible;
        };
    }

    // ---- join screen -------------------------------------------------------------------------------------------

    private void RefreshJoin()
    {
        if (_coordinator is null)
        {
            return;
        }

        var session = _coordinator.LastSession;
        var status = _coordinator.Status;
        var info = JoinModel.JoinInfoFromSession(session, status);
        var pending = _coordinator.PendingName;
        var mirrorMode = session?.Screen?.MirrorMode;
        var mode = JoinModel.ComputeMirrorJoinMode(info, pending, mirrorMode);
        _lastJoinMode = mode;

        string placeholder = status == "disconnected"
            ? "Disconnected"
            : pending is not null
                ? "Joining co-op session…"
                : "Waiting for the game…";
        string title = string.IsNullOrEmpty(info.ScreenTitle) ? placeholder : info.ScreenTitle!;

        // The last two carry "which host is this?" into the panel's header line: the address the viewer actually
        // connected to (coordinator-owned, known from the first frame) plus the host's own machine name (server-
        // stamped on the session envelope, so null until the first one lands / on a host too old to send it).
        _join.Sync(mode, title, _coordinator.JoinMessage, info.Players, _coordinator.PrefillName ?? "",
            _coordinator.HostPort, session?.HostName);

        string joinLog = $"status={status} mode={mode} players={info.Players.Count} mirrorMode={mirrorMode ?? "<null>"} " +
                         $"screenKind={info.ScreenKind ?? "<null>"} title='{title}' pending={pending ?? "<none>"} msg={_coordinator.JoinMessage ?? "<none>"}";
        if (joinLog != _lastJoinLog)
        {
            _lastJoinLog = joinLog;
            GD.Print($"M1E_JOIN: {joinLog}");
        }

        UpdateBanner(status);
    }

    private void UpdateBanner(string status)
    {
        if (!_everConnected || status == "connected")
        {
            _bannerLabel.Text = "";
            return;
        }

        _bannerLabel.Text = status == "disconnected" ? "Disconnected" : "Reconnecting…";
    }

    // ---- settings push -----------------------------------------------------------------------------------------

    private void PushServerSettings()
    {
        if (_coordinator is null)
        {
            return;
        }

        var payload = new SettingsMessage(
            RefreshRate: _settings.RefreshRate,
            FreezeParticles: _settings.FreezeParticles,
            FreezeSpines: _settings.FreezeSpines,
            FreezeDecor: _settings.FreezeDecor,
            TweenReplay: _settings.TweenReplay);

        GD.Print($"M1E_SETTINGS: push refreshRate={payload.RefreshRate} tweenReplay={payload.TweenReplay} " +
                 $"freezeParticles={payload.FreezeParticles} freezeSpines={payload.FreezeSpines} " +
                 $"freezeDecor={payload.FreezeDecor} (joined={_coordinator.Joined} directView={_coordinator.DirectView})");
        _coordinator.SubmitSettings(payload);
    }

    // ---- visibility routing ------------------------------------------------------------------------------------

    private void ApplyStateVisibility()
    {
        bool mirror = State == UiState.Mirror;
        _connect.Visible = State == UiState.Connect;

        bool preJoin = mirror && _coordinator is not null && !_coordinator.Joined && !_coordinator.DirectView;
        _join.Visible = preJoin && !_joinDismissed;
        _reopenJoin.Visible = preJoin && _joinDismissed && _lastJoinMode != MirrorJoinMode.TitleOnly;

        _settings.Visible = mirror;
        _latency.Visible = mirror && _settings.OverlayEnabled;

        bool banner = mirror && _everConnected && _coordinator is not null && _coordinator.Status != "connected";
        _bannerPanel.Visible = banner && _bannerLabel.Text.Length > 0;
    }

    // ---- chrome construction -----------------------------------------------------------------------------------

    private void BuildStatusBanner()
    {
        var holder = new CenterContainer();
        holder.SetAnchorsPreset(Control.LayoutPreset.TopWide);
        holder.OffsetTop = 20;
        holder.OffsetBottom = 110;
        holder.MouseFilter = Control.MouseFilterEnum.Ignore;
        AddChild(holder);

        _bannerPanel = UiTheme.Qa(UiTheme.Panel(new Color(0.2f, 0.08f, 0.08f, 0.92f), pad: 14), "reconnect_banner");
        _bannerPanel.Visible = false;
        holder.AddChild(_bannerPanel);

        _bannerLabel = UiTheme.MakeLabel("", UiTheme.BodySize, UiTheme.Gold, HorizontalAlignment.Center);
        _bannerPanel.AddChild(_bannerLabel);
    }

    private void BuildReopenButton()
    {
        var holder = new CenterContainer();
        holder.SetAnchorsPreset(Control.LayoutPreset.BottomWide);
        holder.OffsetTop = -140;
        holder.OffsetBottom = -40;
        holder.MouseFilter = Control.MouseFilterEnum.Ignore;
        AddChild(holder);

        _reopenJoin = UiTheme.Qa(UiTheme.MakeButton("Show join panel", UiTheme.SmallSize), "join_reopen");
        _reopenJoin.Visible = false;
        _reopenJoin.Pressed += () => { _joinDismissed = false; ApplyStateVisibility(); };
        holder.AddChild(_reopenJoin);
    }
}
