# ScienceDiscovery uninstall helper
# Usage: uninstall_helper.ps1 <directory-to-delete>
# Deletes a directory tree, including paths that exceed MAX_PATH.
# Uses parallel deletion at each directory level to speed up large trees.

param([Parameter(Mandatory=$true)][string]$Target)

$code = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

public class LongPathRm
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFileAttributesW(string lpFileName);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool SetFileAttributesW(string lpFileName, uint dwFileAttributes);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool DeleteFileW(string lpFileName);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool RemoveDirectoryW(string lpPathName);

    private const uint FILE_ATTRIBUTE_READONLY = 0x00000001;

    // Limit parallelism so we do not overwhelm the filesystem/Defender.
    private static readonly int MaxParallelism = Math.Max(2, Environment.ProcessorCount);

    public static void Delete(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return;
        }

        string full = Path.GetFullPath(path).TrimEnd('\\');
        DeleteRecursive(full);
    }

    private static void DeleteRecursive(string path)
    {
        var dir = new DirectoryInfo(path);
        if (!dir.Exists)
        {
            return;
        }

        // Enumerate children first, then process them in parallel.
        // This keeps the parent alive until all children are removed.
        FileSystemInfo[] items;
        try
        {
            items = dir.EnumerateFileSystemInfos().ToArray();
        }
        catch
        {
            // If we cannot even enumerate, best-effort: try to remove the directory itself.
            TryRemoveDirectory(path);
            return;
        }

        if (items.Length == 0)
        {
            TryRemoveDirectory(path);
            return;
        }

        // Parallel deletion of immediate children. Each directory child will
        // recurse on its own (still parallel), so large trees are deleted
        // from many points at once without contending on the same handles.
        Parallel.ForEach(
            items,
            new ParallelOptions { MaxDegreeOfParallelism = MaxParallelism },
            item =>
            {
                if (item is DirectoryInfo childDir)
                {
                    DeleteRecursive(childDir.FullName);
                }
                else
                {
                    TryDeleteFile(item.FullName);
                }
            });

        // After all children are gone, remove this directory.
        TryRemoveDirectory(path);
    }

    private static void TryDeleteFile(string path)
    {
        string longPath = EnsureLongPath(path);
        int attempts = 0;
        while (attempts < 3)
        {
            try
            {
                uint attrs = GetFileAttributesW(longPath);
                if (attrs != 0xFFFFFFFF && (attrs & FILE_ATTRIBUTE_READONLY) != 0)
                {
                    SetFileAttributesW(longPath, attrs & ~FILE_ATTRIBUTE_READONLY);
                }
                if (DeleteFileW(longPath))
                {
                    return;
                }
            }
            catch
            {
                // Fall through to retry.
            }
            attempts++;
            System.Threading.Thread.Sleep(20);
        }
    }

    private static void TryRemoveDirectory(string path)
    {
        string longPath = EnsureLongPath(path);
        int attempts = 0;
        while (attempts < 3)
        {
            try
            {
                uint attrs = GetFileAttributesW(longPath);
                if (attrs != 0xFFFFFFFF && (attrs & FILE_ATTRIBUTE_READONLY) != 0)
                {
                    SetFileAttributesW(longPath, attrs & ~FILE_ATTRIBUTE_READONLY);
                }
                if (RemoveDirectoryW(longPath))
                {
                    return;
                }
            }
            catch
            {
                // Fall through to retry.
            }
            attempts++;
            System.Threading.Thread.Sleep(20);
        }
    }

    private static string EnsureLongPath(string path)
    {
        // NSIS/robocopy may already hand us a \\?\ path, but be safe.
        if (path.StartsWith(@"\\?\", StringComparison.Ordinal))
        {
            return path;
        }
        return @"\\?\" + Path.GetFullPath(path).TrimEnd('\\');
    }
}
'@

Add-Type -TypeDefinition $code -ErrorAction Stop
[LongPathRm]::Delete($Target)
