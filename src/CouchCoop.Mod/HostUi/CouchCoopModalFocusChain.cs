namespace CouchCoop.Mod.HostUi;

/// <summary>
/// The shape of a <c>CouchCoopModalDialog</c>'s focus ring: which of the controls a dialog DECLARES take
/// part, and which two of them each one walks to.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why a ring and not a list.</b> Godot's directional focus search is viewport-wide: a control with an
/// unset neighbour hands focus to whatever the engine's geometric guess finds, which for a modal is a
/// LOBBY control behind the scrim — and the select action would then activate it straight through the
/// dialog. So every participant's up AND down must be set, which means the ends have to wrap. The
/// previous fix achieved that with one self-pinned button; this generalises it to N controls without
/// giving up the closure.
/// </para>
/// <para>
/// <b>The dismiss button is not optional.</b> It is always the last declared control and is kept even if
/// it somehow reports itself unfocusable, because a chain that ends up EMPTY is a dialog with no closed
/// ring at all — the exact failure the ring exists to prevent.
/// </para>
/// <para>
/// Pure C# with no Godot types, for the same reason as <see cref="CouchCoopButtonActivation"/> and
/// <see cref="CouchCoopModalFocusParking"/>: the mod test suite has no engine, so the rule is covered
/// here and the dialog is a thin collect-and-apply wrapper.
/// </para>
/// </remarks>
internal static class CouchCoopModalFocusChain
{
    /// <summary>The two chain positions a participant's up and down walk to.</summary>
    internal readonly record struct Link(int Previous, int Next);

    /// <summary>
    /// Which declared controls take part, in declared (top-to-bottom) order.
    /// </summary>
    /// <param name="eligibility">
    /// One flag per declared control — "this control can hold focus right now". The LAST entry is the
    /// dismiss button and is kept regardless; see the type's remarks.
    /// </param>
    /// <returns>Indices into <paramref name="eligibility"/>, in order. Never empty.</returns>
    internal static List<int> Participants(IReadOnlyList<bool> eligibility)
    {
        ArgumentNullException.ThrowIfNull(eligibility);
        if (eligibility.Count == 0)
        {
            throw new ArgumentException("a modal focus chain must declare at least the dismiss button", nameof(eligibility));
        }

        var last = eligibility.Count - 1;
        var participants = new List<int>(eligibility.Count);
        for (var index = 0; index < eligibility.Count; index++)
        {
            if (eligibility[index] || index == last)
            {
                participants.Add(index);
            }
        }

        return participants;
    }

    /// <summary>
    /// The wrap-around neighbours of chain position <paramref name="index"/>.
    /// </summary>
    /// <remarks>
    /// A chain of one is the pre-existing behaviour exactly: both neighbours are the control itself, which
    /// is the game's own idiom for a closed ring (the character-select buttons pin their top and bottom to
    /// themselves).
    /// </remarks>
    internal static Link Neighbors(int index, int count)
    {
        if (count <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(count), count, "a focus chain has at least one control");
        }

        if (index < 0 || index >= count)
        {
            throw new ArgumentOutOfRangeException(nameof(index), index, "chain position is outside the chain");
        }

        return new Link(((index - 1) + count) % count, (index + 1) % count);
    }
}
