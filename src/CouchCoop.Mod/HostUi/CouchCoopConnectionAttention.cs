namespace CouchCoop.Mod.HostUi;

/// <summary>Tracks newly saved problems without extending a notice on every UI refresh.</summary>
internal sealed class CouchCoopConnectionAttention(TimeProvider? timeProvider = null)
{
    private readonly TimeProvider _time = timeProvider ?? TimeProvider.System;
    private readonly HashSet<string> _seen = [];
    private long? _noticeStarted;

    public (bool ShowBadge, bool ShowNotice) Update(IEnumerable<string> issueKeys, int count, bool dialogOpen)
    {
        var current = issueKeys.ToHashSet(StringComparer.Ordinal);
        var hasNew = current.Except(_seen).Any();
        _seen.Clear();
        _seen.UnionWith(current);
        if (dialogOpen || count == 0) _noticeStarted = null;
        else if (hasNew) _noticeStarted = _time.GetTimestamp();

        var showBadge = !dialogOpen && count > 0;
        return (showBadge, showBadge && _noticeStarted is long started
            && _time.GetElapsedTime(started) < TimeSpan.FromSeconds(6));
    }
}
