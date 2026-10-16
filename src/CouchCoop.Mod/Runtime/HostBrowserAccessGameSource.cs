using System.Runtime.CompilerServices;
using CouchCoop.Mod.Contracts;
using Godot;
using MegaCrit.Sts2.Core.Nodes;
using MegaCrit.Sts2.Core.Nodes.Screens;
using MegaCrit.Sts2.Core.Nodes.Screens.PauseMenu;
using MegaCrit.Sts2.Core.Nodes.Screens.Settings;

namespace CouchCoop.Mod.Runtime;

/// <summary>Typed, next-frame game facts and demand-owned screen subscriptions for host authorization.</summary>
internal sealed class HostBrowserAccessGameSource
{
    private IDisposable? _screen;
    private IDisposable? _hooks;
    private IDisposable? _roster;

    internal IDisposable? Subscribe(Action wake)
    {
        if (!CouchCoopMod.EngineAvailable) return null;
        try
        {
            _hooks = HostBrowserAccessHooks.Listen(wake);
            if (_hooks is null) return null;
            _screen = GameScreenContext.SubscribeUpdated(wake);
            if (_screen is null)
            {
                _hooks.Dispose();
                _hooks = null;
                return null;
            }
            _roster = CouchCoopRosterSignals.Listen(wake);
            return new Subscription(this);
        }
        catch
        {
            Detach();
            throw;
        }
    }

    internal string ReadReason()
        => CouchCoopMod.EngineAvailable ? ReadGameReason() : HostBrowserAccessReasons.Unavailable;

    [MethodImpl(MethodImplOptions.NoInlining)]
    private string ReadGameReason()
    {
        var screen = GameScreenContext.GetCurrent();
        var game = NGame.Instance;
        if (game is null || !GodotObject.IsInstanceValid(game) || screen is not Node node
            || !GodotObject.IsInstanceValid(node) || !node.IsInsideTree() || game.Transition is null)
            return HostBrowserAccessReasons.Unavailable;

        var facts = CouchCoopGameFacts.ReadGates(screen);
        var protectedMenu = screen is NPauseMenu or NSettingsScreen;
        if (facts is { RunInProgress: true })
        {
            // The container's category covers nested screens too, even when the first menu is hidden.
            var run = game.CurrentRunNode;
            if (run is null || !GodotObject.IsInstanceValid(run) || run.GlobalUi?.SubmenuStack is not { } submenu)
                return HostBrowserAccessReasons.Unavailable;
            protectedMenu |= submenu.IsVisibleInTree()
                && submenu.Type is CapstoneSubmenuType.PauseMenu or CapstoneSubmenuType.Settings;
            // A stale run fact must never authorize a main-menu screen while returning from a run.
            if (game.MainMenu is { } mainMenu && GodotObject.IsInstanceValid(mainMenu)
                && (ReferenceEquals(node, mainMenu) || mainMenu.IsAncestorOf(node)))
                return HostBrowserAccessReasons.MultiplayerRequired;
        }

        return HostBrowserAccessMonitor.Decide(facts, true, game.Transition.InTransition || HostBrowserAccessHooks.HasPendingTransition, protectedMenu);
    }

    private void Detach()
    {
        try { Interlocked.Exchange(ref _screen, null)?.Dispose(); }
        finally
        {
            try { Interlocked.Exchange(ref _hooks, null)?.Dispose(); }
            finally { Interlocked.Exchange(ref _roster, null)?.Dispose(); }
        }
    }

    private sealed class Subscription(HostBrowserAccessGameSource owner) : IDisposable
    {
        private HostBrowserAccessGameSource? _owner = owner;
        public void Dispose() => Interlocked.Exchange(ref _owner, null)?.Detach();
    }
}
