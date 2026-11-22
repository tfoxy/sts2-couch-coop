namespace CouchCoop.Mod.Session;

/// <summary>Keep capture-only node observers out of a detached windowed host.</summary>
internal sealed class RenderStreamCaptureHelpers(bool onDemand, Action install, Action remove,
    Action installTipOwner)
{
    private bool _started;
    internal bool Installed { get; private set; }

    internal void Start()
    {
        if (!_started)
        {
            // Tips created between streams still need their owner when the next capture adopts them.
            installTipOwner();
            _started = true;
        }
        if (!onDemand) SetInstalled(true);
    }

    internal void SetAttached(bool attached)
    {
        if (onDemand) SetInstalled(attached);
    }

    private void SetInstalled(bool installed)
    {
        if (Installed == installed) return;
        if (installed)
        {
            try { install(); }
            catch { remove(); throw; }
        }
        else remove();
        Installed = installed;
    }
}
