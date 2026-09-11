// OWNER: WS-N (UI screens). Shared visual language for the client's chrome (Connect / Join / Settings / Latency).
//
// A tiny dark theme built programmatically (no game assets — CouchCoop's OWN chrome). Design space is 1920x1080
// (project stretch = canvas_items / keep), so every size here is authored in that space and the letterbox scales
// it down to the phone. Fonts are deliberately large so the panels stay legible at phone size.

using Godot;

namespace CouchCoop.GodotClient.Ui;

internal static class UiTheme
{
    // Font sizes (design space). Large on purpose — the 1920x1080 stage shrinks a lot on a phone.
    public const int TitleSize = 46;
    public const int HeadingSize = 34;
    public const int BodySize = 30;
    public const int SmallSize = 24;
    public const int MonoSize = 27;

    // Palette (mirrors the web mirror chrome: rgba(14,17,23,.92) panels, #2ecc71 / #e74c3c latency, gold reject).
    public static readonly Color PanelBg = new(0.055f, 0.067f, 0.09f, 0.94f);
    public static readonly Color PanelBorder = new(1f, 1f, 1f, 0.14f);
    public static readonly Color Scrim = new(0f, 0f, 0f, 0.55f);
    public static readonly Color Text = new(0.93f, 0.93f, 0.93f);
    public static readonly Color Muted = new(1f, 1f, 1f, 0.6f);
    public static readonly Color Faint = new(1f, 1f, 1f, 0.42f);
    public static readonly Color Accent = new(0.353f, 0.588f, 0.941f);
    public static readonly Color AccentDim = new(0.353f, 0.588f, 0.941f, 0.32f);
    public static readonly Color Good = new(0.18f, 0.8f, 0.443f);   // #2ecc71
    public static readonly Color Bad = new(0.906f, 0.298f, 0.235f); // #e74c3c
    public static readonly Color Gold = new(1f, 0.812f, 0.478f);    // #ffcf7a
    public static readonly Color HostBadgeText = new(0.749f, 0.902f, 1f);

    // A rounded, bordered panel background applied to a PanelContainer's "panel" slot.
    public static StyleBoxFlat PanelStyle(Color? bg = null, int radius = 12, float pad = 18f)
    {
        var sb = new StyleBoxFlat
        {
            BgColor = bg ?? PanelBg,
            BorderColor = PanelBorder,
        };
        sb.SetCornerRadiusAll(radius);
        sb.SetBorderWidthAll(1);
        sb.SetContentMarginAll(pad);
        return sb;
    }

    public static PanelContainer Panel(Color? bg = null, int radius = 12, float pad = 18f)
    {
        var panel = new PanelContainer();
        panel.AddThemeStyleboxOverride("panel", PanelStyle(bg, radius, pad));
        return panel;
    }

    // `wrap` defaults OFF: an autowrapping label collapses to ~1 character wide inside a horizontal/loose container
    // (the "vertical text" bug). Only pass wrap:true for multi-line copy that lives in a fixed-width column.
    public static Label MakeLabel(string text, int size = BodySize, Color? color = null,
        HorizontalAlignment align = HorizontalAlignment.Left, bool wrap = false)
    {
        var label = new Label
        {
            Text = text,
            HorizontalAlignment = align,
            AutowrapMode = wrap ? TextServer.AutowrapMode.WordSmart : TextServer.AutowrapMode.Off,
        };
        label.AddThemeFontSizeOverride("font_size", size);
        label.AddThemeColorOverride("font_color", color ?? Text);
        return label;
    }

    public static Button MakeButton(string text, int size = BodySize)
    {
        var button = new Button { Text = text };
        button.AddThemeFontSizeOverride("font_size", size);
        Style(button, new Color(1f, 1f, 1f, 0.06f), new Color(1f, 1f, 1f, 0.13f), new Color(1f, 1f, 1f, 0.18f));
        return button;
    }

    // A slightly emphasized (accent) button for primary actions.
    public static Button MakePrimaryButton(string text, int size = BodySize)
    {
        var button = new Button { Text = text };
        button.AddThemeFontSizeOverride("font_size", size);
        Style(button, AccentDim, new Color(0.353f, 0.588f, 0.941f, 0.5f), new Color(0.353f, 0.588f, 0.941f, 0.6f), Accent);
        return button;
    }

    private static void Style(Button button, Color normalBg, Color hoverBg, Color pressedBg, Color? border = null)
    {
        var normal = new StyleBoxFlat { BgColor = normalBg, BorderColor = border ?? PanelBorder };
        normal.SetCornerRadiusAll(8);
        normal.SetBorderWidthAll(1);
        normal.SetContentMarginAll(10);
        button.AddThemeStyleboxOverride("normal", normal);

        var hover = (StyleBoxFlat)normal.Duplicate();
        hover.BgColor = hoverBg;
        button.AddThemeStyleboxOverride("hover", hover);

        var pressed = (StyleBoxFlat)normal.Duplicate();
        pressed.BgColor = pressedBg;
        button.AddThemeStyleboxOverride("pressed", pressed);

        button.AddThemeColorOverride("font_color", Text);
    }

    public static LineEdit MakeLineEdit(string placeholder, int size = BodySize)
    {
        var edit = new LineEdit { PlaceholderText = placeholder };
        edit.AddThemeFontSizeOverride("font_size", size);

        var style = new StyleBoxFlat { BgColor = new Color(1f, 1f, 1f, 0.08f), BorderColor = PanelBorder };
        style.SetCornerRadiusAll(6);
        style.SetBorderWidthAll(1);
        style.SetContentMarginAll(8);
        edit.AddThemeStyleboxOverride("normal", style);

        var focus = (StyleBoxFlat)style.Duplicate();
        focus.BorderColor = Accent;
        edit.AddThemeStyleboxOverride("focus", focus);
        edit.AddThemeColorOverride("font_color", Text);
        return edit;
    }

    // Stamp a stable QA id (../godot-qa toolkit addresses nodes as qa:<id>). Returns the node for chaining.
    public static T Qa<T>(T node, string id) where T : Node
    {
        node.SetMeta("qa_id", id);
        return node;
    }

    public static CheckBox MakeCheck(string text, bool on, int size = BodySize)
    {
        var box = new CheckBox { Text = text, ButtonPressed = on };
        box.AddThemeFontSizeOverride("font_size", size);
        box.AddThemeColorOverride("font_color", Text);
        // WS-SCROLLFIX (batch 3): no focus ring on press. While the Settings sidebar is modal the app GestureMachine
        // is bypassed and Godot's raw focus-on-press fires under a touch; without FocusMode.None a stray press during a
        // drag-scroll leaves the checkbox highlighted. A stationary tap still toggles (default release action-mode).
        box.FocusMode = Control.FocusModeEnum.None;
        // WS-SCROLL (batch 4): a CheckBox (BaseButton) defaults to MouseFilter=Stop, which SWALLOWS a touch on the
        // settings sidebar and starves the parent ScrollContainer of the drag it needs to begin panning (its
        // ScrollDeadzone never trips). Pass forwards the event to the ScrollContainer: a stationary tap still toggles,
        // but a drag past the deadzone fires SCROLL_BEGIN, which cancels the pending toggle and pans. Covers every
        // checkbox the settings panel builds through MakeCheck.
        box.MouseFilter = Control.MouseFilterEnum.Pass;
        return box;
    }

    // A segmented single-choice control for the effect-mode rows (Dynamic / Static / Off). Styled like MakeButton;
    // FocusMode None so a touch press leaves no focus ring (touch-drag-scroll hygiene, same as MakeCheck).
    public static OptionButton MakeOptionButton(string[] items, int selected, int size = BodySize)
    {
        var opt = new OptionButton { FocusMode = Control.FocusModeEnum.None };
        opt.AddThemeFontSizeOverride("font_size", size);
        for (int i = 0; i < items.Length; i++)
        {
            opt.AddItem(items[i], i);
        }

        if (selected >= 0 && selected < items.Length)
        {
            opt.Selected = selected;
        }

        Style(opt, new Color(1f, 1f, 1f, 0.06f), new Color(1f, 1f, 1f, 0.13f), new Color(1f, 1f, 1f, 0.18f));
        return opt;
    }
}
