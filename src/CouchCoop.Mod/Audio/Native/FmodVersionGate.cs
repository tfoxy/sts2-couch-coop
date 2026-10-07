namespace CouchCoop.Mod.Audio.Native;

internal static class FmodVersionGate
{
    // The measured build is first. Probing only patch revisions keeps the declared ABI bounded.
    internal static uint CreateVersion(Func<uint, (int Result, nint System)> createStudio,
        Func<uint, (int Result, uint Version)> probeCore, Action<string> log, out nint studio)
    {
        (int result, studio) = createStudio(FmodApi.HeaderVersion);
        if (result == FmodApi.Ok) return FmodApi.HeaderVersion;
        if (result != FmodApi.HeaderMismatch)
        {
            log($"Mirror audio disabled: FMOD Studio create failed ({result})");
            throw new FmodException("Studio create", result);
        }
        uint resolved = 0;
        for (uint patch = 0; patch <= 99 && resolved == 0; patch++)
        {
            uint candidate = 0x00020300 | patch;
            (int coreResult, uint version) = probeCore(candidate);
            if (coreResult == FmodApi.Ok) resolved = version;
            else if (coreResult != FmodApi.HeaderMismatch) break;
        }
        if (resolved != 0)
        {
            (result, studio) = createStudio(resolved);
            if (result == FmodApi.Ok) return resolved;
        }
        log($"Mirror audio disabled: FMOD version negotiation failed ({result})");
        throw new FmodException("Studio version gate", result);
    }

    internal static uint Create(Action<string> log, out nint studio) => CreateVersion(
        version => (FmodApi.FMOD_Studio_System_Create(out nint system, version), system),
        version =>
        {
            int result = FmodApi.FMOD_System_Create(out nint core, version);
            if (result != FmodApi.Ok) return (result, 0);
            try { result = FmodApi.FMOD_System_GetVersion(core, out uint actual, out _); return (result, actual); }
            finally { FmodApi.FMOD_System_Release(core); }
        }, log, out studio);
}
