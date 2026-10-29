using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

class Program
{
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
    private const uint FILE_ATTRIBUTE_READONLY = 0x00000001;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFileAttributesW(string lpFileName);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool SetFileAttributesW(string lpFileName, uint dwFileAttributes);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool DeleteFileW(string lpFileName);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool RemoveDirectoryW(string lpPathName);

    static int Main(string[] args)
    {
        if (args.Length == 0)
        {
            Console.Error.WriteLine("Usage: uninstall_helper.exe <directory>");
            return 1;
        }

        string target = args[0];
        if (string.IsNullOrWhiteSpace(target))
        {
            return 0;
        }

        try
        {
            // Normalize path and add long-path prefix if needed.
            target = Path.GetFullPath(target);
            if (!target.StartsWith(@"\\?\", StringComparison.Ordinal))
            {
                target = @"\\?\" + target;
            }

            DeleteDirectory(target);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("Error: " + ex.Message);
            return ex.HResult == 0 ? 1 : ex.HResult;
        }
    }

    private static void DeleteDirectory(string path)
    {
        if (string.IsNullOrEmpty(path))
        {
            return;
        }

        // Ensure trailing separator so enumeration and removal work as expected.
        string searchPath = path.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal)
            ? path
            : path + Path.DirectorySeparatorChar;

        // Enumerate children. Use DirectoryInfo with long-path prefix.
        var dirInfo = new DirectoryInfo(path);
        if (!dirInfo.Exists)
        {
            return;
        }

        foreach (var item in dirInfo.EnumerateFileSystemInfos())
        {
            string itemPath = @"\\?\" + item.FullName;
            if (item is DirectoryInfo subDir)
            {
                DeleteDirectory(itemPath);
            }
            else
            {
                // Remove read-only attribute before deleting.
                uint attrs = GetFileAttributesW(itemPath);
                if (attrs != uint.MaxValue && (attrs & FILE_ATTRIBUTE_READONLY) != 0)
                {
                    SetFileAttributesW(itemPath, attrs & ~FILE_ATTRIBUTE_READONLY);
                }
                DeleteFileW(itemPath);
            }
        }

        // Remove read-only on the directory itself, then remove it.
        uint dirAttrs = GetFileAttributesW(path);
        if (dirAttrs != uint.MaxValue && (dirAttrs & FILE_ATTRIBUTE_READONLY) != 0)
        {
            SetFileAttributesW(path, dirAttrs & ~FILE_ATTRIBUTE_READONLY);
        }
        RemoveDirectoryW(path);
    }
}
