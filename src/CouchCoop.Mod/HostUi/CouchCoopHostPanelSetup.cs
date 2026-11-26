using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.HostUi;

/// <summary>The button and its layout must survive failure of any optional affordance.</summary>
internal static class CouchCoopHostPanelSetup
{
    internal static void Install(Action button, Action layout, Action hint, Action dialog, Action alert, Action hotkey)
    {
        button();
        layout();
        TryOptional("hint", hint);
        TryOptional("dialog", dialog);
        TryOptional("alert", alert);
        TryOptional("hotkey", hotkey);
    }

    internal static void TryOptional(string name, Action install)
    {
        try { install(); }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr($"qr optional setup failed name={name} detail={exception.GetType().Name}: {exception.Message}");
        }
    }
}
