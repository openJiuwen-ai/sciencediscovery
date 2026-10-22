# live-monitor.ps1 - popup & process watcher for ScienceDiscovery installer tests
# Records: every visible window of installer/app processes (class #32770 = NSIS dialog
# + MessageBox, Chrome_WidgetWin_1 = Electron), full child static/button texts,
# process pid/exe path changes, MD5 hash of new setup exes, screenshots on change.
# Output: console lines + $OutDir\*.png ; all ASCII to survive PS5.1 GBK console.
param(
  [int]$DurationSec = 2400,
  [string]$OutDir = "$env:TEMP\sd-sim\live"
)
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class Win32Mon {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWnd, EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr hWnd, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr hWnd, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public static string GetText(IntPtr h) {
    var sb = new StringBuilder(2048);
    GetWindowTextW(h, sb, 2048);
    return sb.ToString();
  }
  public static string GetCls(IntPtr h) {
    var sb = new StringBuilder(256);
    GetClassNameW(h, sb, 256);
    return sb.ToString();
  }
  public static string ChildTexts(IntPtr h) {
    var list = new List<string>();
    EnumChildWindows(h, delegate(IntPtr c, IntPtr l) {
      var cls = GetCls(c);
      if (cls == "Static" || cls == "Button") {
        var t = GetText(c);
        if (!String.IsNullOrEmpty(t)) list.Add(t);
      }
      return true;
    }, IntPtr.Zero);
    return String.Join(" || ", list.ToArray());
  }
  public static List<string> Snapshot(HashSet<uint> pids) {
    var lines = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (!pids.Contains(pid)) return true;
      if (!IsWindowVisible(h)) return true;
      var cls = GetCls(h);
      if (cls != "#32770" && cls != "Chrome_WidgetWin_1" && cls != "Windows.UI.Core.CoreWindow") return true;
      var title = GetText(h);
      var children = ChildTexts(h);
      lines.Add(String.Format("hwnd=0x{0:X} pid={1} cls={2} title=[{3}] text=[{4}]", h, pid, cls, title, children));
      return true;
    }, IntPtr.Zero);
    return lines;
  }
}
"@

function Shot([string]$tag) {
  try {
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $b = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
    $g = [System.Drawing.Graphics]::FromImage($b)
    $g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $b.Size)
    $b.Save((Join-Path $OutDir ($tag + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $b.Dispose()
  } catch { Write-Output ("SHOT-ERR " + $_.Exception.Message) }
}

Write-Output ("monitor start {0} pid={1} outdir={2}" -f (Get-Date -Format 'HH:mm:ss'), $PID, $OutDir)

$knownWin = @{}     # hwnd -> last signature
$knownProc = @{}    # pid -> "name|path"
$hashed = @{}       # path -> md5 (already hashed)
$shots = 0
$maxShots = 100
$lastShotAt = [DateTime]::MinValue
$sw = [Diagnostics.Stopwatch]::StartNew()
$nextTick = (Get-Date).AddSeconds(15)

while ($sw.Elapsed.TotalSeconds -lt $DurationSec) {
  try {
    # --- target processes: installer + app ---
    $procs = Get-CimInstance Win32_Process -Filter "Name LIKE 'ScienceDiscovery%'" -ErrorAction SilentlyContinue
    $pids = New-Object 'System.Collections.Generic.HashSet[uint32]'
    foreach ($p in $procs) { [void]$pids.Add([uint32]$p.ProcessId) }

    # --- process change log + hash new setup exes ---
    foreach ($p in $procs) {
      $sig = ("{0}|{1}|{2}" -f $p.Name, $p.ProcessId, $p.ExecutablePath)
      if (-not $knownProc.ContainsKey($p.ProcessId)) {
        $knownProc[$p.ProcessId] = $sig
        $extra = ''
        if ($p.Name -match 'setup' -and $p.ExecutablePath -and -not $hashed.ContainsKey($p.ExecutablePath)) {
          try {
            $h = (Get-FileHash -LiteralPath $p.ExecutablePath -Algorithm MD5 -ErrorAction Stop).Hash
            $hashed[$p.ExecutablePath] = $h
            $extra = " md5=$h"
          } catch { $extra = " md5=FAIL" }
        }
        Write-Output ("{0} PROC+ {1} created={2}{3}" -f (Get-Date -Format 'HH:mm:ss'), $sig, $p.CreationDate, $extra)
      }
    }
    foreach ($dead in @($knownProc.Keys)) {
      if (-not $pids.Contains([uint32]$dead)) {
        Write-Output ("{0} PROC- {1}" -f (Get-Date -Format 'HH:mm:ss'), $knownProc[$dead])
        $knownProc.Remove($dead)
      }
    }

    # --- window snapshot ---
    $lines = [Win32Mon]::Snapshot($pids)
    $seen = @{}
    foreach ($ln in $lines) {
      $hwnd = ($ln -split ' ')[0]
      $seen[$hwnd] = $true
      if (-not $knownWin.ContainsKey($hwnd) -or $knownWin[$hwnd] -ne $ln) {
        $isNew = -not $knownWin.ContainsKey($hwnd)
        $knownWin[$hwnd] = $ln
        Write-Output ("{0} WIN{1} {2}" -f (Get-Date -Format 'HH:mm:ss'), $(if ($isNew) {'+'} else {'~'}), $ln)
      }
    }
    foreach ($gone in @($knownWin.Keys)) {
      if (-not $seen.ContainsKey($gone)) {
        Write-Output ("{0} WIN- {1}" -f (Get-Date -Format 'HH:mm:ss'), $knownWin[$gone])
        $knownWin.Remove($gone)
      }
    }

    # --- screenshot on new dialog windows (#32770) with debounce ---
    $hasDialog = $false
    foreach ($ln in $knownWin.Values) { if ($ln -match 'cls=#32770') { $hasDialog = $true; break } }
    if ($hasDialog -and $shots -lt $maxShots -and ((Get-Date) - $lastShotAt).TotalSeconds -ge 3) {
      $shots++
      Shot ("shot{0:D3}-{1}" -f $shots, (Get-Date -Format 'HHmmss'))
      $lastShotAt = Get-Date
      Write-Output ("{0} SHOT #{1}" -f (Get-Date -Format 'HH:mm:ss'), $shots)
    }

    # --- heartbeat ---
    if ((Get-Date) -ge $nextTick) {
      Write-Output ("{0} tick procs={1} wins={2} shots={3}" -f (Get-Date -Format 'HH:mm:ss'), $procs.Count, $knownWin.Count, $shots)
      $nextTick = (Get-Date).AddSeconds(15)
    }
  } catch {
    Write-Output ("{0} ERR {1}" -f (Get-Date -Format 'HH:mm:ss'), $_.Exception.Message)
  }
  Start-Sleep -Milliseconds 700
}
Write-Output ("monitor end {0}" -f (Get-Date -Format 'HH:mm:ss'))
