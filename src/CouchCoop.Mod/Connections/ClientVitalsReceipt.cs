using System.Globalization;
using System.Text;
using System.Text.Json;

namespace CouchCoop.Mod.Connections;

/// <summary>
/// Reads the browser's bounded resource census (<c>{"type":"client-vitals",…}</c>) and renders the one line the
/// copyable report prints for it.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why this exists.</b> A phone whose web view is killed by the operating system leaves nothing behind — no
/// close frame, no error, no last message. The host sees a socket that simply stopped, which is exactly the
/// <c>browser-transport-lost</c> report a player sent from an iPhone that rendered one frame and vanished
/// 618&#160;ms later. The only way such a kill is ever diagnosable is if the host already knows what the page was
/// holding, so the client pushes this census on a slow cadence and the registry keeps the latest. Because
/// <see cref="ConnectionRegistry.RecordDiagnostic"/> archives the entry on every write, the LAST census before
/// the browser died is the one that survives into the issue.
/// </para>
/// <para>
/// <b>Why the host re-renders the line instead of storing what it was sent.</b> A receipt is client-controlled
/// text on a route any device on the network can open, and this one ends up quoted verbatim into a report a
/// player copies and pastes into a bug tracker. So nothing here echoes a client string: every field is parsed,
/// range-checked and re-emitted from the parsed value, and the two textual fields are matched against closed
/// sets rather than sanitised. A census that fails any check is REJECTED WHOLE rather than partially rendered —
/// a half-parsed census would read like a measurement instead of like a malformed message, and the entire point
/// of this line is that a human trusts the numbers on it.
/// </para>
/// <para>
/// The census carries no URL, name, user agent, stack or payload; it is numbers plus two enums. Adding a field
/// means adding it here too, which is the intended friction.
/// </para>
/// </remarks>
public static class ClientVitalsReceipt
{
    /// <summary>The report fact key. One key, overwritten each census, so the report shows the latest reading.</summary>
    public const string FactKey = "clientVitals";

    /// <summary>The stage backends the mirror can run — <c>?stage=dom|canvas</c>, matching rendererFactory.ts.</summary>
    private static readonly string[] StageBackends = ["dom", "canvas"];

    /// <summary>The effect modes the settings store can hold, matching mirrorSettings.ts <c>EffectMode</c>.</summary>
    private static readonly string[] EffectModes = ["dynamic", "dynamic-half", "dynamic-quarter", "static", "off"];

    // Ceilings, not guesses at typical values: each one is comfortably above anything a real device can produce
    // and below the point where a number stops being a measurement. A value past its ceiling means the census is
    // not one of ours, so the whole receipt goes.
    private const double MaxDpr = 16d;
    private const double MaxViewportPx = 65_535d;
    private const double MaxElements = 10_000_000d;
    private const double MaxCanvases = 100_000d;
    private const double MaxPixels = 1e12;
    private const double MaxBytes = 1e12;

    /// <summary>
    /// Render the census line, or <c>null</c> when <paramref name="root"/> is not a complete, in-range census.
    /// </summary>
    public static string? Render(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) return null;

        if (!TryEnum(root, "stageRequested", StageBackends, out var stageRequested)
            || !TryEnum(root, "stageActive", StageBackends, out var stageActive)
            || !TryEnum(root, "shaderMode", EffectModes, out var shaderMode)
            || !TryEnum(root, "particleMode", EffectModes, out var particleMode)
            || !TryNumber(root, "dpr", MaxDpr, out var dpr)
            || !TryNumber(root, "vw", MaxViewportPx, out var viewportWidth)
            || !TryNumber(root, "vh", MaxViewportPx, out var viewportHeight)
            || !TryNumber(root, "els", MaxElements, out var elements)
            || !TryNumber(root, "canvases", MaxCanvases, out var canvases)
            || !TryNumber(root, "canvasPx", MaxPixels, out var canvasPixels)
            || !TryNumber(root, "decodedBytes", MaxBytes, out var decodedBytes)
            || !TryNumber(root, "decodedPages", MaxCanvases, out var decodedPages)
            || !TryNumber(root, "atlasCap", MaxBytes, out var atlasCapBytes)
            || !TryNumber(root, "texBytes", MaxBytes, out var textureCapBytes)
            || !TryNumber(root, "fxBytes", MaxBytes, out var fxCapBytes)
            || !TryNumber(root, "jsHeapBytes", MaxBytes, out var jsHeapBytes))
        {
            return null;
        }

        var text = new StringBuilder();
        // `requested->active` in one token because the pair only means anything together: they differ exactly when
        // the canvas backend was asked for and could not be built, which is a silent fallback nothing else reports.
        text.Append("stage=").Append(stageRequested).Append("->").Append(stageActive);
        text.Append(" dpr=").Append(dpr.ToString("0.##", CultureInfo.InvariantCulture));
        text.Append(" viewport=").Append(Whole(viewportWidth)).Append('x').Append(Whole(viewportHeight));
        text.Append(" els=").Append(Whole(elements));
        // Both halves of the canvas cost: WebKit budgets canvas memory per page and kills the content process
        // when it is exceeded, so the PIXEL total is the number that matters and the count is its denominator.
        text.Append(" canvases=").Append(Whole(canvases));
        text.Append(" canvasPx=").Append(Whole(canvasPixels));
        // Atlas pixels the page OWNED at this instant, and the budget bounding them. The pair is the point: a
        // large decodedBytes beside atlasCap=0 is an unbounded page, and the same figure beside a non-zero cap is
        // a page whose working set genuinely needs that much — two very different reports.
        text.Append(" decodedBytes=").Append(Whole(decodedBytes));
        text.Append(" decodedPages=").Append(Whole(decodedPages));
        text.Append(" atlasCap=").Append(Whole(atlasCapBytes));
        // These two are zero on the DOM backend because they bound the CANVAS backend's own texture population.
        text.Append(" texCap=").Append(Whole(textureCapBytes));
        text.Append(" fxCap=").Append(Whole(fxCapBytes));
        text.Append(" shaders=").Append(shaderMode);
        text.Append(" particles=").Append(particleMode);
        // WebKit does not offer performance.memory, so 0 here means "this browser declined to say", never "no
        // heap" — which is worth knowing on the one platform we most want the number from.
        text.Append(" jsHeap=").Append(Whole(jsHeapBytes));
        return text.ToString();
    }

    private static bool TryEnum(JsonElement root, string name, string[] allowed, out string value)
    {
        value = "";
        if (!root.TryGetProperty(name, out var element) || element.ValueKind != JsonValueKind.String) return false;
        var raw = element.GetString();
        if (raw is null || Array.IndexOf(allowed, raw) < 0) return false;
        value = raw;
        return true;
    }

    private static bool TryNumber(JsonElement root, string name, double max, out double value)
    {
        value = 0;
        if (!root.TryGetProperty(name, out var element) || element.ValueKind != JsonValueKind.Number) return false;
        if (!element.TryGetDouble(out var raw)) return false;
        // Negative, NaN and infinity are all "not a measurement". Written as a positive test so NaN fails it.
        if (!(raw >= 0 && raw <= max)) return false;
        value = raw;
        return true;
    }

    /// <summary>Invariant, no separators, no exponent — a figure someone greps out of a pasted report.</summary>
    private static string Whole(double value) =>
        Math.Round(value).ToString("F0", CultureInfo.InvariantCulture);
}
