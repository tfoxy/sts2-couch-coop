// OWNER: WS-N (UI screens). The pre-join overlay shown while State==Mirror && !Joined && !DirectView.
//
// A native port of frontend/src/mirror/MirrorJoinPicker.vue, driven by the SAME JoinModel the web uses
// (computeMirrorJoinMode). UiRoot computes the mode/title/message/roster from the coordinator's session +
// status and calls Sync(); this control only renders and emits the two intents (join a name / watch only).
//
//   PickerWithName (MP character-select) : a name field to add a NEW remote player, PLUS the roster picker.
//   Picker         (MP run / load-game)  : roster buttons only (host row badged [HOST], plain — see
//                                          MakePlayerButton for the roster emphasis rules).
//   TitleOnly      (everything else)     : just the screen title / lifecycle placeholder heading.
//
// A rejection banner (coordinator.JoinMessage) shows above the picker. "Watch only" dismisses the panel so the
// live pre-join mirror shows behind it (UiRoot re-opens it from a small persistent chrome button).
//
// LAYOUT (2026-08-01 user report — three complaints, all fixed here):
//   * The card is biased into the UPPER band (BottomReserve, exactly like ConnectScreen's IP form) instead of dead
//     centre, so on a phone the name field is nowhere near the soft keyboard's half of the screen.
//   * A host line under the MIRROR kicker names WHICH host this picker belongs to: "<machine>  ·  <ip>:<port>"
//     (machine name = the server-stamped SessionEnvelope.HostName; address = ConnectionCoordinator.HostPort). Before
//     the first session message lands the machine name is unknown, so the address shows alone.
//   * The body is explicit titled SECTIONS separated by rules — "Player name" (name field + a full-width Join button
//     BELOW it, like the Connect button), "Players" (the roster picker), "Watch only" — each a single VBox whose
//     visibility hides its title + separator together, so a mode never leaves an orphan heading behind.
//
// ROSTER LAYOUT (2026-08-02): the roster is a 2-COLUMN GRID of tall, near-square buttons (web parity — the web
// picker's `.player-picker` is `display: grid` with `minmax(9.5rem, 1fr)` tracks), not a stack of thin full-width
// rows. A phone viewer's thumb wants a big target, and the roster is short (host + up to three seats), so two
// columns keep the whole card on screen. Each button centres a two-line block — name over an optional detail line
// — built as Labels inside the Button (MouseFilter=Ignore) rather than as one `\n` string, so the two lines can
// carry different sizes/colours the way the web's `.player-name` / `.connection-count` spans do.

using System;
using System.Collections.Generic;
using System.Text;
using CouchCoop.MirrorProtocol.Envelopes;
using CouchCoop.MirrorProtocol.Join;
using Godot;

namespace CouchCoop.GodotClient.Ui;

public sealed partial class JoinPanel : Control
{
    // (name, playerId). `playerId` is the picked option's state player id ("p:1003") for a roster BUTTON tap, and
    // null for a typed name — the host uses it to resolve the seat's netId exactly instead of by label match.
    public event Action<string, string?>? JoinRequested;
    public event Action? WatchOnlyRequested;

    // The card's vertical bias: trim this much (design space) off the BOTTOM of the centring band so the card sits in
    // the upper portion rather than dead-centre. Same value + same mechanism as ConnectScreen.BottomReserve — the two
    // forms are deliberately NOT sharing a helper (they are owned by different workstreams), just the same number.
    private const float BottomReserve = 400f;

    // ...but this picker is not a fixed-height card: it grows with the roster and the name section, so the trim is
    // CLAMPED to whatever slack is actually left, keeping at least this much design-space margin above the card.
    // Without the clamp a tall roster on a short (letterboxed) stage would be pushed off the top by the bias.
    private const float MinTopMargin = 24f;

    // Roster grid geometry (design space). Two columns of near-square buttons: 330 wide is what two columns plus the
    // separation fit inside the 760-wide card's padding, and 150 tall makes the target a thumb-sized block instead of
    // the old ~60px text row. The buttons ExpandFill, so they end up a little wider than the minimum.
    private const int RosterColumns = 2;
    private const int RosterButtonMinWidth = 330;
    private const int RosterButtonMinHeight = 150;
    private const int RosterSeparation = 10;

    // Inset of a button's two-line label block from the button's own rect (its stylebox content margin is 10).
    private const float RosterButtonInset = 12f;

    private ColorRect _backdrop = null!;
    private CenterContainer _center = null!;
    private PanelContainer _panel = null!;
    private Label _hostLine = null!;
    private Label _title = null!;
    private Label _message = null!;
    private VBoxContainer _nameSection = null!;
    private LineEdit _nameEdit = null!;
    private Button _joinButton = null!;
    private VBoxContainer _playersSection = null!;
    private GridContainer _rosterGrid = null!;
    private Label _placeholder = null!;

    private string _rosterSignature = "";
    private MirrorJoinMode _lastMode = MirrorJoinMode.TitleOnly;
    private bool _nameSectionWasVisible;
    private float _appliedReserve = float.NaN;

    public Rect2 ChromeRect => _panel.GetGlobalRect();

    public override void _Ready()
    {
        // A CanvasLayer-child Control does not anchor to the viewport, so size it explicitly to the LIVE design space
        // (viewport visible rect == ContentScaleSize): 1920 at 16:9 (byte-identical) and widened (up to 2520) when
        // StageStretch is on, so the centered picker re-centers on the true width. Kept current by _Process below.
        FitToViewport();
        MouseFilter = MouseFilterEnum.Ignore;

        // OPAQUE backdrop for the JOINABLE picker modes: the web shows the picker INSTEAD of the mirrored scene
        // (MirrorApp.vue `showScene` — MirrorView v-if / MirrorJoinPicker v-else are mutually exclusive; joinable
        // modes never render the scene). Without this the native app showed the mirrored MP lobby AND the join form
        // at once (user report 2026-07-18). TitleOnly keeps the translucent watch gate over the scene as before.
        _backdrop = new ColorRect { Color = new Color(0.055f, 0.067f, 0.09f) };
        _backdrop.SetAnchorsPreset(LayoutPreset.FullRect);
        _backdrop.MouseFilter = MouseFilterEnum.Stop;
        _backdrop.Visible = false;
        AddChild(_backdrop);

        // The card is centred by this CenterContainer, but the band is only the UPPER part of the height (see
        // UpdatePlacement): dead-centring put the name field under the Android soft keyboard.
        _center = new CenterContainer();
        _center.SetAnchorsPreset(LayoutPreset.FullRect);
        _center.MouseFilter = MouseFilterEnum.Ignore;
        AddChild(_center);

        _panel = UiTheme.Qa(UiTheme.Panel(pad: 30), "join_panel");
        _panel.CustomMinimumSize = new Vector2(760, 0);
        _center.AddChild(_panel);

        UpdatePlacement(); // seed the bias before the first sort (re-clamped per frame as the card's height changes)

        var col = new VBoxContainer();
        col.AddThemeConstantOverride("separation", 14);
        _panel.AddChild(col);

        col.AddChild(UiTheme.MakeLabel("MIRROR", UiTheme.SmallSize, UiTheme.Accent, HorizontalAlignment.Center));

        // WHICH host is this? "<machine name>  ·  <ip>:<port>" — the machine name arrives with the first session
        // envelope, so while the socket is still connecting this shows the address alone (never blank-then-jump).
        _hostLine = UiTheme.MakeLabel("", UiTheme.SmallSize, UiTheme.Faint, HorizontalAlignment.Center);
        _hostLine.Visible = false;
        col.AddChild(_hostLine);

        _title = UiTheme.MakeLabel("", UiTheme.TitleSize, UiTheme.Text, HorizontalAlignment.Center);
        col.AddChild(_title);

        _message = UiTheme.Qa(UiTheme.MakeLabel("", UiTheme.SmallSize, UiTheme.Gold, HorizontalAlignment.Center, wrap: true), "rejection_banner");
        _message.Visible = false;
        col.AddChild(_message);

        _placeholder = UiTheme.MakeLabel("", UiTheme.BodySize, UiTheme.Muted, HorizontalAlignment.Center, wrap: true);
        _placeholder.Visible = false;
        col.AddChild(_placeholder);

        // ---- section 1: "Player name" (PickerWithName only) ----------------------------------------------------
        // The field is on its OWN row with the Join button BELOW it at full width (the Connect button's treatment).
        // The old side-by-side HBox squeezed the field on a phone and put the primary action off to the side.
        // Everything (title + rule + field + button) lives in ONE VBox so hiding the section can't orphan its heading.
        _nameSection = MakeSection("Player name");
        _nameEdit = UiTheme.Qa(UiTheme.MakeLineEdit("player name"), "join_name");
        _nameEdit.SizeFlagsHorizontal = SizeFlags.ExpandFill;
        _nameEdit.TextSubmitted += _ => EmitJoin(_nameEdit.Text);
        _nameSection.AddChild(_nameEdit);
        _joinButton = UiTheme.Qa(UiTheme.MakePrimaryButton("Join", UiTheme.HeadingSize), "join_submit");
        _joinButton.SizeFlagsHorizontal = SizeFlags.ExpandFill;
        _joinButton.Pressed += () => EmitJoin(_nameEdit.Text);
        _nameSection.AddChild(_joinButton);
        col.AddChild(_nameSection);

        // ---- section 2: "Players" (both picker modes) ----------------------------------------------------------
        _playersSection = MakeSection("Players");
        _rosterGrid = new GridContainer { Columns = RosterColumns };
        _rosterGrid.AddThemeConstantOverride("h_separation", RosterSeparation);
        _rosterGrid.AddThemeConstantOverride("v_separation", RosterSeparation);
        _playersSection.AddChild(_rosterGrid);
        col.AddChild(_playersSection);

        // ---- section 3: "Watch only" (always) ------------------------------------------------------------------
        var watchSection = MakeSection("Watch only");
        var watchOnly = UiTheme.Qa(UiTheme.MakeButton("Watch only", UiTheme.SmallSize), "join_watch_only");
        watchOnly.Pressed += () => WatchOnlyRequested?.Invoke();
        watchSection.AddChild(watchOnly);
        col.AddChild(watchSection);
    }

    // One titled section: a muted heading + a rule + whatever the caller appends. Toggling the returned VBox's
    // Visible hides the WHOLE section (heading and rule included), which is what keeps a mode from leaving an orphan
    // title behind. Same visual vocabulary as ConnectScreen's IP form (MakeLabel/SmallSize/Muted + HSeparator).
    private static VBoxContainer MakeSection(string title)
    {
        var section = new VBoxContainer();
        section.AddThemeConstantOverride("separation", 10);
        section.AddChild(UiTheme.MakeLabel(title, UiTheme.SmallSize, UiTheme.Muted));
        section.AddChild(new HSeparator());
        return section;
    }

    // Re-fit to the live design width whenever it changes (StageStretch widening / un-widening); cheap size compare.
    public override void _Process(double delta)
    {
        if (Size != GetViewport().GetVisibleRect().Size)
        {
            FitToViewport();
        }

        // The bias depends on the card's CURRENT height (the roster and the name section come and go), so re-clamp it
        // per frame; UpdatePlacement is a no-op unless the clamped reserve actually moved.
        UpdatePlacement();

        // NO manual keyboard lift: the Android window is windowSoftInputMode=adjustResize, so Android shrinks the
        // surface on keyboard open and Godot re-letterboxes the picker above the keyboard on its own. A manual lift on
        // top of that double-counted and pushed the name field off the top. The upper-band bias above is a CONSTANT
        // layout choice, not a keyboard response, so it composes with Godot's re-letterboxing instead of fighting it.
    }

    private void FitToViewport()
    {
        Position = Vector2.Zero;
        Size = GetViewport().GetVisibleRect().Size;
    }

    // Bias the centred card into the UPPER band by trimming BottomReserve off the centring container's bottom (the
    // ConnectScreen recipe). The trim is clamped to the slack actually available — band height never drops below the
    // card plus MinTopMargin top and bottom — so a tall picker (long roster + name section) is centred in what is
    // left instead of being shoved off the top of the stage.
    private void UpdatePlacement()
    {
        float slack = Mathf.Max(0f, Size.Y - _panel.Size.Y - (MinTopMargin * 2f));
        float reserve = Mathf.Min(BottomReserve, slack);
        if (Mathf.IsEqualApprox(reserve, _appliedReserve))
        {
            return; // unchanged — don't dirty the container's layout every frame
        }

        _appliedReserve = reserve;
        _center.OffsetTop = 0f;
        _center.OffsetBottom = -reserve;
    }

    // Called by UiRoot from StateChanged / SessionUpdated / per-frame status polling. `title` is already the
    // coalesced screen-title-or-lifecycle-placeholder; `message` is the rejection copy (null = none).
    // `hostAddress` is the coordinator's ORIGINAL host[:port]; `hostName` is the server-stamped machine name (null
    // until the first session envelope lands).
    public void Sync(
        MirrorJoinMode mode,
        string title,
        string? message,
        IReadOnlyList<SessionPlayerOption> players,
        string prefillName,
        string hostAddress = "",
        string? hostName = null)
    {
        bool showPicker = mode is MirrorJoinMode.PickerWithName or MirrorJoinMode.Picker;
        bool showName = mode == MirrorJoinMode.PickerWithName;

        _backdrop.Visible = showPicker; // joinable modes occlude the scene (web parity — see _Ready)
        _title.Text = title;
        UpdateHostLine(hostAddress, hostName);

        _message.Visible = !string.IsNullOrEmpty(message);
        _message.Text = message ?? "";

        _nameSection.Visible = showName;
        _placeholder.Visible = !showPicker;
        _playersSection.Visible = showPicker;

        // Prefill the name field from the remembered name only while the viewer hasn't typed their own.
        if (showName && string.IsNullOrEmpty(_nameEdit.Text) && !string.IsNullOrEmpty(prefillName))
        {
            _nameEdit.Text = prefillName;
        }

        // Focus the name field the moment it appears (mirrors the web picker's autofocus).
        if (showName && !_nameSectionWasVisible)
        {
            _nameEdit.CallDeferred(Control.MethodName.GrabFocus);
        }

        _nameSectionWasVisible = showName;

        if (!showPicker)
        {
            // TitleOnly: the heading already carries the lifecycle text; keep a subtle waiting line too.
            _placeholder.Text = title.Length == 0 ? "Waiting for the game…" : "";
            _placeholder.Visible = _placeholder.Text.Length > 0;
        }

        if (showPicker)
        {
            RebuildRosterIfChanged(mode, players);
        }

        _lastMode = mode;
    }

    // "<machine name>  ·  <ip>:<port>", or the address alone before the host has told us its name (the whole point of
    // the line is to answer "which of the machines on this LAN am I joining?" WHILE it connects, so the address half
    // must render immediately). With neither — no coordinator address at all — the line hides entirely.
    private void UpdateHostLine(string hostAddress, string? hostName)
    {
        var address = hostAddress.Trim();
        var machine = hostName?.Trim();
        var text = string.IsNullOrEmpty(machine)
            ? address
            : string.IsNullOrEmpty(address) ? machine! : $"{machine}  ·  {address}";

        _hostLine.Text = text;
        _hostLine.Visible = text.Length > 0;
    }

    private void RebuildRosterIfChanged(MirrorJoinMode mode, IReadOnlyList<SessionPlayerOption> players)
    {
        // Show host + every MIRROR SEAT (web parity — MirrorJoinPicker uses the same mirrorRosterFor filter); genuine
        // remote players are hidden because the host cannot instance a mirror for them. Seats are shown regardless of
        // who (if anyone) currently holds them, which is what lets a returning device find the seat it must reclaim.
        // Filter BEFORE the signature so a hidden-row change is a no-op.
        var roster = JoinModel.MirrorRosterFor(players);

        var sig = new StringBuilder();
        sig.Append((int)mode);
        foreach (var p in roster)
        {
            // The seat fields are part of the signature because a seat's STATUS can change while nothing else about
            // the roster does (an instance going zombie, a reap making it joinable again, or a run starting, which
            // flips every instance-less seat from ready to offline). Leaving them out meant the picker kept
            // rendering a stale row — the buttons are rebuilt only when this string moves. ConnectionCount is here
            // for the same reason: it alone decides whether a row gets the "claim me" highlight.
            sig.Append('|').Append(p.Name).Append(';').Append(p.IsHost).Append(';')
                .Append(p.ConnectionCount).Append(';').Append(p.Disconnected).Append(';').Append(p.IsLocal)
                .Append(';').Append(p.PlayerId).Append(';').Append(p.IsMirrorSeat)
                .Append(';').Append(p.SeatStatus).Append(';').Append(p.SeatStatusReason);
        }

        var signature = sig.ToString();
        if (signature == _rosterSignature)
        {
            return;
        }

        _rosterSignature = signature;

        foreach (var child in _rosterGrid.GetChildren())
        {
            // The rebuilt buttons are added BELOW; QueueFree only takes effect at the end of the frame, so also detach
            // the old ones now — otherwise the grid lays out both generations for one frame (doubled/offset rows).
            _rosterGrid.RemoveChild(child);
            child.QueueFree();
        }

        // A lone row (host only) spans the full card instead of sitting in a half-width column.
        _rosterGrid.Columns = Mathf.Max(1, Mathf.Min(RosterColumns, roster.Count));

        for (int i = 0; i < roster.Count; i++)
        {
            _rosterGrid.AddChild(UiTheme.Qa(MakePlayerButton(roster[i]), $"join_player_{i}"));
        }
    }

    private Button MakePlayerButton(SessionPlayerOption player)
    {
        // ROSTER EMPHASIS (2026-08-01 user report — the visual language was inverted):
        //   * the HOST row is a PLAIN button and says only "<name> [HOST]". It was the accent-styled row labelled
        //     "Watch host", which read as the recommended choice AND described the wrong thing: picking the host
        //     HANDLES the host player (the host machine drives it), it is not a spectator mode.
        //   * the accent treatment freed up by that goes to the rows a viewer is actually meant to claim: a seat
        //     that is READY and has NO controller attached.
        //   * a seat with a controller is plain and UNDIMMED. The old 55%-alpha dim on any disconnected/uncontrolled
        //     seat was the misleading signal — it made a perfectly joinable row look broken.
        //   * a non-ready seat (stuck zombie / offline mid-run) is TRULY disabled, not merely dimmed, and carries
        //     the server's reason in place of the controller count. See MirrorSeatStatuses.
        //
        // The emphasis predicates themselves live in the shared JoinModel (TS twins in frontend/src/join/joinModel.ts),
        // so the two web pickers and this one can only ever be changed together.
        bool unavailable = JoinModel.SeatIsUnavailable(player);
        bool claimable = JoinModel.SeatIsClaimable(player);

        // SECOND LINE (null = the button is just the name). The controller count is words ONLY at 2+: "0 controllers"
        // read as a fault on a row that is perfectly joinable — the claimable highlight above already says "nobody is
        // on this seat" — and one controller is simply the normal state (JoinModel.ShouldShowConnectionCount).
        string? detail;
        Color detailColor;
        if (player.IsHost)
        {
            detail = "HOST";
            detailColor = UiTheme.HostBadgeText;
        }
        else if (unavailable)
        {
            detail = player.SeatStatusReason ?? "Unavailable";
            detailColor = UiTheme.Muted;
        }
        else if (JoinModel.ShouldShowConnectionCount(player.ConnectionCount))
        {
            detail = JoinModel.ConnectionCountLabel(player.ConnectionCount);
            detailColor = UiTheme.Muted;
        }
        else
        {
            detail = null;
            detailColor = UiTheme.Muted;
        }

        Button button = claimable
            ? UiTheme.MakePrimaryButton("", UiTheme.BodySize)
            : UiTheme.MakeButton("", UiTheme.BodySize);
        button.CustomMinimumSize = new Vector2(RosterButtonMinWidth, RosterButtonMinHeight);
        button.SizeFlagsHorizontal = SizeFlags.ExpandFill;

        var content = MakeButtonContent(player.Name, detail, detailColor);
        button.AddChild(content);

        // A Button is NOT a Container, so an anchored child never feeds the button's minimum size: a block that wraps
        // to three lines (the server's un-joinable reason, or a long seat name) spilled straight through the bottom
        // edge and over the next section. Track the content's own minimum height and grow the button to fit — the grid
        // row grows with it, which is exactly what the web picker's `.player-choice` min-height + 1fr row does. The
        // wrapped height is only known once the label has been laid out at its final width, hence the signal rather
        // than a one-shot measure (Godot re-sorts until it converges; width never depends on height, so it settles).
        void FitToContent()
        {
            float wanted = Mathf.Max(RosterButtonMinHeight, content.GetCombinedMinimumSize().Y + (RosterButtonInset * 2f));
            if (!Mathf.IsEqualApprox(button.CustomMinimumSize.Y, wanted))
            {
                button.CustomMinimumSize = new Vector2(RosterButtonMinWidth, wanted);
            }
        }

        content.MinimumSizeChanged += FitToContent;
        FitToContent();

        if (unavailable)
        {
            // Greyed AND Disabled: the tap is refused by the control itself, not just discouraged — the server
            // refuses this seat too (CouchCoopWebSocketConnection's seat gate), so an enabled row could only ever
            // produce a rejection banner.
            button.Disabled = true;
            button.Modulate = new Color(1f, 1f, 1f, 0.38f);
            return button;
        }

        string joinName = player.Name;
        // Only a real seat id is forwarded; the registry's synthetic lobby-only options carry the display name as
        // their id, which would resolve to nothing on the host.
        string? joinPlayerId = MirrorSeatNetIds.TryParsePlayerId(player.PlayerId, out _) ? player.PlayerId : null;
        button.Pressed += () => EmitJoin(joinName, joinPlayerId);
        return button;
    }

    // The centred two-line block inside a roster button: name over an optional detail line. Built as Labels rather
    // than a "\n" Button.Text so the lines can differ in size and colour (the web's .player-name / .connection-count),
    // and anchored FullRect because a Button is a Control, not a Container — it does not lay children out itself.
    // EVERY node here is MouseFilter=Ignore so the press still lands on the Button underneath.
    private static VBoxContainer MakeButtonContent(string name, string? detail, Color detailColor)
    {
        var box = new VBoxContainer
        {
            MouseFilter = MouseFilterEnum.Ignore,
            Alignment = BoxContainer.AlignmentMode.Center, // vertical centring inside the tall button
        };
        box.AddThemeConstantOverride("separation", 6);
        box.SetAnchorsAndOffsetsPreset(LayoutPreset.FullRect, LayoutPresetMode.Minsize, (int)RosterButtonInset);

        // Autowrap is safe here (unlike UiTheme.MakeLabel's default warning): a VBoxContainer child always gets the
        // container's full width, so a long seat name wraps inside the button instead of collapsing to one glyph.
        var nameLabel = UiTheme.MakeLabel(name, UiTheme.BodySize, UiTheme.Text, HorizontalAlignment.Center, wrap: true);
        nameLabel.MouseFilter = MouseFilterEnum.Ignore;
        box.AddChild(nameLabel);

        if (!string.IsNullOrEmpty(detail))
        {
            var detailLabel = UiTheme.MakeLabel(detail, UiTheme.SmallSize, detailColor, HorizontalAlignment.Center, wrap: true);
            detailLabel.MouseFilter = MouseFilterEnum.Ignore;
            box.AddChild(detailLabel);
        }

        return box;
    }

    private void EmitJoin(string name, string? playerId = null)
    {
        var trimmed = JoinModel.TrimName(name);
        if (trimmed is not null)
        {
            JoinRequested?.Invoke(trimmed, playerId);
        }
    }
}
