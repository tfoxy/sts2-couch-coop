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
