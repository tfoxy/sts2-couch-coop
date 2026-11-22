using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Protocol;

namespace CouchCoop.Mod.Server;

public sealed partial class CouchCoopBrowserServer
{
    private static readonly Regex RenderRoute = new(
        @"^/render-stream/([0-9a-fA-F]{32})/(ws|resources/sha256/[0-9a-f]{64})$", RegexOptions.CultureInvariant);
    private static readonly Regex PrivateHub = new(@"^(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$", RegexOptions.CultureInvariant);
    private static readonly Regex PrivateOrigin = new(@"^http://(127\.0\.0\.1|localhost|\[::1\]):([1-9][0-9]{0,4})$", RegexOptions.CultureInvariant);

    private async Task HandleRenderStreamAsync(Stream browser, CouchCoopHttpRequest request, ReadOnlyMemory<byte> rawHeader,
        bool secure, IPAddress remoteAddress, CancellationToken token)
    {
        // Validate the browser's public origin before translating it to the private hub's allow-list.
        if (request.Header("Origin") is { } publicOrigin && CouchCoopWebOrigin.Normalize(publicOrigin) != publicOrigin
            || !CouchCoopWebOrigin.IsAllowedWebSocketOrigin(request.Header("Origin"), request.Header("Host")))
        {
            await RenderStreamRelay.ErrorAsync(browser, 403, null, token).ConfigureAwait(false);
            return;
        }
        var route = RenderRoute.Match(request.RawPath);
        if (!route.Success || request.Query.Length != 0 || rawHeader.IsEmpty)
        {
            await RenderStreamRelay.ErrorAsync(browser, 410, request.Header("Origin"), token).ConfigureAwait(false);
            return;
        }
        if (request.Method is not ("GET" or "OPTIONS") || request.Header("Transfer-Encoding") is not null
            || request.Header("Content-Length") is { } length && length != "0"
            || route.Groups[2].Value == "ws" && !request.IsWebSocketUpgrade)
        {
            await RenderStreamRelay.ErrorAsync(browser, 405, request.Header("Origin"), token).ConfigureAwait(false);
            return;
        }
        var relay = rendererSwapHost as IHotRenderStreamRelayHost;
        if (_isHeadlessClient || rendererSwapHost is IHotSelfRenderStreamHost { SupportsSelfRenderStream: true }
            && relay?.RenderStreamSeatRoute == route.Groups[1].Value)
        {
            await RelayLocalRenderStreamAsync(browser, request, route, token).ConfigureAwait(false);
            return;
        }
        if (!_isHeadlessClient)
        {
            if (_headlessManager is null || !_headlessManager.TryResolveSeatRelay(route.Groups[1].Value, out var name, out var credential))
            {
                await RenderStreamRelay.ErrorAsync(browser, 410, request.Header("Origin"), token).ConfigureAwait(false);
                return;
            }
            try
            {
                await SeatBrowserPipe.RelayRenderAsync(name, credential, browser, request, rawHeader,
                    remoteAddress, secure, token).ConfigureAwait(false);
            }
            catch (Exception error) when (error is IOException or TimeoutException or UnauthorizedAccessException
                or OperationCanceledException && !token.IsCancellationRequested)
            {
                // Capture requests never retire a seat or its control transport.
                await RenderStreamRelay.ErrorAsync(browser, error is TimeoutException ? 504 : 502, request.Header("Origin"), token).ConfigureAwait(false);
            }
            return;
        }
    }

    private async Task RelayLocalRenderStreamAsync(Stream browser, CouchCoopHttpRequest request, Match route,
        CancellationToken token)
    {
        var access = HostBrowserAccess;
        var accessState = access?.State;
        var relay = rendererSwapHost as IHotRenderStreamRelayHost;
        var status = rendererSwapHost?.RendererStatus;
        if (!_isHeadlessClient && accessState is not { Allowed: true }
            || relay is not { SupportsRenderStreamRelay: true } || relay.RenderStreamSeatRoute != route.Groups[1].Value
            || status is not { State: "armed", Snapshot: { } arm })
        {
            await RenderStreamRelay.ErrorAsync(browser, 410, request.Header("Origin"), token).ConfigureAwait(false);
            return;
        }
        var hub = PrivateHub.Match(arm.Listen);
        var origin = (Environment.GetEnvironmentVariable("GRC_LIVE_ALLOWED_ORIGINS") ?? "")
            .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .FirstOrDefault(value => PrivateOrigin.IsMatch(value) && int.Parse(PrivateOrigin.Match(value).Groups[2].Value) <= 65535);
        if (!hub.Success || !int.TryParse(hub.Groups[2].Value, out var port) || port > 65535 || origin is null)
        {
            await RenderStreamRelay.ErrorAsync(browser, 502, request.Header("Origin"), token).ConfigureAwait(false);
            return;
        }
        bool Current() => (_isHeadlessClient || access?.IsAllowed(accessState!.Generation) == true)
            && rendererSwapHost!.RendererStatus is { State: "armed", Snapshot: { } current } && current == arm;
        using var accessStop = access is null ? null : CancellationTokenSource.CreateLinkedTokenSource(token);
        var relayToken = accessStop?.Token ?? token;
        void AccessChanged(HostBrowserAccessState state)
        {
            if (state.Allowed && state.Generation == accessState!.Generation) return;
            try { accessStop!.Cancel(); }
            catch (ObjectDisposedException) { }
        }
        if (access is not null) access.Changed += AccessChanged;
        try
        {
            // Recheck after subscribing so a change during admission cannot escape the relay's lifetime.
            if (access is not null && !access.IsAllowed(accessState!.Generation))
            {
                await RenderStreamRelay.ErrorAsync(browser, 410, request.Header("Origin"), token).ConfigureAwait(false);
                return;
            }
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(relayToken);
            deadline.CancelAfter(TimeSpan.FromSeconds(2));
            using var upstream = await RenderStreamRelay.ConnectUpstreamAsync(
                IPAddress.Parse(hub.Groups[1].Value.Trim('[', ']')), port, deadline.Token).ConfigureAwait(false);
            if (!Current())
            {
                await RenderStreamRelay.ErrorAsync(browser, 410, request.Header("Origin"), token).ConfigureAwait(false);
                return;
            }
            var target = route.Groups[2].Value == "ws" ? "/render-stream" : "/" + route.Groups[2].Value;
            await RenderStreamRelay.ForwardAsync(upstream.GetStream(), browser, request,
                RenderStreamRelay.RequestHeader(request, target, arm.Listen, origin), relayToken, Current).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (accessStop?.IsCancellationRequested == true && !token.IsCancellationRequested)
        {
            await RenderStreamRelay.ErrorAsync(browser, 410, request.Header("Origin"), token).ConfigureAwait(false);
        }
        catch (Exception error) when (error is SocketException or IOException or OperationCanceledException && !token.IsCancellationRequested)
        {
            await RenderStreamRelay.ErrorAsync(browser, error is OperationCanceledException ? 504 : 502,
                request.Header("Origin"), token).ConfigureAwait(false);
        }
        finally
        {
            if (access is not null) access.Changed -= AccessChanged;
        }
    }
}
