using System.Collections.Concurrent;
using System.Net;

namespace CouchCoop.Mod.Server.LanRtc;

// This capability retains its host-assembly identity across browser generation swaps.
public interface ILanRtcRequestStream { }

/// <summary>Published only while a tunnel owns a live module and its shared UDP sink.</summary>
public static class LanRtcAvailability
{
    public const string Protocol = "couch-tunnel/1";
    private sealed record Registration(IPEndPoint Candidate, string Fingerprint);
    private static readonly ConcurrentDictionary<int, Registration> Active = new();

    public static bool IsAvailable(string? authority)
        => Uri.TryCreate("http://" + authority, UriKind.Absolute, out var uri) && Active.ContainsKey(uri.Port);

    public static string? FingerprintFor(IPAddress address, int port)
        => Active.TryGetValue(port, out var active) && active.Candidate.Address.Equals(address)
            ? active.Fingerprint : null;

    internal static IDisposable Publish(IPEndPoint candidate, string fingerprint)
    {
        var registration = new Registration(candidate, fingerprint);
        if (!Active.TryAdd(candidate.Port, registration)) throw new InvalidOperationException("RTC port already published.");
        return new Lease(registration);
    }

    private sealed class Lease(Registration registration) : IDisposable
    {
        public void Dispose() => ((ICollection<KeyValuePair<int, Registration>>)Active)
            .Remove(new(registration.Candidate.Port, registration));
    }
}
