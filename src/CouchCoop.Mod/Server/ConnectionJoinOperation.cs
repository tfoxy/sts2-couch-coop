namespace CouchCoop.Mod.Server;

/// <summary>Owns the one long-running join operation associated with a browser socket.</summary>
internal sealed class ConnectionJoinOperation : IDisposable
{
    private readonly object _gate = new();
    private readonly CancellationTokenSource _lifetime = new();
    private readonly Action<Exception> _onFault;
    private Task? _active;
    private CancellationTokenSource? _activeCancellation;
    private bool _closed;

    public ConnectionJoinOperation(Action<Exception>? onFault = null)
        => _onFault = onFault ?? (exception => Console.Error.WriteLine(
            $"[couchcoop] join operation fault: {exception.GetType().Name}: {exception.Message}"));

    public bool TryStart(CancellationToken connectionToken, Func<CancellationToken, Task> work)
    {
        ArgumentNullException.ThrowIfNull(work);
        lock (_gate)
        {
            if (_closed || _active is { IsCompleted: false }) return false;
            _activeCancellation?.Dispose();
            _activeCancellation = CancellationTokenSource.CreateLinkedTokenSource(connectionToken, _lifetime.Token);
            _active = ObserveAsync(work, _activeCancellation.Token);
            return true;
        }
    }

    public async Task CancelAndWaitAsync()
    {
        Task? active;
        lock (_gate)
        {
            _closed = true;
            active = _active;
            try { _lifetime.Cancel(); }
            catch (Exception exception) { ReportFault(exception); }
        }
        if (active is not null) await active.ConfigureAwait(false);
    }

    private async Task ObserveAsync(Func<CancellationToken, Task> work, CancellationToken token)
    {
        try { await work(token).ConfigureAwait(false); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception) when (token.IsCancellationRequested) { }
        catch (Exception exception) { ReportFault(exception); }
    }

    private void ReportFault(Exception exception)
    {
        // Diagnostics must not bypass the connection's final seat/input cleanup.
        try { _onFault(exception); } catch { }
    }

    public void Dispose()
    {
        _activeCancellation?.Dispose();
        _lifetime.Dispose();
    }
}
