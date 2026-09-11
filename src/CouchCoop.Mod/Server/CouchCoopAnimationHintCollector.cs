using System.Threading.Channels;
using CouchCoop.Mod.Runtime;
using Spirectl.Sts2.Embedding;

namespace CouchCoop.Mod.Server;

// Subscribes ONCE to spirectl's live Godot-tween timing HINT stream and buffers the hints into a
// bounded channel, so the browser server can EMBED the batch since the last state tick INSIDE the
// next `state` frame. Unlike the ordered combat-event observer (each event matters, monotonic
// sequence, per-connection queue), hints are a hot, ephemeral PRE-ARM signal: every hint is
// interchangeable, order does not matter, and a dropped hint is harmless — a transition just is not
// pre-armed and that value change eases with the renderer-wide default instead.
//
// Why embed rather than fan out like combat events: per-connection ordering between a separate
// combat-event send and a state send is NOT guaranteed (they race the send gate), and a hint must
// arrive BEFORE-OR-WITH the state whose prop change it arms. Riding inside the state frame
// guarantees that. So this type is a COLLECTOR (drain-on-demand), not an event raiser.
//
// The producer callback fires on the GAME thread and MUST NOT block; onHint therefore only does a
// bounded, non-blocking Channel.TryWrite. When the animation-hints capability is unsupported the
// collector simply never subscribes (DrainPending always returns empty → no `animHints` in frames).
public sealed class CouchCoopAnimationHintCollector(IAnimationHintSource hints, ICouchCoopCapabilityPolicy capabilities) : IDisposable
{
    // ~256 matches the producer's default subscription buffer; a state tick (~50ms) drains it long
    // before it fills in practice. FullMode = DropOldest: if a burst DOES overflow, keep the FRESHEST
    // hints (the ones most likely to still be relevant to an imminent state frame) and drop the
    // stalest — dropping a hint only forgoes one pre-arm, never corrupts anything.
    private const int Capacity = 256;

    private readonly IAnimationHintSource _hints = hints ?? throw new ArgumentNullException(nameof(hints));
    private readonly ICouchCoopCapabilityPolicy _capabilities = capabilities ?? throw new ArgumentNullException(nameof(capabilities));
    private readonly object _gate = new();
    private readonly Channel<TweenAnimationHint> _channel = Channel.CreateBounded<TweenAnimationHint>(
        new BoundedChannelOptions(Capacity)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false,
        });
    private IDisposable? _subscription;

    public void Start()
    {
        lock (_gate)
        {
            if (_subscription is not null || !_capabilities.HasCapability(CouchCoopRuntimeHost.AnimationHintsCapability))
            {
                return;
            }

            _subscription = _hints.SubscribeAnimationHints(
                new AnimationHintSubscriptionRequest(BufferCapacity: Capacity),
                OnHint);
        }
    }

    // Runs on the game thread at tween finalize — MUST NOT block. A bounded, non-blocking TryWrite
    // (DropOldest) hand-off only; a drop is harmless (that transition just isn't pre-armed).
    private void OnHint(TweenAnimationHint hint) => _channel.Writer.TryWrite(hint);

    // Drain every hint buffered since the last drain (called once per state broadcast, on the state
    // observer's single background thread). Returns an empty list when nothing is pending.
    public IReadOnlyList<TweenAnimationHint> DrainPending()
    {
        List<TweenAnimationHint>? batch = null;
        while (_channel.Reader.TryRead(out var hint))
        {
            (batch ??= []).Add(hint);
        }

        return batch is null ? Array.Empty<TweenAnimationHint>() : batch;
    }

    public void Dispose()
    {
        IDisposable? subscription;
        lock (_gate)
        {
            subscription = _subscription;
            _subscription = null;
        }

        subscription?.Dispose();
    }
}
