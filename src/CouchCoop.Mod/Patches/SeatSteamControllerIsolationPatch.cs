using System;
using System.Reflection;
using CouchCoop.Mod.Session;
using Godot;
using HarmonyLib;
using MegaCrit.Sts2.Core.ControllerInput;

namespace CouchCoop.Mod.Patches;

/// <summary>
/// Keeps a spawned co-op SEAT from taking a controller through Steam Input, by Harmony-replacing the controller
/// strategy's connection refresh with one that finds no Steam controller.
///
/// <b>What this is protecting.</b> <see cref="Session.HeadlessJoypadInputMapIsolation"/> strips the joypad
/// bindings from a seat's InputMap, which closes the ENGINE route by which a controller plugged into the host
/// machine reaches a seat. Steam Input is a second, separate route: while Steam is running and reports a
/// connected controller, the game reads that controller through Steam and raises its controller actions without
/// consulting any InputMap binding — so the strip cannot reach it, and one physical pad drove the host and every
/// seat at once. On Windows a headless seat has no engine joypad driver at all, so Steam Input is the only route
/// there and this patch is the whole of the seat's pad isolation.
///
/// <b>Why a patch rather than launching the seat without Steam.</b> The same reason as
/// <see cref="SeatCloudSaveIsolationPatch"/>: Steam Workshop mod discovery sits behind Steam's initialisation, so a
/// seat launched without Steam would load a different mod set than the host it joins. Steam stays up; only its
/// controller route is closed.
///
/// <b>What the seat looks like afterwards.</b> As if Steam reported no controller: controller input, glyphs and
/// the controller name all come from the engine-side handling instead. That is also the path a browser gamepad
/// takes — spirectl injects the game's controller actions by name, never through Steam Input — so browser pads
/// are unaffected.
///
/// <b>When mod init lands late.</b> The game can take a Steam controller before this patch exists — mod loading
/// can wait on a Steam Workshop query, which is the ordinary case for a Workshop install — so the prefix CLEARS the
/// strategy's current Steam controller rather than only skipping the refresh. A controller taken early is dropped
/// at the next refresh, about a second later and still during the seat's load, and every action it left held is
/// released so none stays pressed in the seat. That path logs its own line, so a support log shows it happened.
///
/// <b>A target that does not resolve degrades; it does not refuse.</b> Losing this patch costs isolation — the
/// host's pad also moves the seat — not a seat's ability to join, and not the player's saves, so a miss is
/// reported through <see cref="CouchCoopPatchDiagnostics"/> with <c>costsCoop: false</c> and the seat carries on.
/// <c>SeatSteamControllerIsolationTargetsTests</c> resolves the same three names at test time, on both API lanes.
///
/// Installed from <c>CouchCoopMod.Init</c> for a headless seat only (<c>COUCHCOOP_HEADLESS_CLIENT=1</c>): the host
/// keeps Steam Input exactly as the game shipped it.
/// </summary>
internal static class SeatSteamControllerIsolationPatch
{
    /// <summary>The line a seat logs once the patch is installed.</summary>
    internal const string AppliedLogLine = "headless steam input: seat ignores Steam controllers";

    /// <summary>The line a seat logs when it had already taken a Steam controller before the patch landed.</summary>
    internal const string EarlyControllerLogLine =
        "headless steam input: dropped a Steam controller the seat took before the patch";

    /// <summary>
    /// The game type this patch targets and the three members it resolves BY NAME — the single source for
    /// <see cref="Apply"/> and for the reflection guard test, since a rename would otherwise quietly turn this
    /// patch into a logged no-op.
    /// </summary>
    internal static Type TargetType => typeof(SteamControllerInputStrategy);

    /// <inheritdoc cref="TargetType"/>
    internal const string RefreshMethodName = "UpdateControllerConnections";

    /// <inheritdoc cref="TargetType"/>
    internal const string ControllerHandleFieldName = "_currentControllerHandle";

    /// <inheritdoc cref="TargetType"/>
    internal const string InputTypeFieldName = "_currentInputType";

    private static readonly object _sync = new();
    private static bool _applied;
    private static FieldInfo? _controllerHandleField;
    private static FieldInfo? _inputTypeField;

    internal static void Apply()
    {
        lock (_sync)
        {
            if (_applied) return;
            _applied = true; // one-shot regardless of outcome — don't repeat missing-member lookups each Init

            var refresh = AccessTools.Method(TargetType, RefreshMethodName, Type.EmptyTypes);
            var handleField = AccessTools.Field(TargetType, ControllerHandleFieldName);
            var inputTypeField = AccessTools.Field(TargetType, InputTypeFieldName);

            var problem = refresh is null
                ? $"{TargetType.Name}.{RefreshMethodName}() not found"
                : refresh.ReturnType != typeof(void)
                    ? $"{TargetType.Name}.{RefreshMethodName}() returns {refresh.ReturnType.Name}, not void"
                    : DescribeUnclearable(handleField, ControllerHandleFieldName)
                        ?? DescribeUnclearable(inputTypeField, InputTypeFieldName);
            if (problem is not null)
            {
                Degrade($"{problem} — Steam Input isolation skipped.");
                return;
            }

            _controllerHandleField = handleField;
            _inputTypeField = inputTypeField;

            try
            {
                var prefix = typeof(SeatSteamControllerIsolationPatch)
                    .GetMethod(nameof(PrefixNoSteamController), BindingFlags.NonPublic | BindingFlags.Static);
                new Harmony("com.couchcoop.seat-steam-controller-isolation")
                    .Patch(refresh, prefix: new HarmonyMethod(prefix));
                CouchCoopLog.Info(AppliedLogLine);
            }
            catch (Exception ex)
            {
                Degrade($"Harmony patch of {TargetType.Name}.{RefreshMethodName} failed "
                    + $"({ex.GetType().Name}: {ex.Message}) — Steam Input isolation skipped.");
            }
        }
    }

    /// <summary>
    /// Why the prefix could not clear <paramref name="field"/>, or <see langword="null"/> when it can: it must be
    /// an instance field of a nullable type, so that writing <see langword="null"/> means "no controller" and the
    /// write can never throw on the seat's input path.
    /// </summary>
    private static string? DescribeUnclearable(FieldInfo? field, string name)
    {
        if (field is null) return $"{TargetType.Name}.{name} not found";
        if (field.IsStatic) return $"{TargetType.Name}.{name} is static";
        return Nullable.GetUnderlyingType(field.FieldType) is null
            ? $"{TargetType.Name}.{name} is {field.FieldType.Name}, not nullable"
            : null;
    }

    // The seat keeps working without this patch; only the host pad's reach into it comes back. Not a join cost.
    private static void Degrade(string detail) =>
        CouchCoopPatchDiagnostics.PatchFailed(nameof(SeatSteamControllerIsolationPatch), detail, costsCoop: false);

    // Harmony prefix on the connection refresh: clear the current Steam controller and skip the original, so none
    // is ever picked up. Reflection rather than Harmony's typed `____field` injection so this project still names
    // no Steamworks type (see the Steamworks.NET reference note in CouchCoop.Mod.csproj).
    private static bool PrefixNoSteamController(object __instance)
    {
        try
        {
            // A controller can only be present here if the seat took one before this patch landed (see the type's
            // summary); after the first pass it is always null, so the drop below runs at most once.
            var tookControllerEarly = _controllerHandleField?.GetValue(__instance) is not null;
            _controllerHandleField?.SetValue(__instance, null);
            _inputTypeField?.SetValue(__instance, null);
            if (tookControllerEarly) ReleaseActionsHeldByEarlyController();
        }
        catch (Exception ex)
        {
            // Runs on the seat's input path every refresh: report, never throw. Apply() already checked both fields
            // are nullable instance fields, so this is not expected to fire.
            CouchCoopLog.Error($"headless steam input: prefix failed ({ex.GetType().Name}: {ex.Message})");
        }

        return false;
    }

    // Steam controller input only reaches the game as changes of state, so an action the host was holding when the
    // controller is dropped would never see its release in this seat. Release each held action once, with the
    // same kind of event the game's own controller input raises.
    private static void ReleaseActionsHeldByEarlyController()
    {
        var released = ReleaseHeldActions(
            InputMap.GetActions(),
            action => Input.IsActionPressed(action),
            action => Input.ParseInputEvent(new InputEventAction { Action = action, Pressed = false }),
            action => action.Dispose());
        CouchCoopLog.Info($"{EarlyControllerLogLine}; released {released} held action(s)");
    }

    /// <summary>
    /// Releases every action <paramref name="isPressed"/> reports held and returns how many. Generic so the
    /// selection is testable without an engine, the same seam <see cref="HeadlessJoypadInputMapIsolation"/> uses.
    /// </summary>
    internal static int ReleaseHeldActions<TAction>(
        IEnumerable<TAction> actions,
        Func<TAction, bool> isPressed,
        Action<TAction> release,
        Action<TAction>? releaseName = null)
    {
        var released = 0;
        foreach (var action in actions)
        {
            try
            {
                if (!isPressed(action)) continue;
                release(action);
                released++;
            }
            finally
            {
                // InputMap hands out action names that own a native handle: release each once its calls are done,
                // as the joypad strip does, never the typed array itself.
                releaseName?.Invoke(action);
            }
        }

        return released;
    }
}
