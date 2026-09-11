using System.Runtime.CompilerServices;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Session;
using CouchCoop.Mod.Server;
using Spirectl.Sts2.Core.Actions;
using Spirectl.Sts2.Embedding;

[assembly: InternalsVisibleTo("CouchCoop.Mod.Tests")]

namespace CouchCoop.Mod.Protocol;

// Translates a controlling mirror client's raw-input message into a spirectl input-injection action (single
// controller; injection is global, so no viewer-seat gating — like the existing debug actions). Element clicks
// resolve their coordinate on the HOST (spirectl, against the live tree), so the browser's per-element CSS
// scaling / non-16:9 viewport never has to map to game pixels. Returns null on success (input is fire-and-forget
// — echoing every hover would spam the socket) and an error envelope only when the injection fails.
public sealed class BrowserInputExecutor(ISemanticActionSource actions)
{
    private static readonly RateLimitedDiagnosticLog FailureLog = new(Console.Error.WriteLine);
    private readonly ISemanticActionSource _actions = actions ?? throw new ArgumentNullException(nameof(actions));

    public BrowserActionResultEnvelope? Execute(BrowserInputRequestEnvelope request)
    {
        // Any input (hover/click/key) counts as activity — resumes a headless client's idle-suspended spine +
        // particle simulation. Cheap Volatile write; a no-op reader on the host.
        HeadlessIdleActivity.Mark();
        // Restore the idle-throttled frame rate immediately (lower latency than the ~250ms idle-check tick) so the
        // player's first input after idle feels snappy. No-op unless currently fps-throttled; marshals to main thread.
        CouchCoopHeadlessVisualSuspender.NotifyMainThreadActivity();

        var requestId = string.IsNullOrWhiteSpace(request.RequestId) ? Guid.NewGuid().ToString("N") : request.RequestId;

        EmbeddableActionRequest? action;
        try
        {
            action = request.Kind switch
            {
                BrowserInputKinds.Hover => BuildPointer(requestId, SemanticActionKind.HoverElement, request),
                BrowserInputKinds.Click => BuildPointer(requestId, SemanticActionKind.MouseClick, request),
                BrowserInputKinds.Key => BuildKey(requestId, request),
                _ => null
            };
        }
        catch (Exception ex)
        {
            FailureLog.Write("invalid-input", $"[couch-coop] invalid input: {ex}");
            return Error(requestId, BrowserActionErrorCodes.InvalidMessage, "The input message is invalid.");
        }

        if (action is null)
        {
            return Error(requestId, BrowserActionErrorCodes.InvalidMessage, $"Unsupported input kind '{request.Kind}'.");
        }

        EmbeddableActionResult result;
        try
        {
            result = _actions.ExecuteAction(action);
        }
        catch (Exception ex)
        {
            FailureLog.Write("input-failed", $"[couch-coop] input failed: {ex}");
            return Error(requestId, BrowserActionErrorCodes.InternalFailure, "The game could not apply the input.");
        }

        // Fire-and-forget on success (no echo); surface only failures so a controller can diagnose.
        if (result.Success) return null;
        FailureLog.Write("input-failed", $"[couch-coop] input failed: {BrowserJson.Serialize(result)}");
        return Error(requestId, BrowserActionErrorCodes.InternalFailure, "The game could not apply the input.");
    }

    // Element id is authoritative — when present, leave the coordinate null so spirectl resolves the live rect.
    // An empty-space/cursor message instead carries a design-space coordinate (== game pixels: gamescope -W/-H).
    internal static EmbeddableActionRequest BuildPointer(string requestId, SemanticActionKind kind, BrowserInputRequestEnvelope request)
    {
        var hasElement = !string.IsNullOrWhiteSpace(request.ElementId);
        return new EmbeddableActionRequest(
            requestId,
            kind,
            MouseX: hasElement ? null : ToPixel(request.CoordX),
            MouseY: hasElement ? null : ToPixel(request.CoordY),
            MouseButton: ParseButton(request.Button),
            // R10 WS-E: the coalesced wheel-tick count rides the scalar Values bag (spirectl's
            // Sts2ActionHandler.ReadWheelCount reads `count`), so no action-record field had to change. Emitted ONLY
            // when it would mean something — a click-kind message, a wheel button, and a count above 1 — so every
            // other request builds byte-identically to before the feature.
            Values: WheelCountValues(kind, request),
            ElementId: hasElement ? request.ElementId : null,
            OffsetX: hasElement ? request.OffsetX : null,
            OffsetY: hasElement ? request.OffsetY : null,
            // Drag support: press (true) / release (false) / full click (null). Only meaningful for MouseClick;
            // harmless on HoverElement (its handler ignores it — a held button drives drag-motion via handler state).
            MousePressed: kind == SemanticActionKind.MouseClick ? request.Pressed : null);
    }

    internal static EmbeddableActionRequest BuildKey(string requestId, BrowserInputRequestEnvelope request)
        => new(
            requestId,
            SemanticActionKind.KeyInput,
            Key: request.Key,
            KeyModifiers: request.Modifiers,
            KeyPressed: request.Pressed);

    private static int? ToPixel(double? value)
        => value is { } v && double.IsFinite(v) ? (int)Math.Round(v) : null;

    // R10 WS-E: the `{"count": N}` scalar bag for a coalesced WHEEL message, or null (⇒ the pre-feature request).
    // Deliberately narrow — a repeat only ever means "N wheel notches at this point":
    //   * click kind only (a hover carries no button);
    //   * wheel-up / wheel-down only, so a malformed/hostile count can never multiply a left-click;
    //   * a full click only (`Pressed` null) — a press or a release is an edge, and repeating one would desync the
    //     host's held-button state;
    //   * count > 1 only, so the ordinary single tick keeps the exact request shape it had before.
    // The 1..20 clamp itself lives in spirectl (ReadWheelCount) so the CLI path is protected by the same bound.
    internal static IReadOnlyDictionary<string, string>? WheelCountValues(SemanticActionKind kind, BrowserInputRequestEnvelope request)
    {
        if (kind != SemanticActionKind.MouseClick || request.Pressed is not null || request.Count is not { } count || count <= 1)
        {
            return null;
        }

        var button = ParseButton(request.Button);
        if (button != RawMouseButtonKind.WheelUp && button != RawMouseButtonKind.WheelDown)
        {
            return null;
        }

        return new Dictionary<string, string>(1) { ["count"] = count.ToString(System.Globalization.CultureInfo.InvariantCulture) };
    }

    private static RawMouseButtonKind ParseButton(string? button)
        => button?.ToLowerInvariant() switch
        {
            "right" => RawMouseButtonKind.Right,
            "middle" => RawMouseButtonKind.Middle,
            "wheel-up" => RawMouseButtonKind.WheelUp,
            "wheel-down" => RawMouseButtonKind.WheelDown,
            _ => RawMouseButtonKind.Left
        };

    private static BrowserActionResultEnvelope Error(string requestId, string code, string message)
        => new("input-result", requestId, Code: code, Message: message);
}
