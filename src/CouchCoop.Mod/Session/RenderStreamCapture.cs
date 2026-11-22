using Godot;

namespace CouchCoop.Mod.Session;

/// <summary>Capture calls and signal delivery are main-thread only.</summary>
internal interface IRenderStreamCapture
{
    bool HasSingleton { get; }
    string State();
    int Clients { get; }
    int Arm(IReadOnlyDictionary<string, string> options);
    int Disarm(string reason, int lingerMs);
    IDisposable Subscribe(RenderStreamCaptureSignals signals);
    void ConnectOneShot(string signal, Action callback);
}

/// <summary>Facts from this arm's signal, never from the capture's on-disk evidence.</summary>
internal sealed record RenderStreamSnapshot(
    string Listen, string Token, string CertificateHash, string RootSize, int StreamVersion)
{
    public override string ToString() => $"RenderStreamSnapshot {{ RootSize = {RootSize}, StreamVersion = {StreamVersion} }}";
}

internal sealed record RenderStreamCaptureSignals(
    Action<RenderStreamSnapshot> Armed,
    Action Disarmed,
    Action<string> ArmFailed,
    Action<string> StreamEnded,
    Action<long> ClientConnected,
    Action<long, string> ClientLeft);

internal interface IRenderStreamTweenCapture
{
    void TweenBegin(IReadOnlyDictionary<string, object> schedule);
    void TweenCancel(long tweenId);
}

internal sealed class GodotRenderStreamCapture : IRenderStreamCapture, IRenderStreamTweenCapture
{
    private const string SingletonName = "RenderStreamCapture";

    public bool HasSingleton => CouchCoopMod.EngineAvailable && Engine.HasSingleton(SingletonName);

    public string State() => Singleton().Call("state").AsGodotDictionary()["state"].AsString();

    public int Clients => Singleton().Call("state").AsGodotDictionary()["clients"].AsInt32();

    public int Arm(IReadOnlyDictionary<string, string> options)
    {
        var values = new Godot.Collections.Dictionary();
        foreach (var (key, value) in options) values[key] = value;
        return Singleton().Call("arm", values).AsInt32();
    }

    public int Disarm(string reason, int lingerMs) => Singleton().Call(
        "disarm", new Godot.Collections.Dictionary { ["reason"] = reason, ["linger_ms"] = lingerMs }).AsInt32();

    public void TweenBegin(IReadOnlyDictionary<string, object> schedule)
        => Singleton().Call("tween_begin", ToGodotDictionary(schedule));

    public void TweenCancel(long tweenId) => Singleton().Call("tween_cancel", tweenId);

    private static Godot.Collections.Dictionary ToGodotDictionary(IReadOnlyDictionary<string, object> source)
    {
        var result = new Godot.Collections.Dictionary();
        foreach (var (key, value) in source)
            result[key] = value switch
            {
                long number => Variant.From(number),
                ulong number => Variant.From(unchecked((long)number)),
                int number => Variant.From(number),
                double number => Variant.From(number),
                string text => Variant.From(text),
                IReadOnlyList<double> components => Endpoint(components),
                IReadOnlyList<IReadOnlyDictionary<string, object>> steps => Variant.From(
                    new Godot.Collections.Array(steps.Select(step => Variant.From(ToGodotDictionary(step))))),
                _ => throw new ArgumentException($"Unsupported tween value for {key}.")
            };
        return result;
    }

    private static Variant Endpoint(IReadOnlyList<double> components) => components.Count switch
    {
        1 => Variant.From(components[0]),
        2 => Variant.From(new Vector2((float)components[0], (float)components[1])),
        4 => Variant.From(new Color((float)components[0], (float)components[1], (float)components[2], (float)components[3])),
        _ => default
    };

    public IDisposable Subscribe(RenderStreamCaptureSignals signals)
    {
        var subscription = new SignalSubscription(Singleton());
        try
        {
            subscription.Add("armed", Callable.From<Variant>(info =>
            {
                var values = info.AsGodotDictionary();
                signals.Armed(new RenderStreamSnapshot(
                    values["listen"].AsString(), values["token"].AsString(), values["wt_cert_hash"].AsString(),
                    values["root_size"].AsString(), values["stream_version"].AsInt32()));
            }));
            subscription.Add("disarmed", Callable.From<Variant>(_ => signals.Disarmed()));
            subscription.Add("arm_failed", Callable.From<string>(signals.ArmFailed));
            subscription.Add("stream_ended", Callable.From<string>(signals.StreamEnded));
            subscription.Add("client_connected", Callable.From<long, Variant>((connection, _) => signals.ClientConnected(connection)));
            subscription.Add("client_left", Callable.From<long, string>(signals.ClientLeft));
            return subscription;
        }
        catch
        {
            subscription.Dispose();
            throw;
        }
    }

    public void ConnectOneShot(string signal, Action callback)
    {
        // The disarmed signal carries one info dictionary argument.
        var result = Singleton().Connect(
            signal, Callable.From<Variant>(_ => callback()), (uint)GodotObject.ConnectFlags.OneShot);
        if (result != Error.Ok) throw new InvalidOperationException($"Cannot connect render-stream {signal}: {result}.");
    }

    private static GodotObject Singleton() => Engine.GetSingleton(SingletonName);

    private sealed class SignalSubscription(GodotObject singleton) : IDisposable
    {
        private readonly List<(string Signal, Callable Callback)> _connections = [];

        internal void Add(string signal, Callable callback)
        {
            var result = singleton.Connect(signal, callback);
            if (result != Error.Ok) throw new InvalidOperationException($"Cannot connect render-stream {signal}: {result}.");
            _connections.Add((signal, callback));
        }

        public void Dispose()
        {
            foreach (var (signal, callback) in _connections)
            {
                if (GodotObject.IsInstanceValid(singleton) && singleton.IsConnected(signal, callback))
                    singleton.Disconnect(signal, callback);
            }
            _connections.Clear();
        }
    }
}
