using MegaCrit.Sts2.Core.Multiplayer.Transport;
using MegaCrit.Sts2.Core.Multiplayer.Transport.ENet;

namespace CouchCoop.Mod.Session;

/// <summary>
/// An ENet listener for resuming a Steam-created run while Steam is unavailable. The wire transport remains ENet,
/// but the host reports the id stored in the run so the load lobby recognizes its existing host seat.
/// </summary>
internal sealed class SavedRunEnetHost : ENetHost
{
    private readonly ulong _netId;

    internal SavedRunEnetHost(INetHostHandler handler, ulong netId)
        : base(handler)
    {
        if (netId <= 1)
        {
            throw new ArgumentOutOfRangeException(nameof(netId), "A preserved saved-run host id must differ from ENet's native id 1.");
        }

        _netId = netId;
    }

    public override ulong NetId => _netId;
}
