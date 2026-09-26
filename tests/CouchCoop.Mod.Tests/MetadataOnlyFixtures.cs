namespace CouchCoop.Mod.Tests.MetadataOnlyFixtures;

// These test-owned types exercise PE metadata cases without loading any reference-SDK type.
public class DirectReady
{
    public void _Ready() { }
}

public class MissingReady { }

public class InheritedReadyBase
{
    public void _Ready() { }
}

public class InheritedReady : InheritedReadyBase { }

public class TwoArguments
{
    public void Assign(int first, string second) { }
}

// The two shapes the lobby's player cap takes on the two game lanes, and the near misses the metadata check refuses.
public class CapAsField
{
#pragma warning disable CS0169
    private readonly int _maxPlayers;
#pragma warning restore CS0169
}

public class CapAsProperty
{
    public int MaxPlayers { get; private set; }
}

public class CapAsWrongType
{
#pragma warning disable CS0169
    private readonly long _maxPlayers;
#pragma warning restore CS0169

    public long MaxPlayers { get; private set; }
}

public class CapAsStaticField
{
    public static int _maxPlayers;
}
