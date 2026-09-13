using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Runtime;
using Spirectl.Sts2.Embedding;

namespace CouchCoop.Mod.Session;

/// <summary>Child-side best-effort reporter for its native connection and browser presence.</summary>
public sealed class HeadlessConnectionReporter : IDisposable
{
    private const string ControlUrlEnvironmentVariable = "COUCHCOOP_HEADLESS_CONTROL_URL";
    private const string ControlTokenEnvironmentVariable = "COUCHCOOP_HEADLESS_CONTROL_TOKEN";
    private const string ControlGenerationEnvironmentVariable = "COUCHCOOP_HEADLESS_CONTROL_GENERATION";
    private static readonly object StaticGate = new();
    private static HeadlessConnectionReporter? _current;
    private static readonly HttpClient Client = new() { Timeout = TimeSpan.FromSeconds(2) };

    private readonly Uri _endpoint;
    private readonly string _token;
    private readonly long _generation;
    private readonly Action<string> _requestShutdown;
    private readonly IDisposable _subscription;
    private readonly Timer _heartbeat;
    private readonly object _reportGate = new();
    private int _browserCount;
    private long _sequence;
    private MultiplayerConnectionSnapshot? _native;
    private int _disposed;
    private bool _sending;
    private TaskCompletionSource? _activeReport;
    private TaskCompletionSource? _pendingReport;

    private HeadlessConnectionReporter(CouchCoopRuntimeHost runtime, Uri endpoint, string token, long generation, Action<string> requestShutdown)
    {
        _endpoint = endpoint;
        _token = token;
        _generation = generation;
        _requestShutdown = requestShutdown;
        _native = runtime.GetCurrentMultiplayerConnection();
        _subscription = runtime.SubscribeMultiplayerConnection(OnNativeConnection);
        _heartbeat = new Timer(_ => QueueReport(), null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
        QueueReport();
    }

    public static void Initialize(CouchCoopRuntimeHost runtime, Action<string> requestShutdown)
    {
        if (!TryReadEnvironment(out var endpoint, out var token, out var generation)) return;
        lock (StaticGate)
        {
            _current?.Dispose();
            _current = new HeadlessConnectionReporter(runtime, endpoint, token, generation, requestShutdown);
        }
    }

    public static void BrowserOpened() => ChangeBrowserCount(1);
    public static void BrowserClosed() => ChangeBrowserCount(-1);

    public static void Stop()
    {
        lock (StaticGate)
        {
            _current?.Dispose();
            _current = null;
        }
    }

    private static void ChangeBrowserCount(int delta)
    {
        lock (StaticGate)
        {
            var current = _current;
            if (current is null) return;
            current._browserCount = Math.Max(0, current._browserCount + delta);
            current.QueueReport();
        }
    }

    private void OnNativeConnection(MultiplayerConnectionSnapshot snapshot)
    {
        lock (StaticGate)
        {
            if (_native is { } previous && snapshot.Sequence < previous.Sequence) return;
            if (_native is { Phase: MultiplayerConnectionPhase.Failed } && snapshot.Phase == MultiplayerConnectionPhase.Disconnected)
                return;
            _native = snapshot;
            if (snapshot.Phase == MultiplayerConnectionPhase.Failed)
            {
                // The shutdown sequence arms its backstop before FlushAsync publishes this terminal status.
                _requestShutdown(snapshot.Error?.Code ?? "native-connection-failed");
                return;
            }
            QueueReport();
        }
    }

    private Task QueueReport()
    {
        if (Volatile.Read(ref _disposed) != 0) return Task.CompletedTask;
        lock (_reportGate)
        {
            if (_sending)
            {
                // One in-flight report plus one latest-state follow-up bounds work while a dead host leaves
                // HttpClient waiting for its timeout. Every caller waiting for the follow-up shares this task.
                _pendingReport ??= NewReportCompletion();
                return _pendingReport.Task;
            }

            _sending = true;
            var completion = NewReportCompletion();
            _activeReport = completion;
            _ = Task.Run(SendLoopAsync);
            return completion.Task;
        }
    }

    private async Task SendLoopAsync()
    {
        while (true)
        {
            await SendOnceAsync().ConfigureAwait(false);
            TaskCompletionSource completed;
            lock (_reportGate)
            {
                completed = _activeReport!;
                if (_pendingReport is { } pending && Volatile.Read(ref _disposed) == 0)
                {
                    _activeReport = pending;
                    _pendingReport = null;
                }
                else
                {
                    _pendingReport?.TrySetResult();
                    _pendingReport = null;
                    _activeReport = null;
                    _sending = false;
                    completed.TrySetResult();
                    return;
                }
            }

            completed.TrySetResult();
        }
    }

    private async Task SendOnceAsync()
    {
        try
        {
            var native = _native;
            var status = new HeadlessConnectionStatus(
                Interlocked.Increment(ref _sequence),
                native?.Phase.ToString() ?? "starting",
                Bound(native?.Error?.Code, 128),
                Bound(native?.Error?.NativeDetail, 2048),
                Volatile.Read(ref _browserCount));
            using var request = new HttpRequestMessage(HttpMethod.Post, _endpoint)
            {
                Content = new StringContent(JsonSerializer.Serialize(status), Encoding.UTF8, "application/json")
            };
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
            request.Headers.Add("X-CouchCoop-Generation", _generation.ToString(System.Globalization.CultureInfo.InvariantCulture));
            using var response = await Client.SendAsync(request).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) return;
            var command = await response.Content.ReadFromJsonAsync<HeadlessConnectionControlResponse>().ConfigureAwait(false);
            if (command?.Shutdown == true) _requestShutdown("host-requested-shutdown");
        }
        catch
        {
            // A transient host startup/shutdown failure must never block the game loop or exit a child.
        }
    }

    /// <summary>
    /// Send ONE terminal status to the host and stop, without a runtime, a subscription or a heartbeat.
    /// </summary>
    /// <remarks>
    /// <para>
    /// For a failure the seat detects before it has a <see cref="CouchCoopRuntimeHost"/> to report through
    /// — today, <see cref="HeadlessSeatBuildGuard"/>, which runs at mod init and must be able to name its
    /// cause and then exit. Same endpoint, same bearer token, same generation header as the live reporter,
    /// so the host accepts it through exactly one code path.
    /// </para>
    /// <para>
    /// Sequence 1: this is the first status the host will have seen for this generation, and the caller
    /// terminates the process, so nothing follows it that a bumped sequence would have to stay ahead of.
    /// </para>
    /// <para>
    /// Returns whether the host accepted it. False means the seat's own environment carries no control
    /// channel, or the host did not answer — never a reason to keep going.
    /// </para>
    /// </remarks>
    public static async Task<bool> ReportTerminalFailureAsync(string errorCode, string detail, CancellationToken cancellationToken)
    {
        if (!TryReadEnvironment(out var endpoint, out var token, out var generation)) return false;
        var status = new HeadlessConnectionStatus(1, "Failed", Bound(errorCode, 128), Bound(detail, 2048), 0);
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint)
        {
            Content = new StringContent(JsonSerializer.Serialize(status), Encoding.UTF8, "application/json"),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Headers.Add("X-CouchCoop-Generation", generation.ToString(System.Globalization.CultureInfo.InvariantCulture));
        using var response = await Client.SendAsync(request, cancellationToken).ConfigureAwait(false);
        return response.IsSuccessStatusCode;
    }

    private static string? Bound(string? value, int limit)
        => value is { Length: > 0 } && value.Length > limit ? value[..(limit - 14)] + "…[truncated]" : value;

    private static TaskCompletionSource NewReportCompletion()
        => new(TaskCreationOptions.RunContinuationsAsynchronously);

    public static Task FlushAsync(CancellationToken cancellationToken)
    {
        lock (StaticGate) return (_current?.QueueReport() ?? Task.CompletedTask).WaitAsync(cancellationToken);
    }

    private static bool TryReadEnvironment(out Uri endpoint, out string token, out long generation)
    {
        endpoint = null!;
        token = Environment.GetEnvironmentVariable(ControlTokenEnvironmentVariable) ?? string.Empty;
        generation = 0;
        if (!Uri.TryCreate(Environment.GetEnvironmentVariable(ControlUrlEnvironmentVariable), UriKind.Absolute, out var parsed))
        {
            return false;
        }

        endpoint = parsed;
        return endpoint.IsLoopback && endpoint.Scheme == Uri.UriSchemeHttp
            && !string.IsNullOrWhiteSpace(token) && token.Length <= 512
            && long.TryParse(Environment.GetEnvironmentVariable(ControlGenerationEnvironmentVariable), out generation) && generation > 0;
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        _heartbeat.Dispose();
        _subscription.Dispose();
    }

    private sealed record HeadlessConnectionControlResponse(bool Shutdown);
}
