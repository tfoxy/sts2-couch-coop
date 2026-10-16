using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

namespace CouchCoop.Mod.Server;

/// <summary>Private persistent files. Permissions apply at creation, before any secret bytes are written.</summary>
internal sealed class DirectIpCertificateStorage
{
    private const UnixFileMode DirectoryMode = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;
    private const UnixFileMode FileModeBits = UnixFileMode.UserRead | UnixFileMode.UserWrite;
    public string Root { get; }

    public DirectIpCertificateStorage(string root)
    {
        if (!Path.IsPathFullyQualified(root)) throw new ArgumentException("Certificate storage must be an absolute path.", nameof(root));
        Root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
    }

    // Run the entire critical section on one thread: mutex ownership must not cross an await.
    public T Locked<T>(Func<T> operation, CancellationToken cancellationToken = default)
    {
        var identity = OperatingSystem.IsWindows() ? Root.ToUpperInvariant() : Root;
        var name = "CouchCoop.DirectIp." + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity)));
        using var mutex = new Mutex(false, name);
        var acquired = false;
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                // Unix named mutexes do not support WaitAny. A single bounded wait avoids polling;
                // cancellation is checked again before any disk operation after acquiring ownership.
                acquired = mutex.WaitOne(TimeSpan.FromSeconds(30));
                if (!acquired) throw new IOException("Certificate storage is busy.");
            }
            catch (AbandonedMutexException) { acquired = true; }
            cancellationToken.ThrowIfCancellationRequested();
            EnsurePrivateDirectory(Root);
            return operation();
        }
        finally { if (acquired) mutex.ReleaseMutex(); }
    }

    public bool IsEmpty()
    {
        RejectLinks(Root);
        return !Directory.EnumerateFileSystemEntries(Root).Any();
    }

    public bool Exists(string relative)
    {
        var path = Resolve(relative);
        RejectLinks(path);
        return File.Exists(path);
    }

    public byte[] Read(string relative)
    {
        var path = Resolve(relative);
        RejectLinks(path);
        VerifyPrivateFile(path);
        var info = new FileInfo(path);
        if (info.Length is <= 0 or > 131072) throw new IOException("Invalid certificate state size.");
        return File.ReadAllBytes(path);
    }

    public string Write(string relative, ReadOnlySpan<byte> bytes)
    {
        var destination = Resolve(relative);
        EnsurePrivateDirectory(Path.GetDirectoryName(destination)!);
        RejectLinks(destination);
        if (File.Exists(destination)) VerifyPrivateFile(destination);
        var temporary = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var stream = CreatePrivateFile(temporary))
            {
                stream.Write(bytes);
                stream.Flush(flushToDisk: true);
            }
            RejectLinks(destination);
            File.Move(temporary, destination, overwrite: true);
            return destination;
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    public void DeleteFiles(string relativeDirectory)
    {
        var directory = Resolve(relativeDirectory);
        RejectLinks(directory);
        if (!Directory.Exists(directory)) return;
        EnsurePrivateDirectory(directory);
        foreach (var path in Directory.EnumerateFiles(directory))
        {
            RejectLinks(path);
            VerifyPrivateFile(path);
            File.Delete(path);
        }
    }

    private string Resolve(string relative)
    {
        var path = Path.GetFullPath(Path.Combine(Root, relative));
        if (!path.StartsWith(Root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar,
                OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
            throw new IOException("Certificate path is outside private storage.");
        return path;
    }

    private static void RejectLinks(string path)
    {
        for (var cursor = path; !string.IsNullOrEmpty(cursor); cursor = Path.GetDirectoryName(cursor))
        {
            // LinkTarget also finds dangling links, which File.Exists deliberately hides.
            if (new FileInfo(cursor).LinkTarget is not null || new DirectoryInfo(cursor).LinkTarget is not null)
                throw new IOException("Certificate storage cannot contain symbolic links.");
            if ((File.Exists(cursor) || Directory.Exists(cursor)) && (File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Certificate storage cannot contain reparse points.");
        }
    }

    private static void EnsurePrivateDirectory(string path)
    {
        RejectLinks(path);
        if (!Directory.Exists(path))
        {
            var parent = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(parent) && !Directory.Exists(parent)) EnsurePrivateDirectory(parent);
            if (OperatingSystem.IsWindows())
            {
                var security = new DirectorySecurity();
                var user = WindowsIdentity.GetCurrent().User ?? throw new IOException("Current user identity unavailable.");
                security.SetOwner(user);
                security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
                security.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl,
                    InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
                FileSystemAclExtensions.Create(new DirectoryInfo(path), security);
            }
            else Directory.CreateDirectory(path, DirectoryMode);
        }
        RejectLinks(path);
        if (OperatingSystem.IsWindows()) VerifyWindowsAccess(new DirectoryInfo(path).GetAccessControl());
        else if ((File.GetUnixFileMode(path) & ~DirectoryMode) != 0)
            throw new IOException("Certificate directory must be accessible only to its owner.");
    }

    private static FileStream CreatePrivateFile(string path)
    {
        if (!OperatingSystem.IsWindows())
            return new FileStream(path, new FileStreamOptions
            {
                Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None,
                UnixCreateMode = FileModeBits,
            });
        var security = new FileSecurity();
        var user = WindowsIdentity.GetCurrent().User ?? throw new IOException("Current user identity unavailable.");
        security.SetOwner(user);
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl, AccessControlType.Allow));
        return FileSystemAclExtensions.Create(new FileInfo(path), FileMode.CreateNew, FileSystemRights.FullControl,
            FileShare.None, 4096, FileOptions.None, security);
    }

    private static void VerifyPrivateFile(string path)
    {
        if (OperatingSystem.IsWindows()) VerifyWindowsAccess(new FileInfo(path).GetAccessControl());
        else if ((File.GetUnixFileMode(path) & ~FileModeBits) != 0)
            throw new IOException("Certificate file must be accessible only to its owner.");
    }

    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static void VerifyWindowsAccess(FileSystemSecurity security)
    {
        var user = WindowsIdentity.GetCurrent().User ?? throw new IOException("Current user identity unavailable.");
        if (!user.Equals(security.GetOwner(typeof(SecurityIdentifier))) || !security.AreAccessRulesProtected)
            throw new IOException("Certificate storage must have a protected owner-only ACL.");
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            if (rule.AccessControlType == AccessControlType.Allow && !user.Equals(rule.IdentityReference))
                throw new IOException("Certificate storage grants another identity access.");
    }
}
