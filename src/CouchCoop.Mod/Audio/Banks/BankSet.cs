using System.Security.Cryptography;
using System.Text;

namespace CouchCoop.Mod.Audio.Banks;

internal static class BankSet
{
    internal static int SortRank(PckBankEntry entry) =>
        entry.Path.EndsWith("Master.strings.bank", StringComparison.OrdinalIgnoreCase) ? 0 :
        entry.Path.EndsWith("Master.bank", StringComparison.OrdinalIgnoreCase) ? 1 : 2;

    internal static string Compute(IEnumerable<PckBankEntry> banks)
    {
        using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (PckBankEntry bank in banks.OrderBy(e => e.Path, StringComparer.Ordinal))
        {
            digest.AppendData(Encoding.UTF8.GetBytes(bank.Path));
            digest.AppendData([0]);
            digest.AppendData(bank.Md5);
        }
        return Convert.ToHexStringLower(digest.GetHashAndReset().AsSpan(0, 16));
    }
}
