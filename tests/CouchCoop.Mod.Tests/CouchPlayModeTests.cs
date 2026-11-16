using System.Text.Json;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Session;

internal static class CouchPlayModeTests
{
    public static void Run()
    {
        MissingFileDefaultsToOff();
        EachModeSurvivesReload();
        CorruptFileDefaultsToOff();
        UnknownContentDefaultsToOff();
        ChangesPublishAfterPersistenceOnlyOnce();
        FailedSaveKeepsCurrentWithoutPublishing();
        InvalidModeIsRejected();
    }

    private static void MissingFileDefaultsToOff()
    {
        using var store = new TestStore();
        Assert(CouchPlayModeStore.Current == CouchPlayMode.Off, "a missing file defaults to Off");
        Assert(!File.Exists(store.Path), "reading the default does not write a file");
        Assert(CouchPlayModeStore.ResolvePath() == store.Path, "the environment override selects the file");
    }

    private static void EachModeSurvivesReload()
    {
        using var store = new TestStore();
        foreach (var mode in new[] { CouchPlayMode.Off, CouchPlayMode.SoloScreens, CouchPlayMode.EveryScreen })
        {
            Assert(CouchPlayModeStore.TrySet(mode), $"{mode} saves successfully");
            Assert(CouchPlayModeStore.Current == mode, $"{mode} becomes current");
            using var document = JsonDocument.Parse(File.ReadAllText(store.Path));
            Assert(document.RootElement.GetProperty("mode").GetString() == mode.ToString(),
                $"{mode} is stored by name");
            CouchPlayModeStore.ResetForTests();
            Assert(CouchPlayModeStore.Current == mode, $"{mode} survives a fresh load");
        }
    }

    private static void CorruptFileDefaultsToOff()
    {
        using var store = new TestStore();
        store.Seed("{ corrupt");
        Assert(CouchPlayModeStore.Current == CouchPlayMode.Off, "corrupt JSON defaults to Off");
    }

    private static void UnknownContentDefaultsToOff()
    {
        using var store = new TestStore();
        foreach (var content in new[] { "", "[]", "{}", "null", """{"mode":"FutureMode"}""",
                     """{"mode":2}""", """{"mode":null}""" })
        {
            store.Seed(content);
            Assert(CouchPlayModeStore.Current == CouchPlayMode.Off, $"unknown content defaults to Off: {content}");
        }
    }

    private static void ChangesPublishAfterPersistenceOnlyOnce()
    {
        using var store = new TestStore();
        var notifications = new List<CouchPlayMode>();
        void OnChanged(CouchPlayMode mode)
        {
            Assert(CouchPlayModeStore.Current == mode, "a listener sees the new current value");
            using var document = JsonDocument.Parse(File.ReadAllText(store.Path));
            Assert(document.RootElement.GetProperty("mode").GetString() == mode.ToString(),
                "the file is persisted and closed before notification");
            notifications.Add(mode);
        }
        CouchPlayModeStore.Changed += OnChanged;
        try
        {
            Assert(CouchPlayModeStore.TrySet(CouchPlayMode.Off), "saving the default succeeds");
            Assert(notifications.Count == 0, "saving the default is not a change");
            Assert(CouchPlayModeStore.TrySet(CouchPlayMode.SoloScreens), "a changed choice saves");
            Assert(CouchPlayModeStore.TrySet(CouchPlayMode.SoloScreens), "the same choice saves");
            Assert(notifications.SequenceEqual(new[] { CouchPlayMode.SoloScreens }),
                "a change raises Changed once, and a same-value set does not");
            Assert(CouchPlayModeStore.TrySet(CouchPlayMode.Off), "lowering the mode saves");
            Assert(notifications.SequenceEqual(new[] { CouchPlayMode.SoloScreens, CouchPlayMode.Off }),
                "lowering the mode also publishes a change");
        }
        finally { CouchPlayModeStore.Changed -= OnChanged; }
    }

    private static void FailedSaveKeepsCurrentWithoutPublishing()
    {
        using var store = new TestStore();
        Assert(CouchPlayModeStore.TrySet(CouchPlayMode.SoloScreens), "initial choice saves");
        File.Delete(store.Path);
        Directory.CreateDirectory(store.Path);
        var notifications = 0;
        void OnChanged(CouchPlayMode _) => notifications++;
        CouchPlayModeStore.Changed += OnChanged;
        try
        {
            Assert(!CouchPlayModeStore.TrySet(CouchPlayMode.EveryScreen), "an unwritable destination refuses the choice");
            Assert(CouchPlayModeStore.Current == CouchPlayMode.SoloScreens, "a failed save preserves the current mode");
            Assert(notifications == 0, "a failed save does not notify listeners");
        }
        finally { CouchPlayModeStore.Changed -= OnChanged; }
        CouchPlayModeStore.ResetForTests();
        Assert(CouchPlayModeStore.Current == CouchPlayMode.Off, "an unreadable destination defaults to Off");
    }

    private static void InvalidModeIsRejected()
    {
        using var store = new TestStore();
        Assert(!CouchPlayModeStore.TrySet((CouchPlayMode)99), "undefined enum values cannot be saved");
        Assert(CouchPlayModeStore.Current == CouchPlayMode.Off && !File.Exists(store.Path),
            "an invalid choice changes neither memory nor disk");
    }

    private sealed class TestStore : IDisposable
    {
        private readonly string? _previous = Environment.GetEnvironmentVariable(CouchPlayModeStore.PathEnvironmentVariable);
        private readonly string _root = System.IO.Path.Combine(System.IO.Path.GetTempPath(),
            "couchcoop-couch-play-" + Guid.NewGuid().ToString("N"));
        public string Path => System.IO.Path.Combine(_root, "settings", "couch-play.json");

        public TestStore()
        {
            Environment.SetEnvironmentVariable(CouchPlayModeStore.PathEnvironmentVariable, Path);
            CouchPlayModeStore.ResetForTests();
        }

        public void Seed(string content)
        {
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);
            File.WriteAllText(Path, content);
            CouchPlayModeStore.ResetForTests();
        }

        public void Dispose()
        {
            Environment.SetEnvironmentVariable(CouchPlayModeStore.PathEnvironmentVariable, _previous);
            CouchPlayModeStore.ResetForTests();
            if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
        }
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition) throw new Exception($"CouchPlayModeTests failed: {label}.");
    }
}
