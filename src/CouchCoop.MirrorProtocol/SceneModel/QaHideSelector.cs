namespace CouchCoop.MirrorProtocol.SceneModel;

// One parsed QA hide-verb selector (the `hide <selector>` / `show <selector>` grammar of the native client's QA
// channel). Pure parse + wire-node match so it is unit-testable without Godot; the client-side holder
// (QaForcedHide) owns the active set and the pseudo-selectors (`stage`/`bake`) that target client nodes rather
// than wire nodes. A record struct so an identical selector text removes exactly the selector it added.
public readonly record struct QaHideSelector
{
    public enum SelectorKind
    {
        Type, // case-insensitive SUFFIX match on MirrorNode.NodeType ("type:NCreature", "type:Combat.NEnergyCounter")
        Name, // case-insensitive EXACT match on MirrorNode.Name (the host scene node name)
        Id,   // exact wire id
    }

    public SelectorKind Kind { get; }
    public string Value { get; }

    private QaHideSelector(SelectorKind kind, string value)
    {
        Kind = kind;
        Value = value;
    }

    // Parse "type:<suffix>" / "name:<host-name>" / "id:<wireId>". Anything else (including an empty value) fails.
    // `stage` / `bake` are NOT wire-node selectors and deliberately do not parse here.
    public static bool TryParse(string text, out QaHideSelector selector)
    {
        selector = default;
        int colon = text.IndexOf(':');
        if (colon <= 0 || colon == text.Length - 1)
        {
            return false;
        }

        string value = text[(colon + 1)..];
        switch (text[..colon].ToLowerInvariant())
        {
            case "type":
                selector = new QaHideSelector(SelectorKind.Type, value);
                return true;
            case "name":
                selector = new QaHideSelector(SelectorKind.Name, value);
                return true;
            case "id":
                selector = new QaHideSelector(SelectorKind.Id, value);
                return true;
            default:
                return false;
        }
    }

    public bool Matches(MirrorNode node) => Kind switch
    {
        SelectorKind.Type => node.NodeType.EndsWith(Value, System.StringComparison.OrdinalIgnoreCase),
        SelectorKind.Name => string.Equals(node.Name, Value, System.StringComparison.OrdinalIgnoreCase),
        _ => string.Equals(node.Id, Value, System.StringComparison.Ordinal),
    };

    public override string ToString() => Kind switch
    {
        SelectorKind.Type => "type:" + Value,
        SelectorKind.Name => "name:" + Value,
        _ => "id:" + Value,
    };
}
