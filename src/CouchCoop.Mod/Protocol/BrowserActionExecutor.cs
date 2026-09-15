using System.Text.Json;
using CouchCoop.Mod.Runtime;
using Spirectl.Sts2.Core.Actions;
using Spirectl.Sts2.Embedding;

namespace CouchCoop.Mod.Protocol;

public sealed class BrowserActionExecutor(CouchCoopRuntimeHost runtimeHost, Action<string>? log = null)
{
    private readonly CouchCoopRuntimeHost _runtimeHost = runtimeHost ?? throw new ArgumentNullException(nameof(runtimeHost));
    private readonly Action<string> _log = log ?? Console.Error.WriteLine;
    private long _lastFailureLog;

    // Every live `/ws` connection is a mirror view of exactly one game process. A joined seat is redirected to its
    // own headless instance and direct view observes the host, so an empty perspective always means that process's
    // local player. Browser-supplied identity fields are intentionally discarded.
    public Task<BrowserActionResultEnvelope> ExecuteAsync(
        BrowserActionRequestEnvelope request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();

        var requestId = string.IsNullOrWhiteSpace(request.RequestId) ? Guid.NewGuid().ToString("N") : request.RequestId;
        // The browser cannot select another acting player; every action uses this process's local perspective.
        const string viewerId = "";
        request = request with { ViewerId = viewerId, ViewerPlayerId = null };

        try
        {
            if (!string.IsNullOrWhiteSpace(request.ActionRefId))
            {
                return Task.FromResult(RejectRenderActionRef(request, requestId));
            }

            if (!string.IsNullOrWhiteSpace(request.SemanticActionId))
            {
                return Task.FromResult(ExecuteSemanticAction(request, requestId, viewerId));
            }

            return Task.FromResult(Error(request, requestId, BrowserActionErrorCodes.MissingActionId, "Action request must include actionRefId or semanticActionId."));
        }
        catch (NotSupportedException ex)
        {
            LogFailure(ex.ToString());
            return Task.FromResult(Error(request, requestId, BrowserActionErrorCodes.UnsupportedPerspective, "This action is unavailable for the current player."));
        }
        catch (Exception ex)
        {
            LogFailure(ex.ToString());
            return Task.FromResult(Error(request, requestId, BrowserActionErrorCodes.InternalFailure, "The game could not complete the action."));
        }
    }

    private static BrowserActionResultEnvelope RejectRenderActionRef(BrowserActionRequestEnvelope request, string requestId)
    {
        return Error(
            request,
            requestId,
            BrowserActionErrorCodes.StaleActionRef,
            "Render action refs are not available in the revisioned browser state protocol; use semanticActionId.");
    }

    private BrowserActionResultEnvelope ExecuteSemanticAction(BrowserActionRequestEnvelope request, string requestId, string viewerId)
    {
        if (!TryParseSemanticActionKind(request.SemanticActionId, out var kind))
        {
            return Error(request, requestId, BrowserActionErrorCodes.DisabledAction, "This action is not available through the browser.");
        }

        var result = _runtimeHost.ExecuteAction(ToActionRequest(requestId, viewerId, kind, request.Args));
        if (!result.Success)
        {
            LogFailure(BrowserJson.Serialize(result));
            result = new EmbeddableActionResult(false, null, new EmbeddableRuntimeError(
                BrowserActionErrorCodes.InternalFailure,
                "The game could not complete the action.",
                Retryable: result.Error?.Retryable ?? false));
        }
        return Success(request, requestId, result);
    }

    private void LogFailure(string detail)
    {
        var now = Environment.TickCount64;
        var previous = Volatile.Read(ref _lastFailureLog);
        if (previous != 0 && now - previous < 10_000)
        {
            return;
        }
        if (Interlocked.CompareExchange(ref _lastFailureLog, now, previous) == previous)
        {
            _log($"[couchcoop] browser-action failed detail={detail}");
        }
    }

    private static BrowserActionResultEnvelope Success(BrowserActionRequestEnvelope request, string requestId, EmbeddableActionResult result)
        => new(
            "action-result",
            requestId,
            Result: JsonSerializer.SerializeToElement(result, BrowserJson.Options),
            ActionRefId: request.ActionRefId,
            SnapshotId: request.SnapshotId,
            SemanticActionId: request.SemanticActionId,
            ViewerId: FirstNonBlank(request.ViewerPlayerId, request.ViewerId),
            ScreenType: request.ScreenType);

    private static BrowserActionResultEnvelope Error(BrowserActionRequestEnvelope request, string requestId, string code, string message)
        => new(
            "action-result",
            requestId,
            Code: code,
            Message: message,
            ActionRefId: request.ActionRefId,
            SnapshotId: request.SnapshotId,
            SemanticActionId: request.SemanticActionId,
            ViewerId: FirstNonBlank(request.ViewerPlayerId, request.ViewerId),
            ScreenType: request.ScreenType);

    private static bool TryParseSemanticActionKind(string? value, out SemanticActionKind kind)
    {
        var normalized = NormalizeActionKindToken(value);
        // Explicit product capabilities. Adding a tooling enum member must never expose it on LAN.
        foreach (var candidate in new[]
        {
            SemanticActionKind.SelectMapNode,
            SemanticActionKind.SetScrollOffset,
            SemanticActionKind.ClaimReward,
        })
        {
            var token = ToKebabCase(candidate.ToString());
            if (string.Equals(normalized, token, StringComparison.Ordinal))
            {
                kind = candidate;
                return true;
            }
        }

        kind = default;
        return false;
    }

    // Forward only the arguments used by the browser actions. In particular, an identity in
    // the generic values dictionary must not reintroduce caller-selected player scope.
    private static EmbeddableActionRequest ToActionRequest(
        string requestId,
        string fallbackPlayerId,
        SemanticActionKind kind,
        IReadOnlyDictionary<string, JsonElement>? args)
    {
        var values = CoerceArgs(args);
        return new EmbeddableActionRequest(
            requestId,
            kind,
            fallbackPlayerId,
            MapNodeId: NamedArg(values, "mapNodeId"),
            // A live scene node's instance id (the id the mirror's scene stream uses). The mirror addresses things
            // it can SEE but has no semantic id for — a map point, whose "map-node:{row}:{col}" id it cannot derive
            // — so `elementId` gets the same named-field treatment as the other well-known args (spirectl validates
            // select-map-node against MapNodeId-or-ElementId, so it must arrive as the named field, not only in Values).
            ElementId: NamedArg(values, "elementId"),
            Values: values.Count > 0 ? values : null);
    }

    private static Dictionary<string, string> CoerceArgs(IReadOnlyDictionary<string, JsonElement>? args)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        if (args is null)
        {
            return values;
        }

        foreach (var (key, element) in args)
        {
            if (key is not ("mapNodeId" or "elementId" or "offsetY"))
            {
                continue;
            }

            var coerced = CoerceArgValue(element);
            if (!string.IsNullOrEmpty(coerced))
            {
                values[key] = coerced;
            }
        }

        return values;
    }

    private static string? CoerceArgValue(JsonElement element)
        => element.ValueKind switch
        {
            JsonValueKind.String => element.GetString(),
            JsonValueKind.Number => element.GetRawText(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            // Null/Object/Array/Undefined are not scalar action arguments — skip them.
            _ => null
        };

    private static string? NamedArg(Dictionary<string, string> values, string key)
        => values.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value) ? value : null;

    private static string NormalizeActionKindToken(string? value)
        => string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim().ToLowerInvariant();

    private static string ToKebabCase(string value)
    {
        var result = new List<char>(value.Length);
        for (var index = 0; index < value.Length; index += 1)
        {
            var character = value[index];
            if (index > 0 && char.IsUpper(character))
            {
                result.Add('-');
            }

            result.Add(char.ToLowerInvariant(character));
        }

        return new string([.. result]);
    }

    private static string FirstNonBlank(params string?[] values)
        => values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value))?.Trim() ?? string.Empty;
}
