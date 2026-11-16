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

    internal IDisposable? Subscribe(Action<HostBrowserAccessSignal> wake)
    {
        if (!CouchCoopMod.EngineAvailable) return null;
        try
        {
            _hooks = HostBrowserAccessHooks.Listen(wake);
            if (_hooks is null) return null;
            _screen = GameScreenContext.SubscribeUpdated(() => wake(HostBrowserAccessSignal.Refresh));
            if (_screen is null)
            {
                _hooks.Dispose();
                _hooks = null;
                return null;
            }
            _roster = CouchCoopRosterSignals.Listen(() => wake(HostBrowserAccessSignal.Refresh));
            return new Subscription(this);
        }
        catch
        {
            Detach();
            throw;
        }
    }

    internal HostBrowserAccessFacts ReadFacts()
        => CouchCoopMod.EngineAvailable ? ReadGameFacts() : default;

    [MethodImpl(MethodImplOptions.NoInlining)]
    private HostBrowserAccessFacts ReadGameFacts()
    {
        var game = NGame.Instance;
        if (game is null || !GodotObject.IsInstanceValid(game)) return default;
        if (game.RootSceneContainer is { } root && GodotObject.IsInstanceValid(root))
            HostBrowserAccessHooks.CacheRoot(root);
        // A known loading boundary can temporarily have no readable screen. Authorization stays denied.
        var transitioning = HostBrowserAccessHooks.HasPendingTransition || game.Transition?.InTransition == true;
        HostBrowserAccessHooks.CacheTransition(transitioning);
        if (transitioning) return new(null, false, true, false);
        var screen = GameScreenContext.GetCurrent();
        if (game is null || !GodotObject.IsInstanceValid(game) || screen is not Node node
            || !GodotObject.IsInstanceValid(node) || !node.IsInsideTree() || game.Transition is null)
            return default;

        var facts = CouchCoopGameFacts.ReadGates(screen);
        var protectedMenu = screen is NPauseMenu or NSettingsScreen;
        var mainMenu = game.MainMenu is { } menu && GodotObject.IsInstanceValid(menu)
            && (ReferenceEquals(node, menu) || menu.IsAncestorOf(node))
            && (facts is { RunInProgress: true } || facts?.CurrentLobbyNetType is null);
        if (facts is { RunInProgress: true } && !mainMenu)
        {
            // The container's category covers nested screens too, even when the first menu is hidden.
            var run = game.CurrentRunNode;
            if (run is null || !GodotObject.IsInstanceValid(run) || run.GlobalUi?.SubmenuStack is not { } submenu)
                return default;
            protectedMenu |= submenu.IsVisibleInTree()
                && submenu.Type is CapstoneSubmenuType.PauseMenu or CapstoneSubmenuType.Settings;
        }

        return new(facts, true, game.Transition.InTransition || HostBrowserAccessHooks.HasPendingTransition, protectedMenu, mainMenu);
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
