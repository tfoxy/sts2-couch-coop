// OWNER: WS-N (UI screens). The no-args launch screen (UiState.Connect).
//
// An IP-ONLY dark panel: host[:port] field + a Connect button + the LAN discovery list. There is no name field —
// the player NAME is collected post-connect by the JoinPanel (which is already MP-mode gated), so the two never
// duplicate it. The host field prefills from (and, on Connect, persists to) a NEW `lastHost` key in
// user://settings.cfg [mirror]. Connect persists lastHost, then raises Submitted(host); AppShell turns a blank host
// into its default and starts the coordinator (with NO auto-join name — the JoinPanel supplies it later).
//
// WS-C: DISCOVERY CONNECTS. Tapping a discovered row IS a submit, and the FIRST discovered host connects with no
// input at all. This restores the pre-round-7 behaviour, which had been withdrawn because connecting used to imply
// JOINING (it took a seat); connecting is now inert until the JoinPanel commits, so the shortcut is safe again and
// is the right default for a phone that is only ever pointed at one host on the LAN. Auto-connect stays out of the
// way of every explicit intent: it is cancelled the moment the user CLAIMS the host field (types in it, focuses it,
// or presses Connect), it fires at most once per screen, at most once per process (see _autoConnectSpent), never
// while the Connect screen isn't the visible state (the --connect path builds a hidden one), and never when the
// COUCHCOOP_UI_TEST_HOST hook has already chosen the target.
//
// The panel sits in the UPPER portion of the screen (not dead-centre) and lifts further by the Android virtual
// keyboard's height while it is up, so the IP field stays visible above the soft keyboard. On desktop the keyboard
// height is 0, so only the upper-portion bias applies.
//
// Because the coordinator does not exist yet on this screen, the host prefill is read straight from the config file.

using System;
using System.Collections.Generic;
using CouchCoop.GodotClient.Net;
using CouchCoop.MirrorProtocol.Discovery;
using Godot;

namespace CouchCoop.GodotClient.Ui;

public sealed partial class ConnectScreen : Control
{
    // Same file + section the ConnectionCoordinator uses; `lastHost` is WS-N's own key. The player name lives on the
    // coordinator's `lastPlayerName` key and is no longer read here (the JoinPanel owns the name post-connect).
    private const string SettingsPath = "user://settings.cfg";
    private const string CfgSection = "mirror";
    private const string LastHostKey = "lastHost";

    // The panel's vertical bias: reserve this much of the (fixed 1080) design height at the bottom so the centred card
    // sits in the upper portion (its centre ≈ (1080 - reserve)/2), keeping the IP field above the soft keyboard.
    private const float BottomReserve = 400f;

    // A test hook (WS-N verification only): when set, prefill the host field with this value and auto-press Connect
    // after a short settle, so the lastHost-persistence flow can be driven without external input automation.
    private const string TestHostEnv = "COUCHCOOP_UI_TEST_HOST";

    // Raised with host[:port] when Connect is pressed. Blank host → AppShell's default. The name is NOT collected
    // here (the post-connect JoinPanel owns it).
    public event Action<string>? Submitted;

    private LineEdit _hostField = null!;
    private CenterContainer _center = null!;
    private PanelContainer _panel = null!;
    private VBoxContainer _foundList = null!;

    // One entry per discovered-host row, kept so a tap can highlight ITS row and un-highlight the previous one
    // (the rows themselves live in _foundList; this is only the styling bookkeeping).
    private readonly List<FoundRow> _foundRows = new();
    private int _foundCount;
    private bool _submitted;

    // True once the user has CLAIMED the host field — typed into it, focused it, or pressed Connect. From then on
    // discovery only LISTS (rows still fill + highlight + connect on tap); it never connects on its own. Focus counts
    // because on a phone the tap that raises the soft keyboard is the whole gesture: a discovery reply landing while
    // the keyboard is coming up must not yank the screen away mid-tap.
    private bool _fieldTouched;

    // This screen has already fired its one automatic connect (a second discovery packet must not re-trigger it).
    private bool _autoConnected;

    // Process-wide latch: only the COLD Connect screen auto-connects. AppShell rebuilds a FRESH ConnectScreen after
    // Settings → "Back to menu" (deliberately sidestepping the _submitted latch), and an instance-only guard would
    // make that button a trap — discovery would re-answer within ~2s and drag the user straight back into the session
    // they just left. Any submit (auto, tap, or Connect) spends it; the list + tap-to-connect stay fully live.
    private static bool _autoConnectSpent;

    // The chrome rect (design space) for IsPointOverChrome — the visible panel, not the full-screen container.
    public Rect2 ChromeRect => _panel.GetGlobalRect();

    public override void _Ready()
    {
        // A Control parented under a CanvasLayer does NOT anchor to the viewport (anchors resolve to nothing, so
        // FullRect would collapse this to its content at the top-left). Size it explicitly to the LIVE design space
        // instead — the viewport visible rect == ContentScaleSize: 1920x1080 at 16:9 (byte-identical to the old fixed
        // pin) and the WIDENED width (up to 2520) when StageStretch is on, so the centered card re-centers on the true
        // width instead of staying pinned to the old 960 half. Kept current by _Process (see FitToViewport).
        FitToViewport();
        MouseFilter = MouseFilterEnum.Ignore; // the container itself is inert; only the panel's controls are live

        // The card is centred by this CenterContainer. It spans the full width but only the UPPER band of the height
        // (BottomReserve trimmed off the bottom via OffsetBottom), so the card biases toward the top third rather than
        // dead-centre. UpdatePlacement (per frame) re-applies that trim plus the live keyboard lift.
        _center = new CenterContainer();
        _center.SetAnchorsPreset(LayoutPreset.FullRect);
        _center.MouseFilter = MouseFilterEnum.Ignore;
        AddChild(_center);
        UpdatePlacement();

        _panel = UiTheme.Panel(pad: 34);
        _panel.CustomMinimumSize = new Vector2(720, 0);
        _center.AddChild(_panel);

        var col = new VBoxContainer();
        col.AddThemeConstantOverride("separation", 18);
        _panel.AddChild(col);

        col.AddChild(UiTheme.MakeLabel("CouchCoop", UiTheme.TitleSize, UiTheme.Text, HorizontalAlignment.Center));
        col.AddChild(UiTheme.MakeLabel("Connect to a game host", UiTheme.SmallSize, UiTheme.Muted,
            HorizontalAlignment.Center));

        col.AddChild(new HSeparator());

        // Order matters: field → Connect → discovery list. The discovered-host list is an OPTIONAL shortcut past the
        // field + button above it, so it goes LAST, below the action it stands in for. With Connect underneath the list (the old
        // order) the list read as a set of choices you had to scroll past, and the action button drifted further
        // down the card the more hosts answered — the primary action must not move as discovery arrives.
        col.AddChild(UiTheme.MakeLabel("Host  (address[:port])", UiTheme.SmallSize, UiTheme.Muted));
        _hostField = UiTheme.Qa(UiTheme.MakeLineEdit("e.g. 192.168.1.20:13337"), "connect_host");
        _hostField.Text = ReadCfg(LastHostKey);
        col.AddChild(_hostField);

        var connect = UiTheme.Qa(UiTheme.MakePrimaryButton("Connect", UiTheme.HeadingSize), "connect_button");
        connect.Pressed += () =>
        {
            // An explicit press also CLAIMS the field: even though Submit's own latch already blocks a later
            // auto-connect, the intent flag must not depend on that latch surviving future edits.
            MarkFieldTouched("connect pressed");
            Submit();
        };
        col.AddChild(connect);

        col.AddChild(new HSeparator());

        // M3 WS-T: LAN host discovery. A discovery node (owned by this screen — dies with it) probes for hosts and
        // raises Found; each new host becomes a button here that fills the host field AND connects on tap. The first
        // one to answer connects on its own while the field is untouched (WS-C — see MaybeAutoConnect).
        col.AddChild(UiTheme.MakeLabel("Hosts on your network", UiTheme.SmallSize, UiTheme.Muted));
        _foundList = new VBoxContainer();
        _foundList.AddThemeConstantOverride("separation", 8);
        col.AddChild(_foundList);

        var discovery = new HostDiscoveryClient();
        discovery.Found += OnHostFound;
        AddChild(discovery);

        // Enter in the host field submits.
        _hostField.TextSubmitted += _ =>
        {
            MarkFieldTouched("enter in host field");
            Submit();
        };

        // Typing over the field invalidates any "you picked this discovered host" highlight AND cancels auto-connect.
        // Safe to hook: Godot only emits text_changed for USER edits, so the programmatic `_hostField.Text = address`
        // written by a row tap / auto-connect / the test hook never clears the selection it just set (nor does it
        // falsely mark the field as claimed).
        _hostField.TextChanged += _ =>
        {
            MarkFieldTouched("typing");
            SelectFoundHost(null);
        };

        // Focusing the field is enough to claim it — the user reached for the keyboard, so stop trying to connect for
        // them. Only USER focus reaches this: nothing here calls GrabFocus on the host field.
        _hostField.FocusEntered += () => MarkFieldTouched("host field focused");

        MaybeArmTestHook();
    }

    // A CanvasLayer-child Control won't auto-track the viewport, so re-fit whenever the live design width changes
    // (StageStretch widens ContentScaleSize when the stage stretches; stays 1920 at 16:9). Cheap: a size read + compare.
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

    // Bias the centred card into the UPPER portion (trim BottomReserve off the centring band). NO manual keyboard
    // lift: the Android window is windowSoftInputMode=adjustResize, so on keyboard open Android shrinks the surface
    // and Godot re-letterboxes the whole 1920x1080 stage above the keyboard — a manual lift on top of that double-
    // counts and threw the card off the top. The FullRect anchors keep the band full-width; only the vertical trim
    // moves, and it's constant, so this is set once in _Ready (not per frame).
    private void UpdatePlacement()
    {
        _center.OffsetTop = 0f;
        _center.OffsetBottom = -BottomReserve;
    }

    // A discovered host arrived: add a button that fills the host field AND connects on tap — choosing a host machine
    // IS the submit. (It still fills the field first, so the highlighted row and the field agree and lastHost persists
    // exactly as a typed entry would.) Then, if nothing has claimed the field yet, this row may connect on its own.
    // Manual entry and Enter-to-submit are unchanged.
    private void OnHostFound(HostDiscoveryReply reply)
    {
        var address = $"{reply.Host}:{reply.Port}";
        var label = reply.Name is { Length: > 0 } name ? $"{name} — {address}" : address;
        var button = UiTheme.Qa(
            UiTheme.MakePrimaryButton(label, UiTheme.SmallSize),
            $"discovered_host_{_foundCount}");
        _foundCount++;

        // The "selected" look is DERIVED from the button's own theme boxes rather than re-authored here, so the two
        // states stay in UiTheme's visual family: it is the button's `pressed` fill with a thicker border. Remember the
        // resting pair too — selecting one row has to clear whichever row was selected before.
        _foundRows.Add(new FoundRow(
            button,
            button.GetThemeStylebox("normal"),
            button.GetThemeStylebox("hover"),
            MakeSelectedStyle(button)));

        button.Pressed += () =>
        {
            // Highlight BEFORE submitting: Submit switches the whole screen away, and if it is ever gated/rejected the
            // row the user chose must still read as chosen.
            _hostField.Text = address;
            SelectFoundHost(button);
            MarkFieldTouched("discovered host tapped");
            Submit();
        };
        _foundList.AddChild(button);

        MaybeAutoConnect(button, address);
    }

    // The no-input path: the FIRST host to answer connects by itself. Every gate here is a "someone else already
    // decided" test —
    //   _fieldTouched     the user claimed the field (typed / focused / pressed Connect / tapped a row) or the
    //                     COUCHCOOP_UI_TEST_HOST hook chose the target;
    //   _autoConnected    this screen already auto-connected — a SECOND discovery packet (another LAN host, or the
    //                     same one re-announcing) must not re-trigger it;
    //   _autoConnectSpent any submit already happened in this process (covers the post-back-to-menu rebuild, which
    //                     gets a brand-new instance with fresh instance flags);
    //   _submitted        a connect is already in flight / established from this screen;
    //   IsVisibleInTree   the Connect screen is not the shown state. --connect builds a UiRoot (hence a hidden
    //                     ConnectScreen, whose discovery client keeps probing) and goes straight to Mirror; that
    //                     screen must never fire. AppShell's own coordinator!=null guard would swallow the submit,
    //                     but it would still latch this screen and rewrite lastHost.
    private void MaybeAutoConnect(Button row, string address)
    {
        if (_fieldTouched || _autoConnected || _autoConnectSpent || _submitted || !IsVisibleInTree())
        {
            return;
        }

        // Latch BEFORE the deferred submit so any further reply drained in this same frame sees the decision.
        _autoConnected = true;
        _hostField.Text = address;
        SelectFoundHost(row);
        GD.Print($"M3_DISCOVER: auto-connect → {address} (first discovered host, field untouched)");

        // Deferred by one idle frame: Found is raised from HostDiscoveryClient._Process while it drains its socket,
        // and Submit synchronously builds the entire live stack (AppShell mounts the render stage + coordinator and
        // flips UiRoot's state). Committing that at the end of the frame instead of mid-drain keeps the rebuild out of
        // a node's _Process callback — the same place the button-press path would run it from.
        Callable.From(Submit).CallDeferred();
    }

    // Highlight the tapped row (null clears every row). Without this a tap looks inert: the field it filled sits ABOVE
    // the list, so on a phone the change can be entirely off the user's point of gaze. Both the `normal` AND `hover`
    // slots are swapped because on desktop the cursor is still parked on the row that was just clicked — leaving hover
    // alone would hide the highlight until the mouse moved away. Row count is tiny (one per LAN host), so the sweep is
    // free; re-applying the same StyleBox instance is a no-op in Godot.
    private void SelectFoundHost(Button? chosen)
    {
        foreach (var row in _foundRows)
        {
            bool on = row.Button == chosen;
            row.Button.AddThemeStyleboxOverride("normal", on ? row.Selected : row.Resting);
            row.Button.AddThemeStyleboxOverride("hover", on ? row.Selected : row.RestingHover);
        }
    }

    private static StyleBox MakeSelectedStyle(Button button)
    {
        var selected = (StyleBoxFlat)button.GetThemeStylebox("pressed").Duplicate();
        selected.SetBorderWidthAll(3);
        return selected;
    }

    private sealed record FoundRow(Button Button, StyleBox Resting, StyleBox RestingHover, StyleBox Selected);

    // Record that the user has claimed the host field, so LAN discovery stops connecting on its own (it keeps listing,
    // highlighting and connecting on tap). Idempotent + logged once — the log line is the QA evidence for "why didn't
    // it auto-connect?".
    private void MarkFieldTouched(string reason)
    {
        if (_fieldTouched)
        {
            return;
        }

        _fieldTouched = true;
        GD.Print($"M3_DISCOVER: auto-connect off — host field claimed ({reason}).");
    }

    private void Submit()
    {
        if (_submitted)
        {
            return; // one-shot: a second press while connecting is ignored (AppShell also guards this)
        }

        _submitted = true;
        _autoConnectSpent = true; // no rebuilt Connect screen (back-to-menu) may auto-connect after this
        var host = _hostField.Text.Trim();
        PersistLastHost(host);
        Submitted?.Invoke(host);
    }

    // Persist the entered host (blank clears it) so the next launch prefills it. lastPlayerName is left untouched.
    private void PersistLastHost(string host)
    {
        var cfg = new ConfigFile();
        cfg.Load(SettingsPath); // ignore result — the file may not exist yet
        if (string.IsNullOrEmpty(host))
        {
            cfg.EraseSectionKey(CfgSection, LastHostKey);
        }
        else
        {
            cfg.SetValue(CfgSection, LastHostKey, host);
        }

        Error e = cfg.Save(SettingsPath);
        if (e != Error.Ok)
        {
            GD.PrintErr($"ConnectScreen: failed to persist {LastHostKey} to {SettingsPath}: {e}");
        }

        GD.Print($"M1E: connect submit host='{host}' (persisted lastHost)");
    }

    private static string ReadCfg(string key)
    {
        var cfg = new ConfigFile();
        return cfg.Load(SettingsPath) == Error.Ok ? cfg.GetValue(CfgSection, key, "").AsString() : "";
    }

    private void MaybeArmTestHook()
    {
        var host = OS.GetEnvironment(TestHostEnv);
        if (string.IsNullOrEmpty(host))
        {
            return;
        }

        _hostField.Text = host;

        // The hook has CHOSEN the target, so LAN discovery must not race it: without this a reply landing inside the
        // 0.6s settle would auto-connect somewhere else and latch _submitted, and the hook's own timer would then be a
        // no-op — the verification run would silently connect to the wrong host. (The explicit-host CLI path needs no
        // such guard: --connect returns before AppShell ever builds a Connect screen.)
        MarkFieldTouched("COUCHCOOP_UI_TEST_HOST");
        GD.Print($"M1E: connect test-hook armed → auto-connect '{host}'");
        var timer = GetTree().CreateTimer(0.6);
        timer.Timeout += Submit;
    }
}
