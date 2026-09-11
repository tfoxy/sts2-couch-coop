using System.Net;
using CouchCoop.Mod.HostUi;

// WS8 live harness. The mDNS responder can only really be judged against a real multicast stack (and, on
// Linux, against a live avahi on the same port), which no unit test can stand in for. This runs JUST the
// responder — no game, no browser server, no Godot — so it can be probed with a real resolver:
//
//   dotnet run --project tests/CouchCoop.Mod.Tests -- mdns-harness [seconds] [name]
//   dig @224.0.0.251 -p 5353 "$(hostname | tr 'A-Z' 'a-z').local" A
//
// Passing an explicit [name] that no OS responder owns (e.g. couchcoop-probe.local) is the way to prove the
// ANSWER CAME FROM US rather than from avahi/Bonjour, which will not answer for a name it does not publish.
internal static class MdnsResponderHarness
{
    public const string Verb = "mdns-harness";

    public static async Task RunAsync(string[] args)
    {
        var seconds = args.Length > 1 && int.TryParse(args[1], out var parsed) && parsed > 0 ? parsed : 60;
        var name = args.Length > 2 && !string.IsNullOrWhiteSpace(args[2])
            ? QrHostOptions.ToMdnsHostName(args[2])
            : QrHostOptions.ToMdnsHostName(Environment.MachineName);

        var fallback = LanAddressRanking.Best(LanAddressRanking.GatherFromOs(Console.WriteLine))?.Address;
        Console.WriteLine($"[harness] machine={Environment.MachineName} publish={name ?? "<none>"} fallback={fallback?.ToString() ?? "<none>"}");

        await using var responder = new MdnsResponder(name, fallback, Console.WriteLine);
        Console.WriteLine($"[harness] listening={responder.IsListening} interfaces={responder.JoinedInterfaceCount}");

        using var stop = new CancellationTokenSource();
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            // Cancel rather than exit, so DisposeAsync still gets to send the goodbye packet.
            eventArgs.Cancel = true;
            stop.Cancel();
        };

        try
        {
            await Task.Delay(TimeSpan.FromSeconds(seconds), stop.Token);
        }
        catch (OperationCanceledException)
        {
        }

        Console.WriteLine("[harness] stopping — sending goodbye (TTL 0)");
    }

    // Convenience for a caller that only wants the fallback address decision printed.
    public static IPAddress? RankedFallback() => LanAddressRanking.Best(LanAddressRanking.GatherFromOs())?.Address;
}
