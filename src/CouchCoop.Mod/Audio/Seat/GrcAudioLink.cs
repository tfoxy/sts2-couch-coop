using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace CouchCoop.Mod.Audio.Seat;

/// <summary>One relay owns the capture endpoint until detach has drained its callbacks.</summary>
public sealed unsafe class GrcAudioLink : IDisposable
{
    private static readonly object Gate = new();
    private static GrcAudioLink? _owner;
    private readonly GrcAudioCueBinding _binding;
    private readonly Func<byte[], bool> _output;
    private GCHandle _handle;

    public static bool Enabled => GrcAudioCue.Enabled;

    public static GrcAudioLink Attach(Func<byte[], bool> output)
    {
        var binding = GrcAudioCue.Binding ?? throw new InvalidOperationException("GSW audio not enabled");
        return new(binding, output);
    }

    internal GrcAudioLink(GrcAudioCueBinding binding, Func<byte[], bool> output)
    {
        _binding = binding;
        _output = output;
        lock (Gate)
        {
            if (_owner is not null) throw new InvalidOperationException("Audio link already attached");
            if (binding.Attach == null || binding.LinkIn == null) throw new InvalidOperationException("Missing capture link ABI");
            _handle = GCHandle.Alloc(this);
            var table = new GrcAudioCueBinding.Link { AbiVersion = 1, Size = (uint)sizeof(GrcAudioCueBinding.Link),
                Self = (void*)GCHandle.ToIntPtr(_handle), Out = &Out };
            if (binding.Attach(&table) != 1) { _handle.Free(); throw new InvalidOperationException("Capture refused audio link"); }
            _owner = this;
        }
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static int Out(void* self, byte* bytes, nuint length)
    {
        try
        {
            if (length > 1024 * 1024) return 0;
            var link = (GrcAudioLink)GCHandle.FromIntPtr((nint)self).Target!;
            return link._output(new ReadOnlySpan<byte>(bytes, (int)length).ToArray()) ? 1 : 0;
        }
        catch { return 0; }
    }

    public bool Input(ReadOnlySpan<byte> message)
    {
        lock (Gate)
        {
            if (_owner != this) return false;
            fixed (byte* bytes = message) return _binding.LinkIn(bytes, (nuint)message.Length) == 1;
        }
    }

    public void Dispose()
    {
        lock (Gate)
        {
            if (_owner != this) return;
            _binding.Attach(null);
            _owner = null;
            _handle.Free();
        }
    }
}
