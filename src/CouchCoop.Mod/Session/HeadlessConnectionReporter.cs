using System.Diagnostics;
using System.Globalization;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;
using Spirectl.Sts2.Embedding;

namespace CouchCoop.Mod.Session;

/// <summary>Child-side best-effort reporter for its native connection and browser presence.</summary>
public sealed class HeadlessConnectionReporter : IDisposable
{
    // Internal rather than private so a test can point a reporter at a real control endpoint and assert what
    // actually goes over the wire, instead of restating these three names as literals beside it.
    internal const string ControlUrlEnvironmentVariable = "COUCHCOOP_HEADLESS_CONTROL_URL";
    internal const string ControlTokenEnvironmentVariable = "COUCHCOOP_HEADLESS_CONTROL_TOKEN";
    internal const string ControlGenerationEnvironmentVariable = "COUCHCOOP_HEADLESS_CONTROL_GENERATION";
    private static readonly object StaticGate = new();
    private static HeadlessConnectionReporter? _current;

    /// <summary>
    /// The one client every status goes out on, with the machine's PROXY CONFIGURATION TAKEN OUT OF THE PATH.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This is a loopback IPC channel between two processes of the same game on one computer, and it has no
    /// business consulting a proxy. A bare <c>new HttpClient()</c> does: it falls back to
    /// <see cref="HttpClient.DefaultProxy"/>, which on Windows is built from the user's WinINET settings and on
    /// every platform honours <c>HTTP_PROXY</c>. A proxy configured without a loopback bypass therefore breaks
    /// exactly this POST while leaving the player's browser — which bypasses localhost on its own — working
    /// perfectly, and the seat then looks silent for reasons no log could explain. Turning it off costs nothing
    /// (127.0.0.1 was never going through a proxy usefully) and removes a whole family of that shape.
    /// </para>
    /// <para>
    /// Redirects off for the same reason the route is a single POST: the only legitimate answer from the host is
    /// the control response, and a redirect to anywhere else is not something to follow with a bearer token.
    /// </para>
    /// </remarks>
    private static readonly HttpClient Client = new(new SocketsHttpHandler
    {
        UseProxy = false,
        AllowAutoRedirect = false,
    })
    {
        Timeout = TimeSpan.FromSeconds(2),
    };

    /// <summary>
    /// Why the control channel is not working, in THIS seat's own <c>godot.log</c>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// WHY THIS EXISTS. <see cref="SendOnceAsync"/> swallowed every failure in a bare <c>catch</c> and dropped
    /// every non-2xx answer without a word, and <see cref="TryReadEnvironment"/> returning false built no
    /// reporter at all — also without a word. So a seat whose channel was dead produced no evidence anywhere:
    /// not here, and not on the host, which can only report the absence of a heartbeat. Measured in the field
    /// 2026-09-18, on a report where the seat had joined the lobby, bound its browser port and was idling
    /// healthily while the host waited out its whole 75-second deadline and then blamed startup.
    /// </para>
    /// <para>
    /// ERROR, not <c>Info</c>: only ERROR lines are kept in the copyable report's log excerpt, and this is the
    /// line a support report has to carry. RATE-LIMITED and keyed by failure SHAPE, because the sender runs once
    /// a second for the life of the process: a dead channel costs one line per window rather than 75 of them,
    /// and a cause that CHANGES is printed at once instead of being hidden behind the first one's window.
    /// </para>
    /// </remarks>
    private static readonly RateLimitedDiagnosticLog Diagnostics = new(message => (LogSink ?? CouchCoopLog.Error)(message));

    /// <summary>
    /// Where the lines above go. The same seam <c>CouchCoopCacheRoot</c> and <c>HeadlessUserDirSeeder</c> use,
    /// and for the same reason: the default writes through the GAME's logger, which is not callable outside a
    /// game process, so a test asserting what this says has to be able to take the line itself.
    /// </summary>
    internal static Action<string>? LogSink { get; set; }

    /// <summary>Whether this process has already said, once, that the channel came up. See <c>NoteAccepted</c>.</summary>
    private static int _acceptedLogged;

    /// <summary>
    /// The browser port this process actually bound, reported on every heartbeat. STATIC rather than per-instance
    /// because the two are not ordered: the browser server may bind before <see cref="Initialize"/> runs, or
    /// after it, depending on how far mod init has got. Whichever happens first, the other reads it.
    /// </summary>
    private static int _browserPort;

    /// <summary>
    /// The status sequence, for the WHOLE PROCESS rather than per reporter instance.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The host drops any status whose sequence is not ahead of the last one it accepted for this generation
    /// (<c>HeadlessConnectionControl.Observe</c>), and this process has three senders: the guards' one-shot
    /// reports at mod init, the seat's hello, and the live heartbeat. A per-instance counter made the hello and
    /// the reporter's first heartbeat both claim 1, so the host silently dropped the heartbeat — and, more
    /// quietly, a reporter re-created by a hot reload restarted at 1 and had every status rejected until it
    /// climbed past the old one's high-water mark. One counter cannot do either. It only ever over-counts, which
    /// costs nothing: a fresh generation starts the host's side at zero.
    /// </para>
    /// </remarks>
    private static long _sequence;

    private readonly Uri _endpoint;
    private readonly string _token;
    private readonly long _generation;
    private readonly Action<string> _requestShutdown;
    private readonly IDisposable _subscription;
    private readonly Timer _heartbeat;
    private readonly object _reportGate = new();
    private int _browserCount;
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
        if (!TryReadEnvironment(out var endpoint, out var token, out var generation, out var fault))
        {
            ReportNoChannel(fault);
            return;
        }

        lock (StaticGate)
        {
            _current?.Dispose();
            _current = new HeadlessConnectionReporter(runtime, endpoint, token, generation, requestShutdown);
        }
    }

    public static void BrowserOpened() => ChangeBrowserCount(1);
    public static void BrowserClosed() => ChangeBrowserCount(-1);

    /// <summary>
    /// Tell the host which browser port this process actually bound, and push it immediately rather than waiting
    /// for the next one-second tick — the host is deciding, right now, whether the port it assigned is the port
    /// the browser should be sent to.
    /// </summary>
    public static void PublishBrowserPort(int port)
    {
        if (port is < 0 or > ushort.MaxValue) return;
        Volatile.Write(ref _browserPort, port);
        lock (StaticGate) _current?.QueueReport();
    }

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
        var started = Stopwatch.GetTimestamp();
        try
        {
            var native = _native;
            var status = new HeadlessConnectionStatus(
                NextSequence(),
                native?.Phase.ToString() ?? "starting",
                Bound(native?.Error?.Code, 128),
                Bound(native?.Error?.NativeDetail, 2048),
                Volatile.Read(ref _browserCount),
                Volatile.Read(ref _browserPort),
                ViewerArrivals(),
                // The seat's standing declaration that it is keeping out of the account's cloud saves. On every
                // heartbeat rather than once at startup, because the host's check is "the last thing this seat
                // said", and a fact stated once is a fact the host would have to remember on the seat's behalf.
                HeadlessSeatCloudIsolationGuard.Installed);
            using var request = new HttpRequestMessage(HttpMethod.Post, _endpoint)
            {
                Content = new StringContent(JsonSerializer.Serialize(status), Encoding.UTF8, "application/json")
            };
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
            request.Headers.Add("X-CouchCoop-Generation", _generation.ToString(System.Globalization.CultureInfo.InvariantCulture));
            using var response = await Client.SendAsync(request).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                // A REFUSAL, and it used to be indistinguishable from success. The host answers non-2xx when it
                // does not recognise the token or the generation (`HeadlessConnectionControl.Observe`), which is
                // a completely different fault from an unreachable host and has a completely different fix —
                // yet both left this method having returned quietly.
                Report("control-status-refused", $"the host answered {Status(response)}", started);
                return;
            }

            NoteAccepted();
            var command = await response.Content.ReadFromJsonAsync<HeadlessConnectionControlResponse>().ConfigureAwait(false);
            if (command?.Shutdown == true) _requestShutdown("host-requested-shutdown");
        }
        catch (Exception exception)
        {
            // A transient host startup/shutdown failure must never block the game loop or exit a child — so this
            // still swallows everything. What it no longer does is swallow it SILENTLY.
            Report("control-status-failed", Describe(exception), started);
        }
    }

    /// <summary>
    /// Say, once per process, that the host has accepted a status — so the seat's own log dates the moment its
    /// control channel came up, and its ABSENCE is evidence in every report where it never did.
    /// </summary>
    /// <remarks>
    /// <c>Info</c> and exactly one line: a healthy seat must stay quiet in the one file a support report is read
    /// from, and this is the cheapest line that makes "the channel never worked" falsifiable.
    /// </remarks>
    private static void NoteAccepted()
    {
        if (Interlocked.Exchange(ref _acceptedLogged, 1) != 0) return;
        CouchCoopLog.Info("seat control channel up: the host accepted this seat's first status");
    }

    /// <summary>
    /// Record one control-channel failure, naming the endpoint it was talking to. See <see cref="Diagnostics"/>
    /// for why this is rate-limited and why it is ERROR.
    /// </summary>
    /// <remarks>
    /// The endpoint is quoted because a wrong one is a real failure shape (a host whose listener moved), and it
    /// is safe to quote: the URL is a loopback address, a port and a fixed path. THE BEARER TOKEN IS NEVER
    /// LOGGED — it is this seat's authority to declare its cloud-save isolation, and a log excerpt travels into
    /// support threads.
    /// </remarks>
    private void Report(string code, string cause, long startedTicks)
    {
        if (Volatile.Read(ref _disposed) != 0) return;
        Report(_endpoint, code, cause, startedTicks);
    }

    /// <inheritdoc cref="Report(string,string,long)"/>
    private static void Report(Uri endpoint, string code, string cause, long startedTicks)
    {
        Diagnostics.Write(
            code + ":" + cause,
            $"seat control channel: {cause} after "
            + ((long)Stopwatch.GetElapsedTime(startedTicks).TotalMilliseconds)
                .ToString(CultureInfo.InvariantCulture)
            + $" ms POSTing this seat's status to {endpoint} — until this succeeds the host cannot see this "
            + "seat's phase, browser port or browser count, and will refuse the join with nothing to show for "
            + "it. Check for a proxy, a VPN, or security software on this computer that filters one program "
            + "talking to another.");
    }

    /// <summary>
    /// One send failure, in the shape <c>HeadlessClientManager.DefaultHttpReadinessAsync</c> already composes
    /// for the probe in the other direction: the exception, and the socket error underneath it where there is
    /// one. The socket error is the half that separates a refused connection (nothing listening) from a dropped
    /// one (something is filtering it), and it is lost by the exception type alone.
    /// </summary>
    private static string Describe(Exception exception)
    {
        var socketError = (exception as HttpRequestException)?.InnerException as SocketException
            ?? exception.InnerException as SocketException;
        return socketError is null
            ? exception.GetType().Name
            : $"{exception.GetType().Name}/{socketError.SocketErrorCode}";
    }

    private static string Status(HttpResponseMessage response)
        => ((int)response.StatusCode).ToString(CultureInfo.InvariantCulture) + " " + response.StatusCode;

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
    /// THE SEQUENCE IS NOT A CONSTANT. The host drops any status whose sequence is not ahead of the last one it
    /// saw for this generation (<c>HeadlessConnectionControl.Observe</c>), so a hardcoded 1 is only correct
    /// before the live reporter has sent anything — true of the guards, which report at mod init and then exit,
    /// and false of a reason refined during shutdown, by which point a second of heartbeats has already gone up.
    /// Taking the live reporter's own counter when there is one keeps every terminal report on one rule, and a
    /// late diagnosis from being silently discarded.
    /// </para>
    /// <para>
    /// Returns whether the host accepted it. False means the seat's own environment carries no control
    /// channel, or the host did not answer — never a reason to keep going.
    /// </para>
    /// </remarks>
    public static Task<bool> ReportTerminalFailureAsync(string errorCode, string detail, CancellationToken cancellationToken)
        // The declaration goes on a terminal report too, and it is normally FALSE here: the two guards that call
        // this run before the seat can claim anything, and the cloud-isolation guard reports its own refusal from
        // a process that by definition has not got the guarantee. The host reads the named error code first, so
        // this costs a guard's diagnosis nothing.
        => PostOnceAsync(
            new HeadlessConnectionStatus(
                NextSequence(), "Failed", Bound(errorCode, 128), Bound(detail, 2048), 0,
                Volatile.Read(ref _browserPort), ViewerArrivals(), HeadlessSeatCloudIsolationGuard.Installed),
            cancellationToken);

    /// <summary>
    /// The phase a seat's HELLO carries. Deliberately not one of the four the host acts on
    /// (<c>Connecting</c> / <c>starting</c> / <c>Failed</c> / <c>Disconnected</c>): a hello is contact, never
    /// readiness, and a phase inside the join wait's redirect set would put this status on the readiness path.
    /// It still prints, as <c>child phase: mod-init</c>, which is exactly where the seat is.
    /// </summary>
    internal const string HelloPhase = "mod-init";

    /// <summary>
    /// Say hello: one status carrying "a CouchCoop seat is alive in this process and its Steam Cloud save
    /// isolation is installed", sent from mod init, long before there is a runtime to report through.
    /// </summary>
    /// <remarks>
    /// <para>
    /// WHY THIS EXISTS. The host kills a seat it has heard NOTHING from
    /// (<c>HeadlessClientManager.DefaultSeatContactTimeoutSeconds</c>), and without this the earliest a seat
    /// could speak was <see cref="Initialize"/> — a hundred lines further down <c>CouchCoopMod.Init</c>, behind
    /// the localization load, the cache warm, the atlas walk, every patch and the composition of the runtime.
    /// That made the contact deadline a race against how long this machine takes to start a game, which is the
    /// one thing it must not be: a 15W handheld that is starting perfectly normally would lose it. Sent from the
    /// isolation guard the moment the guarantee holds, it is instead a race against nothing.
    /// </para>
    /// <para>
    /// IT IS NOT READINESS, and must never become it. See <see cref="HelloPhase"/>.
    /// </para>
    /// <para>
    /// Returns whether the host accepted it. A false is not a reason to stop the seat: the process is healthy and
    /// the live reporter will say the same thing a second later. It is only worth logging.
    /// </para>
    /// <para>
    /// <paramref name="cloudSaveIsolated"/> is passed rather than read from
    /// <see cref="HeadlessSeatCloudIsolationGuard.Installed"/> so that what goes on the wire is assertable in a
    /// test process, where no guard can run. The only production caller is the guard itself, on the line after it
    /// latches that value, so the two cannot disagree; every later heartbeat reads the latch.
    /// </para>
    /// </remarks>
    public static Task<bool> ReportSeatHelloAsync(bool cloudSaveIsolated, CancellationToken cancellationToken)
        => PostOnceAsync(
            new HeadlessConnectionStatus(
                NextSequence(), HelloPhase, null, null, 0,
                Volatile.Read(ref _browserPort), ViewerArrivals(), cloudSaveIsolated),
            cancellationToken);

    /// <summary>
    /// POST one status over the authenticated control channel, with no runtime, subscription or heartbeat behind
    /// it. Same endpoint, same bearer token, same generation header as the live reporter, so the host accepts
    /// every one of these through exactly one code path.
    /// </summary>
    private static async Task<bool> PostOnceAsync(HeadlessConnectionStatus status, CancellationToken cancellationToken)
    {
        if (!TryReadEnvironment(out var endpoint, out var token, out var generation, out var fault))
        {
            ReportNoChannel(fault);
            return false;
        }

        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint)
        {
            Content = new StringContent(JsonSerializer.Serialize(status), Encoding.UTF8, "application/json"),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Headers.Add("X-CouchCoop-Generation", generation.ToString(CultureInfo.InvariantCulture));
        var started = Stopwatch.GetTimestamp();
        // The EARLIEST evidence there is. This path carries the seat's hello, sent from the isolation guard at
        // mod init — so when the channel is dead, this is the first thing in the process that knows, seconds
        // before the live reporter's first heartbeat and a minute before the host's deadline. Its callers
        // already handle the failure (a hello is best-effort, a terminal report is bounded); they log it to
        // stderr, which in the shipped Steam flow goes nowhere. Recorded here so it lands in godot.log, then
        // rethrown so no caller's behaviour changes.
        try
        {
            using var response = await Client.SendAsync(request, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                Report(endpoint, "control-status-refused", $"the host answered {Status(response)}", started);
                return false;
            }

            NoteAccepted();
            return true;
        }
        catch (Exception exception) when (!cancellationToken.IsCancellationRequested)
        {
            Report(endpoint, "control-status-failed", Describe(exception), started);
            throw;
        }
    }

    /// <summary>
    /// Say that this seat has no control channel at all — but only where that is a FAULT.
    /// </summary>
    /// <remarks>
    /// A seat launched by hand (QA, a dev loop) carries no control environment and is not supposed to: it has
    /// no host to report to, and an ERROR line there would be noise in every manual run. A process the host
    /// SPAWNED is the opposite case — without this channel it can never be admitted, whatever else it does
    /// right, and today it fails an entire 75-second deadline without one word about why. So the seat flag is
    /// the gate, and the line says which part of the environment was wrong rather than "not configured".
    /// </remarks>
    private static void ReportNoChannel(string? fault) => ReportNoChannel(fault, CouchCoopMod.IsHeadlessClient);

    /// <inheritdoc cref="ReportNoChannel(string?)"/>
    /// <remarks>
    /// <paramref name="spawnedSeat"/> is passed rather than read so the gate is assertable: the flag it comes
    /// from is latched from the environment at static initialisation, so a test process is permanently "not a
    /// seat" and could otherwise only ever observe the silent half of this decision.
    /// </remarks>
    internal static void ReportNoChannel(string? fault, bool spawnedSeat)
    {
        if (!spawnedSeat) return;
        Diagnostics.Write(
            "control-channel-absent",
            "seat control channel is not configured, so this seat can never be admitted: "
            + (fault ?? "no reason was recorded")
            + ". This process was started as a co-op seat by a host, which always sets "
            + $"{ControlUrlEnvironmentVariable}, {ControlTokenEnvironmentVariable} and "
            + $"{ControlGenerationEnvironmentVariable}.");
    }

    /// <summary>The next sequence number for ANY status this process sends. See <see cref="_sequence"/>.</summary>
    private static long NextSequence() => Interlocked.Increment(ref _sequence);

    /// <summary>
    /// The seat's own arrival evidence, read fresh on every send: how much has reached THIS process from
    /// something other than this machine.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The host cannot see this. A viewer's request to a seat lands on the seat's listener, in the seat's
    /// process, and the host learns only that no browser ever completed a connection — which fits a blocked path
    /// and a player who has not tapped the link yet equally well. Carrying the count upstream is what turns the
    /// host's network-path verdict from an inference into an observation.
    /// </para>
    /// <para>
    /// VIEWER arrivals, never <c>TotalArrivalCount</c>: the total includes the host's own loopback readiness
    /// probe of this very port, so reporting it would make every probed seat claim a device had reached it, and
    /// the verdict this feeds would never be reachable again.
    /// </para>
    /// <para>
    /// <paramref name="log"/> is a test seam and nothing else — the process-wide log cannot be written to from a
    /// test process, because its default sink writes through the GAME's logger, which is not callable outside
    /// the game and takes the process down rather than throwing. Passing one in is how the choice of counter
    /// above gets asserted at the line that makes it.
    /// </para>
    /// </remarks>
    internal static long ViewerArrivals(ConnectionArrivalLog? log = null)
        => (log ?? ConnectionArrivalLog.Shared).ViewerArrivalCount;

    private static string? Bound(string? value, int limit)
        => value is { Length: > 0 } && value.Length > limit ? value[..(limit - 14)] + "…[truncated]" : value;

    private static TaskCompletionSource NewReportCompletion()
        => new(TaskCreationOptions.RunContinuationsAsynchronously);

    public static Task FlushAsync(CancellationToken cancellationToken)
    {
        lock (StaticGate) return (_current?.QueueReport() ?? Task.CompletedTask).WaitAsync(cancellationToken);
    }

    /// <summary>This seat's control channel, out of its environment. See <see cref="TryParseChannel"/>.</summary>
    private static bool TryReadEnvironment(out Uri endpoint, out string token, out long generation, out string? fault)
    {
        token = Environment.GetEnvironmentVariable(ControlTokenEnvironmentVariable) ?? string.Empty;
        fault = TryParseChannel(
            Environment.GetEnvironmentVariable(ControlUrlEnvironmentVariable),
            token,
            Environment.GetEnvironmentVariable(ControlGenerationEnvironmentVariable),
            out var parsed,
            out generation);
        endpoint = parsed!;
        return fault is null;
    }

    /// <summary>
    /// The three raw values that make a control channel, parsed — and, when they do not make one, WHICH of
    /// them is why, in English.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Returns <see langword="null"/> when the channel is usable, and the fault otherwise: the shape lets the
    /// one caller above read as "is there a fault?" while every branch keeps its own sentence.
    /// </para>
    /// <para>
    /// PURE, and internal, because the fault text is the load-bearing half. It goes into the seat's
    /// <c>godot.log</c> (see <see cref="ReportNoChannel"/>) and is the only thing that will distinguish "the
    /// host never set this" from "the host set it to something this seat will not talk to" in a support report
    /// — so it is worth asserting directly, without an environment or a game process to stand it up in.
    /// </para>
    /// <para>
    /// It names the variables and quotes the URL, and NEVER the token: that value is this seat's authority to
    /// declare its own cloud-save isolation, and a log excerpt travels into support threads.
    /// </para>
    /// </remarks>
    internal static string? TryParseChannel(
        string? rawUrl,
        string? rawToken,
        string? rawGeneration,
        out Uri? endpoint,
        out long generation)
    {
        endpoint = null;
        generation = 0;
        if (!Uri.TryCreate(rawUrl, UriKind.Absolute, out var parsed))
        {
            return string.IsNullOrWhiteSpace(rawUrl)
                ? $"{ControlUrlEnvironmentVariable} is not set"
                : $"{ControlUrlEnvironmentVariable} is not an absolute URL";
        }

        if (!parsed.IsLoopback || parsed.Scheme != Uri.UriSchemeHttp)
        {
            return $"{ControlUrlEnvironmentVariable} is {parsed}, which is not a loopback http address";
        }

        if (string.IsNullOrWhiteSpace(rawToken) || rawToken.Length > 512)
        {
            return $"{ControlTokenEnvironmentVariable} is "
                + (string.IsNullOrWhiteSpace(rawToken) ? "not set" : "longer than 512 characters");
        }

        if (!long.TryParse(rawGeneration, NumberStyles.Integer, CultureInfo.InvariantCulture, out generation)
            || generation <= 0)
        {
            return $"{ControlGenerationEnvironmentVariable} is not a positive whole number";
        }

        endpoint = parsed;
        return null;
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        _heartbeat.Dispose();
        _subscription.Dispose();
    }

    private sealed record HeadlessConnectionControlResponse(bool Shutdown);
}
