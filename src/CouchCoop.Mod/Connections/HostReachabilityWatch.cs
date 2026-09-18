namespace CouchCoop.Mod.Connections;

/// <summary>
/// The one observation that catches a host which is BOUND but unreachable: the browser listener has been up
/// since this lobby opened and has accepted no inbound TCP connection at all.
/// </summary>
/// <remarks>
/// <para>
/// WHY THIS EXISTS. macOS has two inbound gates Linux does not — the Local Network privacy permission and the
/// application firewall — and either one leaves the host in the shape a player reports as "it just doesn't
/// work": the listener binds, the QR encodes a correct address, the phone scans it and times out, and the host
/// looks perfectly healthy. Nothing in the panel says otherwise, because <see cref="ConnectionRegistry"/> rows
/// are created only once a socket has ALREADY arrived (<c>Connected</c>/<c>BeginAttempt</c>) and the only
/// host-issue report in the networking path is the listener failing to bind. A blocked connection produces
/// neither: it never reaches <c>accept</c>, so there is nothing to fail and nothing to log.
/// </para>
/// <para>
/// WHAT IT CANNOT KNOW, AND WHY THE COPY IS SHAPED THE WAY IT IS. "Nobody has tried to join yet" and "nobody
/// can get through" are the SAME observation from inside this process. Both are zero accepted connections;
/// there is no third signal that separates them. (The mDNS self-check is about UDP 5353 and, on a Mac, about
/// Bonjour rather than us; the LAN discovery responder only hears the Godot native client, never a phone.) So
/// this row never accuses a firewall of anything — it states the fact it actually has, says plainly that the
/// normal case is nobody having scanned yet, and then names what to check IF someone is trying. A diagnostic
/// that cries wolf at a solo player is worse than no diagnostic at all.
/// </para>
/// <para>
/// THE CLOCK STARTS AT THE HOST LOBBY, NOT AT BIND. The browser listener comes up at mod init and stays up for
/// the whole process — it is the "idle server" the product accepts — so a threshold measured from the bind
/// would fire during every solo run by a player who never wanted co-op. <c>StartDiscoveryServices</c> is the
/// moment co-op is plausibly about to be used (a HOST lobby is on screen), which makes it both the honest
/// anchor and the one already wired for exactly this question.
/// </para>
/// <para>
/// Deliberately free of Godot, Harmony and game types, like <see cref="CouchCoopPatchHealth"/> beside it: it is
/// written from the networking layer and read by the panel, so it must stay constructible with no engine.
/// </para>
/// </remarks>
public sealed class HostReachabilityWatch
{
    /// <summary>
    /// The issue code this raises. <c>CouchCoopConnectionPanel.IssueKey</c> MUST carry an arm for it — an
    /// unmapped code does not render a missing string, it renders the wrong sentence (the <c>join</c> default).
    /// </summary>
    public const string IssueCode = "host-no-inbound-connections";

    /// <summary>
    /// The code raised INSTEAD of <see cref="IssueCode"/> when the host has asked its own firewall and been
    /// told plainly that it is the blocker. <c>CouchCoopConnectionPanel.IssueKey</c> MUST carry an arm for
    /// this one too.
    /// </summary>
    /// <remarks>
    /// A separate code rather than a differently-worded detail because the two need opposite actions from the
    /// player: the ambiguous row's is "wait, or go and look at your network", and this one's is "there is a
    /// rule on this computer, change it". Only <see cref="WindowsFirewallVerdict.BlockRule"/>,
    /// <see cref="WindowsFirewallVerdict.NoAllowRule"/> and <see cref="WindowsFirewallVerdict.ProfileMismatch"/>
    /// earn it; everything else, including every failure to ask, keeps the honest ambiguous row.
    /// </remarks>
    public const string FirewallIssueCode = "host-firewall-blocked";

    /// <summary>English fallback copy, for the copyable report. The PANEL resolves its own localized strings.</summary>
    public const string IssueSummary = "No phone or browser has connected to this PC yet.";

    public const string IssueAction =
        "If nobody has tried yet, this is normal. If someone is trying and it times out, allow this game to "
        + "accept incoming connections in your system's firewall and local-network settings.";

    public const string FirewallIssueSummary = "This computer's firewall is blocking players from connecting.";

    public const string FirewallIssueAction =
        "Allow Slay the Spire 2 through Windows Firewall as a program, for the Private profile, and remove any "
        + "block rule left behind by an earlier prompt.";

    /// <summary>Seconds to wait before warning. <c>0</c>/<c>off</c>/<c>false</c>/<c>no</c> disables the watch.</summary>
    public const string WarnSecondsEnvironmentVariable = "COUCHCOOP_REACHABILITY_WARN_SECONDS";

    /// <summary>
    /// 90 seconds after a host lobby appears.
    /// </summary>
    /// <remarks>
    /// Long enough that a join which WORKS always beats it — scan, load, pick a seat is well under a minute
    /// from the lobby appearing — so a working session never sees this row. Long enough, too, that a host who
    /// opened a lobby to wait for somebody to arrive is not warned about it immediately. Short enough that it
    /// is already on screen when the player goes looking for an explanation, rather than arriving after they
    /// have given up: a phone's own TCP connect timeout is tens of seconds, so by 90s a player who tried has
    /// tried, failed, and is now reading this panel.
    /// </remarks>
    public const int DefaultWarnSeconds = 90;

    /// <summary>Clamp band for the override. The floor stops an operator making it fire during a normal join.</summary>
    public const int MinimumWarnSeconds = 15;

    public const int MaximumWarnSeconds = 3600;

    public static HostReachabilityWatch Shared { get; } = new();

    private readonly ConnectionRegistry _registry;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;
    private readonly Func<CancellationToken, Task<WindowsFirewallReading?>> _firewall;
    private readonly Action<string>? _log;
    private readonly object _gate = new();

    // Read without the lock on every accepted connection, which is the only hot path here.
    private volatile bool _sawInbound;

    private bool _armed;
    private Guid? _issueId;
    private CancellationTokenSource? _cancellation;

    public HostReachabilityWatch(
        ConnectionRegistry? registry = null,
        Func<TimeSpan, CancellationToken, Task>? delay = null,
        Action<string>? log = null)
        : this(registry, delay, log, firewall: null)
    {
    }

    /// <summary>Test seam for the firewall reading, which a unit test must never take from the real OS.</summary>
    internal HostReachabilityWatch(
        ConnectionRegistry? registry,
        Func<TimeSpan, CancellationToken, Task>? delay,
        Action<string>? log,
        Func<CancellationToken, Task<WindowsFirewallReading?>>? firewall)
    {
        _registry = registry ?? ConnectionRegistry.Shared;
        _delay = delay ?? Task.Delay;
        _firewall = firewall ?? WindowsFirewallProbe.ReadAsync;
        _log = log;
    }

    /// <summary>True once anything at all has connected to this host's listener since the process started.</summary>
    public bool SawInboundConnection => _sawInbound;

    /// <summary>True while a warning is scheduled or standing.</summary>
    public bool IsArmed
    {
        get
        {
            lock (_gate)
            {
                return _armed;
            }
        }
    }

    /// <summary>The raised row's id, or null while none is standing. Tests and diagnostics.</summary>
    public Guid? RaisedIssueId
    {
        get
        {
            lock (_gate)
            {
                return _issueId;
            }
        }
    }

    /// <summary>The scheduled wait, so a test can await the decision instead of sleeping. Null when unarmed.</summary>
    internal Task? PendingWatch { get; private set; }

    /// <summary>
    /// Start the clock. Idempotent: the first call wins and later ones are free, so an arming signal that
    /// repeats (the panel controller's tick raises its host-lobby event every 0.25s) costs nothing.
    /// </summary>
    /// <param name="endpoint">The join URL the host is handing out, for the technical detail. May be null.</param>
    public void Arm(string? endpoint = null)
    {
        var seconds = ResolveWarnSeconds(Environment.GetEnvironmentVariable(WarnSecondsEnvironmentVariable));
        Arm(endpoint, seconds);
    }

    /// <summary>Arm with an explicit threshold, bypassing the environment. Tests and callers that know better.</summary>
    public void Arm(string? endpoint, int warnSeconds)
    {
        if (warnSeconds <= 0)
        {
            return;
        }

        // Something already reached this listener, so the question this watch asks is already answered. Checked
        // before the lock AND inside it: a probe that arrived before the lobby opened still counts as proof.
        if (_sawInbound)
        {
            return;
        }

        CancellationToken token;
        lock (_gate)
        {
            if (_armed || _sawInbound)
            {
                return;
            }

            _armed = true;
            _cancellation = new CancellationTokenSource();
            token = _cancellation.Token;
        }

        PendingWatch = WatchAsync(endpoint, warnSeconds, token);
    }

    /// <summary>
    /// A TCP connection reached this host's listener. Proof that inbound packets arrive here at all — which is
    /// precisely what a Local Network refusal or a firewall block makes impossible.
    /// </summary>
    /// <remarks>
    /// Called once per accepted socket, so the already-seen path is one volatile read and a return. It counts
    /// the raw accept rather than a completed WebSocket join on purpose: a connection refused by our own
    /// admission limiter, or one that only ever fetched the SPA, still proves reachability, which is the single
    /// thing this watch is asking about.
    /// </remarks>
    public void NoteInboundConnection()
    {
        if (_sawInbound)
        {
            return;
        }

        Guid? raised;
        lock (_gate)
        {
            if (_sawInbound)
            {
                return;
            }

            _sawInbound = true;
            _armed = false;
            raised = _issueId;
            _issueId = null;
            Cancel();
        }

        if (raised is { } issueId)
        {
            // Removed rather than archived as "recovered": "nothing has connected yet" is a statement about the
            // present, and once something has, keeping it in the saved-problems list is a sentence that is no
            // longer true about a session that is now working.
            _registry.Dismiss(issueId);
            _log?.Invoke("host-reachability cleared — a connection reached the browser listener");
        }
    }

    /// <summary>Stop watching and withdraw any standing row. Used when the host services go away.</summary>
    public void Disarm()
    {
        Guid? raised;
        lock (_gate)
        {
            if (!_armed && _issueId is null)
            {
                return;
            }

            _armed = false;
            raised = _issueId;
            _issueId = null;
            Cancel();
        }

        if (raised is { } issueId)
        {
            _registry.Dismiss(issueId);
        }
    }

    /// <summary>Forget everything, including the inbound latch. Tests only.</summary>
    internal void ResetForTests()
    {
        lock (_gate)
        {
            _sawInbound = false;
            _armed = false;
            _issueId = null;
            Cancel();
        }

        PendingWatch = null;
    }

    private void Cancel()
    {
        try
        {
            _cancellation?.Cancel();
            _cancellation?.Dispose();
        }
        catch (ObjectDisposedException)
        {
        }

        _cancellation = null;
    }

    private async Task WatchAsync(string? endpoint, int warnSeconds, CancellationToken token)
    {
        try
        {
            await _delay(TimeSpan.FromSeconds(warnSeconds), token).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is OperationCanceledException or ObjectDisposedException)
        {
            return;
        }

        lock (_gate)
        {
            // Re-checked under the lock rather than trusted from before the wait: a connection that lands while
            // the delay is completing must not leave a row nobody will ever clear.
            if (_sawInbound || !_armed || _issueId is not null || token.IsCancellationRequested)
            {
                return;
            }
        }

        // Asked only now, and only on Windows: the query costs a process, and a host whose join works never
        // gets here. A null reading (switched off, another OS, or anything that could not be answered) leaves
        // the copy exactly as it was.
        var firewall = await _firewall(token).ConfigureAwait(false);
        var accuses = firewall?.Verdict is WindowsFirewallVerdict.BlockRule
            or WindowsFirewallVerdict.NoAllowRule
            or WindowsFirewallVerdict.ProfileMismatch;

        var detail = Describe(warnSeconds, endpoint, OperatingSystem.IsMacOS(), OperatingSystem.IsWindows(), firewall?.Detail);
        // Outside the lock: the registry takes its own, and reporting kicks off a log read.
        var issueId = accuses
            ? _registry.ReportHostIssue(FirewallIssueCode, FirewallIssueSummary, FirewallIssueAction, detail, isWarning: true)
            : _registry.ReportHostIssue(IssueCode, IssueSummary, IssueAction, detail, isWarning: true);

        var stale = false;
        lock (_gate)
        {
            if (_sawInbound || !_armed)
            {
                stale = true;
            }
            else
            {
                _issueId = issueId;
            }
        }

        if (stale)
        {
            _registry.Dismiss(issueId);
            return;
        }

        var code = accuses ? FirewallIssueCode : IssueCode;
        var verdict = firewall is null ? "not-asked" : firewall.Verdict.ToString();
        _log?.Invoke($"host-ui diagnostic code={code} detail=no-inbound-connection-in-{warnSeconds}s firewall={verdict}");
    }

    /// <summary>
    /// Pure threshold reader. Unset is <see cref="DefaultWarnSeconds"/>; an explicit falsey value or a
    /// non-positive number disables the watch; anything else is clamped into the band. Garbage falls back to
    /// the default rather than disabling — a typo must not silently remove a diagnostic.
    /// </summary>
    public static int ResolveWarnSeconds(string? rawValue)
    {
        var value = rawValue?.Trim();
        if (string.IsNullOrEmpty(value))
        {
            return DefaultWarnSeconds;
        }

        if (value.Equals("off", StringComparison.OrdinalIgnoreCase)
            || value.Equals("false", StringComparison.OrdinalIgnoreCase)
            || value.Equals("no", StringComparison.OrdinalIgnoreCase))
        {
            return 0;
        }

        if (!int.TryParse(value, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var seconds))
        {
            return DefaultWarnSeconds;
        }

        return seconds <= 0 ? 0 : Math.Clamp(seconds, MinimumWarnSeconds, MaximumWarnSeconds);
    }

    /// <summary>
    /// The technical detail carried into the copyable report. English and un-localized like every other issue
    /// detail, and the only place the exact per-OS settings paths live — the player-facing action stays one
    /// short sentence in fourteen languages.
    /// </summary>
    /// <param name="firewallSentence">
    /// What this computer's own firewall said when it was asked (<c>WindowsFirewallProbe</c>), or null when
    /// there was nothing to ask or no answer. A STRING rather than the verdict type so this method — which is
    /// public, and mirrored into the hot-reload assembly — does not publish the probe's internals.
    /// </param>
    public static string Describe(int warnSeconds, string? endpoint, bool isMacOS, bool isWindows, string? firewallSentence = null)
    {
        var where = string.IsNullOrWhiteSpace(endpoint) ? "the browser server" : endpoint.Trim();
        var gates = isMacOS
            ? "macOS gates inbound connections twice, and both leave the host bound and listening while every "
                + "phone times out: System Settings > Privacy & Security > Local Network must list this game "
                + "(and Steam, which launched it), and System Settings > Network > Firewall > Options must not "
                + "be blocking incoming connections for it. \"Block all incoming connections\" overrides the "
                + "per-app allowance."
            : isWindows
                ? "Windows: the game needs an inbound allow rule for its TCP port, and a network marked Public "
                    + "blocks far more than one marked Private."
                : "Check that the host firewall allows inbound connections on this port.";

        var asked = string.IsNullOrWhiteSpace(firewallSentence) ? string.Empty : " " + firewallSentence!.Trim();
        return $"No inbound TCP connection has reached {where} in the {warnSeconds}s since this host lobby "
            + "opened. This host cannot tell \"nobody has scanned the code yet\" from \"nothing can reach this "
            + "port\": a blocked connection never reaches accept(), so both look identical from here. "
            + gates
            + " On every platform the phone must be on the same network as this PC."
            + asked;
    }
}
