namespace CouchCoop.MirrorProtocol.SceneModel;

using System.Collections.Generic;

// Pure state machine for a planner client's re-promotion debounce. It records repeated transient demotions in a
// sliding window and withholds only the next promotions; required demotions are never suppressed.
public sealed class RepromoteDebounce
{
    private readonly int _threshold;
    private readonly int _windowEvals;
    private readonly int _cooldownEvals;
    private int _seq;

    private sealed class Rec
    {
        public int WindowStartSeq;
        public int Count;
        public int CooldownUntilSeq;
    }

    private readonly Dictionary<string, Rec> _recs = new(System.StringComparer.Ordinal);

    public RepromoteDebounce(int threshold = 2, int windowEvals = 4, int cooldownEvals = 4)
    {
        _threshold = threshold;
        _windowEvals = windowEvals;
        _cooldownEvals = cooldownEvals;
    }

    public int Seq => _seq;
    public int TrackedCount => _recs.Count;

    public void BeginEval(IEnumerable<string> transientDemotions)
    {
        _seq++;

        foreach (var id in transientDemotions)
        {
            if (!_recs.TryGetValue(id, out var rec))
            {
                rec = new Rec { WindowStartSeq = _seq, Count = 0 };
                _recs[id] = rec;
            }

            if (_seq - rec.WindowStartSeq >= _windowEvals)
            {
                rec.WindowStartSeq = _seq;
                rec.Count = 0;
            }

            rec.Count++;
            if (rec.Count >= _threshold)
            {
                rec.CooldownUntilSeq = _seq + _cooldownEvals;
                rec.Count = 0;
                rec.WindowStartSeq = _seq;
            }
        }

        Prune();
    }

    public bool Suppressed(string id) =>
        _recs.TryGetValue(id, out var rec) && _seq < rec.CooldownUntilSeq;

    public void Reset()
    {
        _recs.Clear();
        _seq = 0;
    }

    public bool Clear(string id) => _recs.Remove(id);

    private void Prune()
    {
        if (_recs.Count == 0)
        {
            return;
        }

        List<string>? dead = null;
        foreach (var (id, rec) in _recs)
        {
            if (_seq >= rec.CooldownUntilSeq && _seq - rec.WindowStartSeq >= _windowEvals)
            {
                (dead ??= new List<string>()).Add(id);
            }
        }

        if (dead is not null)
        {
            foreach (var id in dead)
            {
                _recs.Remove(id);
            }
        }
    }
}
