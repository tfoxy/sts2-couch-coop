// M2 WS-O foundation. Runtime wide-screen stage widening. On a wider-than-16:9 window it widens the DESIGN space by
// setting GetWindow().ContentScaleSize = (designW, 1080), leaving project.godot's stretch mode (canvas_items) + aspect
// (keep) UNTOUCHED — the widening is purely runtime.
// findings): with keep/canvas_items a window whose aspect equals designW/1080 fills with no pillarbox; >2520/1080
// leaves a small residual pillarbox (matching the web 2520 clamp); ≤16:9 leaves ContentScaleSize at (1920,1080) →
// BYTE-IDENTICAL to today (the strict no-op requirement). Input inversion comes FREE — the Window pre-applies the
// finalXform inverse before event propagation, so events already arrive in [0..designW]×[0..1080] (InputRouter only
// widens its clamp bound, WS-Q). The design width formula matches the web mirror (MirrorView.vue L82-92).
//
// AppShell owns the effective-enabled decision (DefaultEnabled + --stretch / --no-stretch + the Settings toggle)
// and passes it as `enabledGetter`; on an F change this pushes MirrorStore.SetSpreadFactor via `onFactor` (AppShell
// routes it to the CURRENT store, which survives a Back-to-menu store rebuild).

using System;
using Godot;

namespace CouchCoop.GodotClient.App;

public sealed partial class StageStretch : Node
{
    public const int DesignHeight = 1080;
    public const int BaseDesignWidth = 1920;

    // Clamp ceiling (web MIRROR_MAX_DESIGN_WIDTH): beyond this a residual pillarbox is left rather than over-widening.
    public const int MaxDesignWidth = 2520;

    // Flipped ON by the M2 integration commit (SpreadWalk WS-P + widened input WS-Q + chrome WS-R all landed).
    // The Settings "Widescreen stretch" toggle (default ON) and the --no-stretch dev flag can still disable it.
    public const bool DefaultEnabled = true;

    private readonly Func<bool> _enabled;
    private readonly Action<double> _onFactor;
    private int _appliedDesignW = -1;
    private bool _hooked;

    public StageStretch(Func<bool>? enabledGetter = null, Action<double>? onFactor = null)
    {
        _enabled = enabledGetter ?? (static () => DefaultEnabled);
        _onFactor = onFactor ?? (static _ => { });
    }

    // The current spread factor (designW / 1920). 1 until the first Apply.
    public double CurrentFactor => _appliedDesignW <= 0 ? 1 : _appliedDesignW / (double)BaseDesignWidth;

    public override void _Ready()
    {
        var win = GetWindow();
        win.SizeChanged += OnSizeChanged;
        _hooked = true;
        Apply();
    }

    public override void _ExitTree()
    {
        if (_hooked && GetWindow() is { } win)
        {
            win.SizeChanged -= OnSizeChanged;
            _hooked = false;
        }
    }

    private void OnSizeChanged() => Apply();

    // Pick up a change to the EFFECTIVE design width that didn't come from a window resize — namely a live Settings
    // "Widescreen stretch" toggle flip (the enable getter is read fresh in ComputeDesignWidth). This lets WS-R wire
    // the toggle by touching ONLY the Ui files: flipping it changes _enabled() → the next frame re-applies here. The
    // guard makes the steady-state cost a single Size read + an int compare (no ContentScaleSize write / factor push).
    public override void _Process(double delta)
    {
        if (ComputeDesignWidth() != _appliedDesignW)
        {
            Apply();
        }
    }

    // Recompute designW from the current window aspect, apply it to ContentScaleSize (idempotent — the ContentScaleSize
    // write + log only fire when it actually changes), and push the resulting factor to the store via onFactor.
    // Callable any time (AppShell calls it after creating a store so a freshly-built stack picks up the live factor).
    public void Apply()
    {
        int designW = ComputeDesignWidth();
        if (designW != _appliedDesignW)
        {
            _appliedDesignW = designW;
            GetWindow().ContentScaleSize = new Vector2I(designW, DesignHeight);
            var size = GetWindow().Size;
            GD.Print($"M2_STRETCH: window={size.X}x{size.Y} designW={designW} " +
                     $"F={CurrentFactor.ToString("0.####", System.Globalization.CultureInfo.InvariantCulture)} " +
                     $"enabled={_enabled()} mode={GetWindow().ContentScaleMode} aspect=Keep");
        }

        _onFactor(CurrentFactor);
    }

    // designW = enabled && aspect > 16/9 ? clamp(round(aspect·1080), 1920, 2520) : 1920 (web MirrorView.vue L82-92).
    // ≤16:9 (or disabled) → 1920 = the strict no-op.
    public int ComputeDesignWidth()
    {
        var size = GetWindow().Size;
        if (!_enabled() || size.X <= 0 || size.Y <= 0)
        {
            return BaseDesignWidth;
        }

        double aspect = size.X / (double)size.Y;
        if (aspect <= BaseDesignWidth / (double)DesignHeight)
        {
            return BaseDesignWidth;
        }

        return Math.Clamp((int)Math.Round(aspect * DesignHeight), BaseDesignWidth, MaxDesignWidth);
    }
}
