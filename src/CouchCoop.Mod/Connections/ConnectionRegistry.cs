using System.Reflection;

namespace CouchCoop.Mod.Connections;

/// <summary>Process-owned status, independent of the dialog and hot-reloaded server generations.</summary>
public sealed class ConnectionRegistry
{
    public static ConnectionRegistry Shared { get; } = new();
    public static string? HostLogPath { get; set; }
    public static string? HostGameVersion { get; set; }
    public const int MaximumRetainedFailures = 128;
    public const int MaximumReportBytes = 64 * 1024;
    private readonly object _gate = new();
    private readonly TimeProvider _time;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;
    private readonly Dictionary<Guid, Entry> _clients = [];
    private readonly Dictionary<Guid, Entry> _issues = [];
    private readonly Queue<Guid> _issueOrder = [];
    private long _revision;
    private int _overflow;

    public ConnectionRegistry(TimeProvider? time = null) : this(time, null) { }
    internal ConnectionRegistry(TimeProvider? time, Func<TimeSpan, CancellationToken, Task>? delay)
    {
        _time = time ?? TimeProvider.System;
        _delay = delay ?? ((duration, cancellationToken) => Task.Delay(duration, _time, cancellationToken));
    }

    public ConnectionRegistrySnapshot Snapshot()
    {
        lock (_gate)
        {
            var now = _time.GetTimestamp();
            var shown = new HashSet<Guid>(_clients.Values.Where(e => e.IssueId is not null).Select(e => e.IssueId!.Value));
            var rows = _clients.Values.OrderBy(e => e.StartedAtUtc)
                .Concat(_issues.Where(pair => !shown.Contains(pair.Key)).Select(pair => pair.Value).OrderByDescending(e => e.StartedAtUtc))
                .Select(e => Row(e, now)).ToArray();
            return new(_revision, rows, _overflow);
        }
    }

    public void Connected(Guid id, string? deviceLabel)
    {
        lock (_gate)
        {
            if (_clients.ContainsKey(id)) return;
            var entry = new Entry(id, id, _time.GetUtcNow(), _time.GetTimestamp()) { DeviceLabel = Clean(deviceLabel, 256), IsLive = true, LogSource = ConnectionAttemptLogs.CaptureStart(HostLogPath, null) };
            _clients.Add(id, entry);
            Trace(entry, "WebSocket connected");
            Changed();
        }
    }

    public void SetDisplayName(Guid id, string? name) => Update(id, e => e.DisplayName = Clean(name, 256));

    public string BeginAttempt(Guid id, ConnectionStage stage = ConnectionStage.Choosing)
    {
        lock (_gate)
        {
            if (!_clients.TryGetValue(id, out var entry)) return string.Empty;
            EndWaitingIssue(entry, ConnectionIssueOutcome.Ended);
            ArchiveCurrent(entry);
            entry.AttemptId = Guid.NewGuid().ToString("N");
            entry.Issue = null;
            entry.IssueId = null;
            entry.ProcessId = null; entry.ProcessGeneration = null; entry.DetailsExpired = false;
            entry.RequiresChild = true;
            entry.Member = entry.ChildBrowser = entry.FramePresented = false;
            entry.StepTotal = 6;
            entry.Stage = stage;
            entry.StageStartedTicks = _time.GetTimestamp();
            entry.StartedAtUtc = _time.GetUtcNow();
            entry.StartedTicks = entry.StageStartedTicks;
            entry.Timeline.Clear();
            entry.Facts.Clear();
            entry.Logs.Clear();
            entry.LogSource = ConnectionAttemptLogs.CaptureStart(HostLogPath, null);
            entry.SlowNotice = false;
            entry.TransportClosing = entry.InferredTransportIssue = false;
            entry.ChildBrowserMissingTicks = null;
            Trace(entry, "Attempt started");
            Changed();
            return entry.AttemptId;
        }
    }

    public void BindProcess(Guid id, int? processId, long generation)
        => Update(id, e => { e.ProcessId = processId; e.ProcessGeneration = generation; });

    public void BindLogs(Guid id, ConnectionAttemptLogs? logs) => Update(id, e => e.LogSource = logs);

    public void ConfigureView(Guid id, bool requiresChild, bool reused = false)
        => Update(id, e => { e.RequiresChild = requiresChild; e.StepTotal = requiresChild && !reused ? 6 : 4; e.Member = !requiresChild; e.ChildBrowser = !requiresChild; });

    public void Advance(Guid id, ConnectionStage stage, string? detail = null)
    {
        lock (_gate)
        {
            if (!_clients.TryGetValue(id, out var entry) || entry.Stage == ConnectionStage.Failed) return;
            if (stage < entry.Stage || stage == ConnectionStage.Failed) return;
            if (entry.StepTotal == 4 && stage is ConnectionStage.Initializing or ConnectionStage.Joining) return;
            if (stage == entry.Stage && string.IsNullOrWhiteSpace(detail)) return;
            SetStage(entry, stage);
            if (!string.IsNullOrWhiteSpace(detail)) Trace(entry, Clean(detail, 2048)!);
            CompleteIfReady(entry);
            Changed();
        }
    }

    public void SetReadiness(Guid id, bool member, bool childBrowser)
    {
        lock (_gate)
        {
            if (!_clients.TryGetValue(id, out var entry)) return;
            if (childBrowser) entry.ChildBrowserMissingTicks = null;
            if (entry.Stage == ConnectionStage.Complete && entry.RequiresChild && !childBrowser && !entry.TransportClosing)
            {
                // A tab owns two sockets, which can close in either order. Give its original socket time
                // to deliver a clean close before inferring a failure from the child's browser count.
                entry.ChildBrowserMissingTicks ??= _time.GetTimestamp();
                if (Elapsed(entry.ChildBrowserMissingTicks.Value) >= 2_000)
                    FailLocked(entry, new("browser-transport-lost", "The browser disconnected from its game view.",
                        "Reload this browser tab and select the same player to reconnect.", "The child game reported no connected browser."), inferredTransport: true);
            }
            if (entry.Member == member && entry.ChildBrowser == childBrowser) return;
            entry.Member = member;
            entry.ChildBrowser = childBrowser;
            CompleteIfReady(entry);
            Changed();
        }
    }

    public bool Presented(Guid id, string? attemptId)
    {
        lock (_gate)
        {
            if (!TryAttempt(id, attemptId, out var entry) || entry.Stage != ConnectionStage.LoadingView) return false;
            entry.FramePresented = true;
            Trace(entry, "Browser rendered the first game frame");
            CompleteIfReady(entry);
            Changed();
            return true;
        }
    }

    public bool ClientViewError(Guid id, string? attemptId, string? code, string? detail)
    {
        lock (_gate)
        {
            if (!TryAttempt(id, attemptId, out var entry) || entry.Stage is not (ConnectionStage.LoadingView or ConnectionStage.Complete)) return false;
            if (code == "browser-transport-lost")
            {
                FailLocked(entry, new("browser-transport-lost", "The browser disconnected from its game view.",
                    "Reload the browser and select the same player to reconnect.", Clean(detail, 4096)));
                return true;
            }
            FailLocked(entry, new("browser-render-failed", "The browser could not display the game view.",
                "Reload this browser tab. If it fails again, copy this report.", Clean(detail, 4096)));
            return true;
        }
    }

    public void Fail(Guid id, string code, string summary, string action, string? detail = null)
    {
        lock (_gate)
        {
            if (_clients.TryGetValue(id, out var entry))
                FailLocked(entry, new(Clean(code, 96) ?? "connection-failed", Clean(summary, 1024) ?? "Connection failed.",
                    Clean(action, 1024) ?? "Copy this report.", Clean(detail, 8192)));
        }
    }

    public Guid ReportHostIssue(string code, string summary, string action, string? detail = null)
    {
        lock (_gate)
        {
            if (_issues.Values.FirstOrDefault(e => e.DeviceLabel == "Host service" && e.Issue?.Code == code) is { } existing) return existing.Id;
            var id = Guid.NewGuid();
            var entry = new Entry(id, id, _time.GetUtcNow(), _time.GetTimestamp()) { DeviceLabel = "Host service", LogSource = ConnectionAttemptLogs.CaptureAvailable(HostLogPath, null) };
            FailLocked(entry, new(Clean(code, 96) ?? "host-service-failed", summary, action, Clean(detail, 8192)));
            return entry.IssueId!.Value;
        }
    }

    public void NoticeSlowView(Guid id)
    {
        lock (_gate)
        {
            if (!_clients.TryGetValue(id, out var entry) || entry.Stage != ConnectionStage.LoadingView || entry.SlowNotice) return;
            if (Elapsed(entry.StageStartedTicks) < 30_000) return;
            entry.SlowNotice = true;
            Trace(entry, $"{entry.Stage}: {Elapsed(entry.StageStartedTicks)} ms");
            entry.Issue = TimedIssue(entry, new("browser-view-slow", "Still waiting for the browser to display the game.",
                "Keep the browser tab open. Reload it if loading does not finish.", null, IsWarning: true), ConnectionIssueOutcome.Waiting);
            SaveIssue(entry);
            Changed();
        }
    }

    /// <summary>Records a slow-view warning when this attempt has actually spent 30 seconds loading.</summary>
    public async Task NoticeSlowViewWhenDueAsync(Guid id, string? attemptId, CancellationToken cancellationToken = default)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            TimeSpan remaining;
            lock (_gate)
            {
                if (!TryAttempt(id, attemptId, out var entry) || entry.Stage != ConnectionStage.LoadingView || entry.SlowNotice)
                    return;
                remaining = TimeSpan.FromMilliseconds(Math.Max(0, 30_000 - Elapsed(entry.StageStartedTicks)));
                if (remaining == TimeSpan.Zero)
                {
                    // Keep recording atomic with the attempt check: a retry may reuse this client ID.
                    NoticeSlowView(id);
                    return;
                }
            }
            try
            {
                await _delay(remaining, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
        }
    }

    public void Disconnected(Guid id)
    {
        lock (_gate)
        {
            if (!_clients.Remove(id, out var entry)) return;
            entry.IsLive = false;
            EndWaitingIssue(entry, ConnectionIssueOutcome.Ended);
            ArchiveCurrent(entry);
            Changed();
        }
    }

    public void TransportClosing(Guid id)
    {
        lock (_gate)
        {
            if (!_clients.TryGetValue(id, out var entry)) return;
            entry.TransportClosing = true;
            entry.ChildBrowserMissingTicks = null;
            // A confirmed clean close supersedes only this inference. Explicit browser, native and
            // process failures still retain their reports, even when cleanup closes the socket normally.
            if (!entry.InferredTransportIssue) return;
            if (entry.IssueId is { } issueId) _issues.Remove(issueId);
            entry.Issue = null;
            entry.IssueId = null;
            entry.InferredTransportIssue = false;
            SetStage(entry, entry.FailedStage);
            Changed();
        }
    }

    public bool Dismiss(Guid id)
    {
        lock (_gate)
        {
            if (_clients.TryGetValue(id, out var entry))
            {
                if (entry.IssueId is Guid issueId) _issues.Remove(issueId);
                entry.Issue = null;
                entry.IssueId = null;
                entry.InferredTransportIssue = false;
                if (entry.Stage == ConnectionStage.Failed) SetStage(entry, ConnectionStage.Choosing);
                Changed();
                return true;
            }
            if (!_issues.Remove(id)) return false;
            Changed();
            return true;
        }
    }

    public void HostingEnded()
    {
        lock (_gate)
        {
            _issues.Clear(); _issueOrder.Clear(); _overflow = 0;
            foreach (var entry in _clients.Values)
            {
                entry.Issue = null; entry.IssueId = null; entry.Logs.Clear(); entry.Facts.Clear(); entry.Timeline.Clear();
                entry.AttemptId = null; entry.ProcessId = null; entry.ProcessGeneration = null;
                entry.FramePresented = entry.Member = entry.ChildBrowser = false;
                entry.TransportClosing = entry.InferredTransportIssue = false;
                entry.ChildBrowserMissingTicks = null;
                SetStage(entry, ConnectionStage.Choosing);
            }
            Changed();
        }
    }

    public void Clear()
    {
        lock (_gate) { _clients.Clear(); _issues.Clear(); _issueOrder.Clear(); _overflow = 0; Changed(); }
    }

    public void RecordDiagnostic(Guid id, string key, string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || key.Contains("token", StringComparison.OrdinalIgnoreCase)) return;
        lock (_gate)
        {
            if (!TryEntry(id, out var entry) || entry.DetailsExpired) return;
            if (entry.Facts.Count >= 32 && !entry.Facts.ContainsKey(key)) return;
            var safeKey = Clean(key, 64)!;
            var safeValue = Clean(value, 8192)!;
            if (entry.Facts.GetValueOrDefault(safeKey) == safeValue) return;
            entry.Facts[safeKey] = safeValue;
            ArchiveCurrent(entry);
            Changed();
        }
    }

    public void AttachLogExcerpt(Guid id, string source, string text, string status)
    {
        lock (_gate)
        {
            if (!TryEntry(id, out var entry) || entry.DetailsExpired) return;
            entry.Logs[source == "host" ? "host" : "client"] = new(source, status, Clean(text, 32 * 1024) ?? "");
            ArchiveCurrent(entry);
            Changed();
        }
    }

    public string? BuildReport(Guid id)
    {
        ConnectionReportContent report;
        lock (_gate)
        {
            if (!TryEntry(id, out var e)) return null;
            var row = Row(e, _time.GetTimestamp());
            var facts = new Dictionary<string, string>(e.Facts)
            {
                // The same string the host hands each seat it spawns, so a report and a seat's mismatch
                // detail are directly comparable rather than two independent renderings of "our version".
                ["modVersion"] = CouchCoopModBuildIdentity.Current,
                ["hostOS"] = System.Runtime.InteropServices.RuntimeInformation.OSDescription,
                ["gameVersion"] = e.Facts.GetValueOrDefault("gameVersion") ?? HostGameVersion ?? "unknown"
            };
            report = new ConnectionReportContent
            {
                ReportId = e.IssueId ?? e.Id, ClientId = e.ClientId, DeviceLabel = e.DeviceLabel, PlayerName = e.DisplayName,
                Stage = (e.Issue?.Timing?.Stage ?? (e.Stage == ConnectionStage.Failed ? e.FailedStage : e.Stage)).ToString(), Step = row.StepCount, Total = row.StepTotal,
                StartedAtUtc = e.StartedAtUtc, ElapsedMs = row.ElapsedMs, StageElapsedMs = row.StageElapsedMs,
                RecordedAtUtc = e.Issue?.Timing?.RecordedAtUtc ?? default, Outcome = e.Issue?.Outcome, IssueCode = e.Issue?.Code,
                Summary = e.Issue?.Summary, Action = e.Issue?.Action, Detail = e.Issue?.Detail,
                Timeline = e.Timeline.ToArray(), Facts = facts, Logs = e.Logs.Values.ToArray()
            };
        }
        return ConnectionReportFormatter.Format(report);
    }

    public string? AttemptId(Guid id) { lock (_gate) return _clients.GetValueOrDefault(id)?.AttemptId; }
    public bool ForAttempt(Guid id, string? attemptId, Action<ConnectionRegistry> action)
    {
        lock (_gate)
        {
            if (!TryAttempt(id, attemptId, out _)) return false;
            action(this);
            return true;
        }
    }
    public void UseShortPath(Guid id) => ConfigureView(id, requiresChild: false);

    private bool TryAttempt(Guid id, string? attempt, out Entry entry)
        => _clients.TryGetValue(id, out entry!) && !string.IsNullOrEmpty(attempt) && entry.AttemptId == attempt;
    private bool TryEntry(Guid id, out Entry entry)
    {
        if (_clients.TryGetValue(id, out entry!) || _issues.TryGetValue(id, out entry!)) return true;
        entry = _issues.Values.LastOrDefault(e => e.ClientId == id)!;
        return entry is not null;
    }
    private void Update(Guid id, Action<Entry> action)
    {
        lock (_gate) { if (!_clients.TryGetValue(id, out var e)) return; action(e); Changed(); }
    }
    private long Elapsed(long started) => Math.Max(0, (long)_time.GetElapsedTime(started).TotalMilliseconds);
    private void SetStage(Entry e, ConnectionStage stage)
    {
        if (e.Stage == stage) return;
        Trace(e, $"{e.Stage}: {Elapsed(e.StageStartedTicks)} ms");
        e.Stage = stage;
        e.StageStartedTicks = _time.GetTimestamp();
    }
    private void CompleteIfReady(Entry e)
    {
        if (e.Stage != ConnectionStage.LoadingView || !e.FramePresented || !e.Member || (e.RequiresChild && !e.ChildBrowser)) return;
        if (e.Issue?.IsWarning == true) { EndWaitingIssue(e, ConnectionIssueOutcome.Recovered); ArchiveCurrent(e); e.Issue = null; e.IssueId = null; }
        SetStage(e, ConnectionStage.Complete);
    }
    private void FailLocked(Entry e, ConnectionIssue issue, bool inferredTransport = false)
    {
        if (!inferredTransport) e.InferredTransportIssue = false;
        if (e.Stage == ConnectionStage.Failed && e.Issue is not null)
        {
            // A socket can close before the process monitor observes the cause. Replace that symptom only
            // with a confirmed native/process failure; teardown must never replace an existing native cause.
            // `seat-build-mismatch` belongs in that set for the same reason and more strongly: the seat
            // reported it about itself and then exited, so the closed socket is its consequence.
            if (e.Issue.Code == "browser-transport-lost"
                && issue.Code is "process-exited" or "native-join-rejected" or "native-disconnected"
                    or Session.HeadlessClientManager.SeatBuildMismatchCode)
            {
                Trace(e, $"Earlier browser symptom: {e.Issue.Code}: {e.Issue.Detail ?? e.Issue.Summary}");
                e.Issue = TimedIssue(e, issue, ConnectionIssueOutcome.Failed);
                SaveIssue(e);
                Changed();
            }
            else
            {
                Trace(e, $"Additional diagnostic: {issue.Code}: {issue.Detail ?? issue.Summary}");
                SaveIssue(e);
                Changed();
            }
            return;
        }
        e.FailedStage = e.Stage;
        e.Issue = TimedIssue(e, issue, ConnectionIssueOutcome.Failed);
        SetStage(e, ConnectionStage.Failed);
        e.InferredTransportIssue = inferredTransport;
        SaveIssue(e);
        Changed();
    }
    private void SaveIssue(Entry e)
    {
        var firstReport = e.IssueId is null;
        if (firstReport) { e.IssueId = Guid.NewGuid(); _issueOrder.Enqueue(e.IssueId.Value); }
        _issues[e.IssueId!.Value] = e.CopyForIssue(_time.GetTimestamp());
        while (_issues.Count > MaximumRetainedFailures && _issueOrder.TryDequeue(out var oldest))
            if (_issues.Remove(oldest))
            {
                _overflow++;
                foreach (var client in _clients.Values.Where(client => client.IssueId == oldest))
                {
                    client.DetailsExpired = true;
                    client.Facts.Clear(); client.Logs.Clear(); client.Timeline.Clear();
                    if (client.Issue is not null) client.Issue = client.Issue with { Detail = "Older diagnostic details expired at the 128-report retention limit." };
                }
            }
        if (firstReport && e.LogSource is not null) CaptureIssueLogs(e.IssueId!.Value, e.LogSource);
        // Dismissed IDs must not leave an ever-growing queue while one old issue remains retained.
        if (_issueOrder.Count > MaximumRetainedFailures * 2)
        {
            var retained = _issueOrder.Where(_issues.ContainsKey).ToArray();
            _issueOrder.Clear();
            foreach (var id in retained) _issueOrder.Enqueue(id);
        }
    }
    private void CaptureIssueLogs(Guid issueId, ConnectionAttemptLogs source)
    {
        _ = Task.Run(async () =>
        {
            var excerpts = await source.ReadErrorsAsync().ConfigureAwait(false);
            lock (_gate)
            {
                if (!_issues.TryGetValue(issueId, out var issue)) return;
                var active = _clients.Values.FirstOrDefault(client => client.IssueId == issueId);
                foreach (var excerpt in excerpts)
                {
                    // Cleanup may already have captured a later slice from the same attempt.
                    issue.Logs.TryAdd(excerpt.Source, excerpt);
                    active?.Logs.TryAdd(excerpt.Source, excerpt);
                }
                Changed();
            }
        });
    }

    private void ArchiveCurrent(Entry e)
    {
        if (e.IssueId is Guid id && _issues.ContainsKey(id)) _issues[id] = e.CopyForIssue(_time.GetTimestamp());
    }
    private ConnectionIssue TimedIssue(Entry e, ConnectionIssue issue, ConnectionIssueOutcome outcome)
    {
        var timing = e.Issue?.Timing ?? issue.Timing ?? new ConnectionIssueTiming(e.Stage,
            Elapsed(e.StageStartedTicks), Elapsed(e.StartedTicks), _time.GetUtcNow());
        return issue with { Timing = timing, Outcome = outcome };
    }
    private static void EndWaitingIssue(Entry e, ConnectionIssueOutcome outcome)
    {
        if (e.Issue?.Outcome == ConnectionIssueOutcome.Waiting)
            e.Issue = e.Issue with { Outcome = outcome };
    }
    private ConnectionStatusRow Row(Entry e, long now)
    {
        var timing = e.Issue?.Timing;
        return new(e.Id, e.Stage,
        timing?.AttemptElapsedMs ?? Math.Max(0, (long)_time.GetElapsedTime(e.StartedTicks, e.IsLive ? now : e.EndedTicks).TotalMilliseconds), e.DisplayName,
        e.DeviceLabel, ConnectionStageSteps.Current(timing?.Stage ?? (e.Stage == ConnectionStage.Failed ? e.FailedStage : e.Stage), e.StepTotal),
        e.StepTotal, e.Issue, timing?.StageElapsedMs ?? (e.Stage == ConnectionStage.Failed || !e.IsLive ? 0 : Elapsed(e.StageStartedTicks)),
        e.IsLive, false, _overflow, e.Stage == ConnectionStage.Failed ? e.FailedStage : null,
        new(e.ClientId, e.AttemptId, e.StartedAtUtc, e.StageStartedTicks, e.IsLive,
            e.ProcessId, e.ProcessGeneration, e.Facts.GetValueOrDefault("transport"), e.IssueId));
    }
    private void Trace(Entry e, string text)
    {
        e.Timeline.Add($"{_time.GetUtcNow():O} +{Elapsed(e.StartedTicks)} ms: {text}");
        if (e.Timeline.Count > 64) e.Timeline.RemoveAt(0);
    }
    private void Changed() => _revision++;
    private static string? Clean(string? value, int cap) => string.IsNullOrWhiteSpace(value) ? null : value.Length > cap ? value[..cap] : value.Trim();

    private sealed class Entry(Guid id, Guid clientId, DateTimeOffset startedAtUtc, long startedTicks)
    {
        public Guid Id = id;
        public Guid ClientId = clientId;
        public string? DeviceLabel;
        public string? DisplayName;
        public string? AttemptId;
        public Guid? IssueId;
        public ConnectionIssue? Issue;
        public DateTimeOffset StartedAtUtc = startedAtUtc;
        public long StartedTicks = startedTicks;
        public long StageStartedTicks = startedTicks;
        public long EndedTicks = startedTicks;
        public ConnectionStage Stage = ConnectionStage.Connecting;
        public ConnectionStage FailedStage;
        public int StepTotal = 6;
        public bool IsLive, DetailsExpired;
        public int? ProcessId;
        public long? ProcessGeneration;
        public bool RequiresChild = true;
        public bool Member, ChildBrowser, FramePresented, SlowNotice;
        public bool TransportClosing, InferredTransportIssue;
        public long? ChildBrowserMissingTicks;
        public ConnectionAttemptLogs? LogSource;
        public List<string> Timeline = [];
        public Dictionary<string, string> Facts = [];
        public Dictionary<string, ConnectionLogExcerpt> Logs = [];
        public Entry CopyForIssue(long now) => new(IssueId!.Value, ClientId, StartedAtUtc, StartedTicks)
        {
            DeviceLabel = DeviceLabel, DisplayName = DisplayName, AttemptId = AttemptId, IssueId = IssueId,
            ProcessId = ProcessId, ProcessGeneration = ProcessGeneration, StageStartedTicks = StageStartedTicks, DetailsExpired = DetailsExpired,
            Issue = Issue, Stage = Stage, FailedStage = FailedStage, StepTotal = StepTotal, EndedTicks = now,
            Timeline = new(Timeline), Facts = new(Facts), Logs = new(Logs)
        };
    }
}

public enum ConnectionStage { Connecting, Choosing, Initializing, Joining, LoadingView, Complete, Failed }
public static class ConnectionStageSteps
{
    public const int Total = 6;
    public static int Current(ConnectionStage stage, int total) => stage switch
    {
        ConnectionStage.Connecting => 1, ConnectionStage.Choosing => 2, ConnectionStage.Initializing => 3,
        ConnectionStage.Joining => Math.Min(4, total - 1), ConnectionStage.LoadingView => total - 1,
        ConnectionStage.Complete => total, _ => 0
    };
}
public sealed record ConnectionIssueTiming(ConnectionStage Stage, long StageElapsedMs, long AttemptElapsedMs,
    DateTimeOffset RecordedAtUtc);
public enum ConnectionIssueOutcome { Waiting, Failed, Recovered, Ended }
public sealed record ConnectionIssue(string Code, string Summary, string Action, string? Detail, bool IsWarning = false,
    ConnectionIssueTiming? Timing = null, ConnectionIssueOutcome Outcome = ConnectionIssueOutcome.Failed);
public sealed record ConnectionStatusRow(Guid Id, ConnectionStage Stage, long ElapsedMs, string? DisplayName,
    string? DeviceLabel, int StepCount, int StepTotal, ConnectionIssue? Issue, long StageElapsedMs,
    bool IsLive = true, bool Dismissed = false, int IssueHistoryOverflow = 0, ConnectionStage? FailedStage = null, ConnectionAttemptSnapshot? Attempt = null);
public sealed record ConnectionRegistrySnapshot(long Revision, IReadOnlyList<ConnectionStatusRow> Rows, int OverflowCount = 0);

public sealed record ConnectionAttemptSnapshot(Guid ClientId, string? AttemptId, DateTimeOffset StartedAtUtc,
    long StageStartedMonotonicTimestamp, bool WebSocketAlive, int? ProcessId, long? ProcessGeneration,
    string? Transport, Guid? IssueId);
