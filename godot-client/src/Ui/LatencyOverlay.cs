// OWNER: WS-N (UI screens). The compact floating RTT readout (top-RIGHT), toggled from the Settings panel's
// "show floating overlay" checkbox. Native port of frontend/src/mirror/LatencyOverlay.vue: network round-trip
// last/p50/p95/count, green while p95 stays within the 50ms budget, red once it slips. It stays on-screen after
// the Settings panel closes (UiRoot keeps SettingsPanelOpen true while it's enabled, so the probes keep running).
//
// Deliberately top-RIGHT: AppShell draws its own tiny --latency debug label top-LEFT; this must not collide.

using System;
using Godot;

namespace CouchCoop.GodotClient.Ui;

public sealed partial class LatencyOverlay : Control
{
    private const int TargetMs = 50;

    private PanelContainer _panel = null!;
    private StyleBoxFlat _style = null!;
    private Label _label = null!;

    public Rect2 ChromeRect => _panel.GetGlobalRect();

    public override void _Ready()
    {
        // A CanvasLayer-child Control does not anchor to the viewport, so size it explicitly to the LIVE design space
        // (viewport visible rect == ContentScaleSize) so the right-anchored readout below tracks the TRUE right edge
        // when StageStretch widens the stage (up to 2520), not the old fixed 1920 edge; 16:9 stays byte-identical (the
        // visible rect is 1920 wide there, so AnchorRight=1 lands on 1920 exactly as before). Kept current by _Process.
        FitToViewport();
        MouseFilter = MouseFilterEnum.Ignore;

        _panel = UiTheme.Qa(new PanelContainer(), "latency_overlay");
        _style = UiTheme.PanelStyle(new Color(0f, 0f, 0f, 0.72f), radius: 8, pad: 10f);
        _style.SetBorderWidthAll(2);
        _panel.AddThemeStyleboxOverride("panel", _style);
        // Pin the right edge 24px in from the design-space right edge, tucked below the gear; grow leftward as the
        // text width changes so it stays right-aligned.
        _panel.AnchorLeft = 1f;
        _panel.AnchorRight = 1f;
        _panel.AnchorTop = 0f;
        _panel.AnchorBottom = 0f;
        _panel.GrowHorizontal = GrowDirection.Begin;
        _panel.GrowVertical = GrowDirection.End;
        _panel.OffsetRight = -24;
        _panel.OffsetTop = 116;
        AddChild(_panel);

        _label = UiTheme.MakeLabel("RTT   —", UiTheme.MonoSize, UiTheme.Text);
        _panel.AddChild(_label);
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

    public void Update(Net.LatencySnapshot net)
    {
        bool ok = net.P95 is { } p95 && p95 <= TargetMs;
        Color color = net.Count == 0 ? UiTheme.Muted : (ok ? UiTheme.Good : UiTheme.Bad);
        _label.Text = $"RTT  {Fmt(net.LastMs)}   p50 {Fmt(net.P50)}   p95 {Fmt(net.P95)}   n={net.Count}";
        _label.AddThemeColorOverride("font_color", color);
        _style.BorderColor = net.Count == 0 ? UiTheme.PanelBorder : color;
    }

    private static string Fmt(double? v) => v is { } d ? $"{Math.Round(d)}ms" : "—";
}
