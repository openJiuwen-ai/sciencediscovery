# bar-probe.ps1 - sample the installer InstFiles progress bar every 200ms
# Records: time / bar pos (PBM_GETPOS) / visible / size  -> one CSV line per tick.
# Also watches %TEMP% for a fresh ns*.tmp\7z-out dir (fallback-detector).
param(
  [int]$DurationSec = 600,
  [string]$OutDir = "$env:TEMP\sd-sim\barprobe"
)
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format 'HHmmss'
$csv = Join-Path $OutDir "bar-$stamp.csv"
"t,pos,vis,w,h,mq,note" | Out-File $csv -Encoding utf8

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class BarProbe {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWnd, EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr hWnd, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr hWnd, int index);
  public struct RECT { public int L, T, R, B; }
  public static string GetCls(IntPtr h) { var sb = new StringBuilder(256); GetClassNameW(h, sb, 256); return sb.ToString(); }
  public static IntPtr FindDialog(HashSet<uint> pids) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!pids.Contains(pid)) return true;
      if (!IsWindowVisible(h)) return true;
      if (GetCls(h) != "#32770") return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }
  // find the msctls_progress32 child with ctrl id 1006; fallback: any progress control
  public static IntPtr FindBar(IntPtr dlg) {
    IntPtr byId = IntPtr.Zero, any = IntPtr.Zero;
    EnumChildWindows(dlg, delegate(IntPtr c, IntPtr l) {
      if (GetCls(c) == "msctls_progress32") {
        any = c;
        if (GetDlgCtrlID(c) == 1006) byId = c;
      }
      return true;
    }, IntPtr.Zero);
    return byId != IntPtr.Zero ? byId : any;
  }
  public static int GetPos(IntPtr bar) { return (int)SendMessageW(bar, 0x0408, IntPtr.Zero, IntPtr.Zero); } // PBM_GETPOS
  public static int GetMarquee(IntPtr bar) { return (GetWindowLongW(bar, -16) & 0x8) != 0 ? 1 : 0; } // PBS_MARQUEE bit
  public static bool GetRect(IntPtr bar, out int w, out int h) {
    RECT r; w = 0; h = 0;
    if (!GetWindowRect(bar, out r)) return false;
    w = r.R - r.L; h = r.B - r.T; return true;
  }
}
"@

function SetupPids {
  $set = New-Object 'System.Collections.Generic.HashSet[uint32]'
  Get-CimInstance Win32_Process -Filter "Name LIKE 'ScienceDiscovery%setup%'" -ErrorAction SilentlyContinue | ForEach-Object { [void]$set.Add([uint32]$_.ProcessId) }
  return ,$set
}

$deadline = (Get-Date).AddSeconds($DurationSec)
$lastPos = -1; $lastVis = -1; $lastW = -1; $lastMq = -1
$seen7z = $false
while ((Get-Date) -lt $deadline) {
  $note = ""
  $pids = SetupPids
  $dlg = [BarProbe]::FindDialog($pids)
  if ($dlg -ne [IntPtr]::Zero) {
    $bar = [BarProbe]::FindBar($dlg)
    if ($bar -ne [IntPtr]::Zero) {
      $pos = [BarProbe]::GetPos($bar)
      if ([BarProbe]::IsWindowVisible($bar)) { $vis = 1 } else { $vis = 0 }
      $mq = [BarProbe]::GetMarquee($bar)
      $w = 0; $h = 0; [void][BarProbe]::GetRect($bar, [ref]$w, [ref]$h)
      if ($pos -ne $lastPos -or $vis -ne $lastVis -or $w -ne $lastW -or $mq -ne $lastMq) {
        $line = "{0},{1},{2},{3},{4},{5},{6}" -f (Get-Date -Format 'HH:mm:ss.fff'), $pos, $vis, $w, $h, $mq, $note
        $line | Out-File $csv -Append -Encoding utf8
        Write-Output $line
        $lastPos = $pos; $lastVis = $vis; $lastW = $w; $lastMq = $mq
      }
    }
  }
  # fallback detector: fresh ns*.tmp\7z-out
  if (-not $seen7z) {
    $d = Get-ChildItem "$env:TEMP" -Directory -Filter "ns*.tmp" -ErrorAction SilentlyContinue | Where-Object {
      (Test-Path "$($_.FullName)\7z-out") -and $_.LastWriteTime -gt (Get-Date).AddMinutes(-30)
    }
    if ($d) {
      $seen7z = $true
      $line = "{0},7ZOUT,0,0,0,FALLBACK: $($d.FullName)" -f (Get-Date -Format 'HH:mm:ss.fff')
      $line | Out-File $csv -Append -Encoding utf8
      Write-Output $line
    }
  }
  Start-Sleep -Milliseconds 200
}
"probe done -> $csv"
