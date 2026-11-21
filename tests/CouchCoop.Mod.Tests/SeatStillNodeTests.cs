using System.Numerics;
using CouchCoop.Mod.Server;
using Godot;

internal static class SeatStillNodeTests
{
    public static void Run()
    {
        var checks = 0;
        void Check(bool ok) { checks++; if (!ok) throw new Exception($"seat still node check {checks} failed"); }
        void Near(System.Numerics.Vector2 actual, System.Numerics.Vector2 expected)
            => Check(System.Numerics.Vector2.Distance(actual, expected) < .001f);
        foreach (var width in new[] { 1920f, 2520f, 1728f })
        {
            var parent = Matrix3x2.CreateScale(1.5f) * Matrix3x2.CreateRotation(.2f) * Matrix3x2.CreateTranslation(23, 57);
            foreach (var family in Enum.GetValues<StaticBackgroundFamily>())
            {
                var transform = CouchCoopSeatStillPlacement.LocalTransform(family, "1007,523,0.72", width, parent);
                foreach (var point in new[] { System.Numerics.Vector2.Zero, new System.Numerics.Vector2(1283, 540), new System.Numerics.Vector2(2520, 1080) })
                {
                    // The page's translate + transform-origin + scale, evaluated independently on image pixels.
                    var expected = point;
                    if (family == StaticBackgroundFamily.Combat)
                        expected = (point - new System.Numerics.Vector2(1283, 540)) * .8f
                            + new System.Numerics.Vector2(1283 + 24, 540 - 17);
                    expected += new System.Numerics.Vector2(width / 2 - 1260, 0);
                    Near(System.Numerics.Vector2.Transform(System.Numerics.Vector2.Transform(point, transform), parent), expected);
                }
            }
        }
        foreach (var frame in new string?[] { null, "invalid", "0,0,NaN", "1,2,-1" })
        {
            var transform = CouchCoopSeatStillPlacement.LocalTransform(StaticBackgroundFamily.Combat, frame, 1920, Matrix3x2.Identity);
            Near(System.Numerics.Vector2.Transform(System.Numerics.Vector2.Zero, transform), new(-300, 0));
        }

        var lifetime = new StreamStillLifetime();
        var hide = new CouchCoopStaticBackgroundTracker.StreamBackgroundHideSet();
        var states = new Dictionary<ulong, (bool Visible, Node.ProcessModeEnum ProcessMode)>
            { [1] = (true, Node.ProcessModeEnum.Inherit), [2] = (true, Node.ProcessModeEnum.Always) };
        var inserted = 0;
        var freed = 0;
        var connected = false;
        var reasons = new List<string>();
        void Apply(bool desired, ulong root, string? descriptor)
        {
            var state = descriptor is null ? null : new CouchCoopStaticBackgroundState("scene", [], null, "/bg/still", Id: descriptor);
            lifetime.Update(desired, root, state, states.ContainsKey,
                () => { inserted++; connected = true; }, reason => { freed++; connected = false; reasons.Add(reason); });
            hide.Apply(desired, lifetime.RootId, [], id => states.TryGetValue(id, out var state) ? state : null,
                (id, visible, mode) => states[id] = (visible, mode));
        }
        Apply(true, 1, "first");
        var first = lifetime.Generation;
        Check(inserted == 1 && connected && !states[1].Visible);
        Apply(true, 1, "first");
        Check(inserted == 1 && lifetime.IsCurrent(first));
        // visibility_changed queues the existing probe; that probe reasserts using this same accessor seam.
        states[1] = (true, Node.ProcessModeEnum.Disabled);
        var probes = new Queue<Action>();
        void VisibilityChanged() { if (connected) probes.Enqueue(() => Apply(true, 1, "first")); }
        VisibilityChanged();
        Check(states[1].Visible && probes.Count == 1);
        probes.Dequeue()();
        Check(!states[1].Visible && inserted == 1);
        Apply(true, 1, "replacement");
        Check(inserted == 2 && freed == 1 && !lifetime.IsCurrent(first) && !states[1].Visible);
        Check(reasons[^1] == "descriptor changed");
        Apply(true, 2, "room");
        Check(inserted == 3 && freed == 2 && states[1].Visible && !states[2].Visible);
        Check(reasons[^1] == "room changed");
        Apply(false, 2, "room");
        Check(freed == 3 && !connected && states[2] == (true, Node.ProcessModeEnum.Always));
        Check(reasons[^1] == "demand lost");
        Apply(true, 2, "room");
        var pending = lifetime.Generation;
        states.Remove(2);
        Apply(true, 2, "room");
        Check(freed == 4 && !lifetime.IsCurrent(pending) && reasons[^1] == "root freed");
        states[2] = (true, Node.ProcessModeEnum.Inherit);
        CouchCoopStaticBackgroundState Pick(string character) => new(
            $"res://scenes/screens/char_select/char_select_bg_{character}.tscn", [], null,
            $"/bg/char-select/{character}", Id: $"tracker:char-select:/bg/char-select/{character}");
        void ApplyPick(string character) => lifetime.Update(true, 2, Pick(character), states.ContainsKey,
            () => inserted++, _ => freed++);
        ApplyPick("ironclad");
        var pickGeneration = lifetime.Generation;
        var pickInserted = inserted;
        var pickFreed = freed;
        var cache = new SeatStillCache<string>(_ => { });
        var failedPick = cache.Request(Pick("ironclad").Url, _ => { })!.Value;
        cache.Complete(failedPick, null);
        ApplyPick("silent");
        var nextPick = cache.Request(Pick("silent").Url, _ => { });
        Check(nextPick is not null && !cache.IsCurrent(failedPick));
        Check(inserted == pickInserted && freed == pickFreed && lifetime.IsCurrent(pickGeneration));
        Check(lifetime.Descriptor == CouchCoopStaticBackgroundTracker.StreamHideIdentity(Pick("silent")));
        // The request lifetime follows the full published descriptor, independently of its hide identity.
        var selection = new SeatStillSelection();
        string? currentId = Pick("ironclad").Id;
        SeatStillAdmission? admission = new(Pick("ironclad").Url, currentId);
        string? shown = null;
        var requests = new List<(long Ticket, string Path)>();
        var releasedTextures = new List<string>();
        var textures = new SeatStillCache<string>(releasedTextures.Add);
        void Refresh()
        {
            if (!selection.Update(currentId, admission)) return;
            shown = null;
            textures.Retire();
            if (selection.Source is not { } path) return;
            var generation = selection.Generation;
            var ticket = textures.Request(path, texture =>
            {
                if (selection.IsCurrent(generation, currentId, admission)) shown = texture;
            });
            if (ticket is not null) requests.Add((ticket.Value, path));
        }
        Refresh();
        var oldRequest = requests[^1];
        var oldGeneration = selection.Generation;
        textures.Complete(oldRequest.Ticket, "ironclad");
        Check(shown == "ironclad" && requests.Count == 1);
        currentId = Pick("silent").Id;
        Check(!selection.IsCurrent(oldGeneration, currentId, admission));
        Refresh();
        Check(shown is null && requests.Count == 1 && selection.Source is null);
        Check(releasedTextures.SequenceEqual(["ironclad"]));
        // A source path by itself cannot authorize a replacement pick.
        admission = new(Pick("silent").Url, Pick("ironclad").Id);
        Refresh();
        Check(shown is null && requests.Count == 1);
        admission = new(Pick("silent").Url, currentId);
        Refresh();
        Check(requests.Count == 2 && requests[^1].Path == Pick("silent").Url);
        textures.Complete(requests[^1].Ticket, "silent");
        Check(shown == "silent");
        Refresh();
        Check(requests.Count == 2 && shown == "silent");
        // Identity changes invalidate even a pending fetch of the exact same source URL.
        admission = new("/bg/shared", currentId);
        Check(!selection.IsCurrent(selection.Generation, currentId, admission));
        Refresh();
        var staleRequest = requests[^1];
        oldGeneration = selection.Generation;
        currentId = Pick("regent").Id;
        Check(!selection.IsCurrent(oldGeneration, currentId, admission));
        Refresh();
        Check(shown is null && requests.Count == 3);
        admission = new("/bg/shared", currentId);
        Refresh();
        var replacementRequest = requests[^1];
        Check(requests.Count == 4 && replacementRequest.Path == staleRequest.Path);
        textures.Complete(staleRequest.Ticket, "stale silent");
        Check(shown is null && releasedTextures.Contains("stale silent"));
        textures.Complete(replacementRequest.Ticket, "regent");
        Check(shown == "regent");
        // Room retirement forgets the usable source even though the connection retains its old pair.
        selection.Retire();
        shown = null;
        textures.Retire();
        Check(selection.Source is null);
        currentId = "new-room";
        Refresh();
        Check(shown is null && requests.Count == 4);
        admission = new("/bg/room", currentId);
        Refresh();
        Check(requests.Count == 5 && requests[^1].Path == "/bg/room");
        textures.Complete(requests[^1].Ticket, "room");
        Check(shown == "room");
        admission = null;
        Refresh();
        Check(shown is null && selection.Source is null && requests.Count == 5);
        Console.WriteLine($"SeatStillNodeTests passed ({checks} checks)");
    }
}
