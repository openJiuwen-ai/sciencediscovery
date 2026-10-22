# gui-drive.ps1 - drive the ScienceDiscovery NSIS assisted installer (GUI, no /S)
# Actions:
#   text                print current page child texts (buttons/statics/radios)
#   click <substr>      PostMessage WM_COMMAND(BN_CLICKED) for the button whose
#                       text contains <substr> (e.g. "下一步", "我接受", "安装", "完成")
#   shot <name>         full-screen capture to %TEMP%\sd-sim\gui\<name>.png
#   pid                 print installer process id + exe path
param(
  [string]$Action = "text",
  [string]$Text = "",
  [string]$ShotFile = ""
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class Win32Drv {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWnd, EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr hWnd, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr hWnd, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  public static string GetText(IntPtr h) { var sb = new StringBuilder(2048); GetWindowTextW(h, sb, 2048); return sb.ToString(); }
  public static string GetCls(IntPtr h) { var sb = new StringBuilder(256); GetClassNameW(h, sb, 256); return sb.ToString(); }
  // find the visible #32770 top-level window belonging to one of pids
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
  public static List<string> PageTexts(IntPtr h) {
    var list = new List<string>();
    EnumChildWindows(h, delegate(IntPtr c, IntPtr l) {
      var cls = GetCls(c);
      if (cls == "Static" || cls == "Button" || cls == "Edit" || cls == "SysLink") {
        var t = GetText(c);
        if (!String.IsNullOrEmpty(t)) list.Add(cls + ": " + t);
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static IntPtr FindButton(IntPtr h, string sub) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(h, delegate(IntPtr c, IntPtr l) {
      if (found != IntPtr.Zero) return false;
      if (GetCls(c) != "Button") return true;
      var t = GetText(c);
      if (!String.IsNullOrEmpty(t) && t.Contains(sub)) { found = c; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static IntPtr FindEdit(IntPtr h) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(h, delegate(IntPtr c, IntPtr l) {
      if (found != IntPtr.Zero) return false;
      if (GetCls(c) == "Edit" && IsWindowVisible(c)) { found = c; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static bool Click(IntPtr parent, IntPtr btn) {
    int id = GetDlgCtrlID(btn);
    if (id == 0) return false;
    // WM_COMMAND: wParam = MAKEWPARAM(ctrlID, BN_CLICKED=0)
    return PostMessageW(parent, 0x0111, (IntPtr)id, btn);
  }
  public static IntPtr SetEditText(IntPtr edit, string text) {
    IntPtr p = Marshal.StringToHGlobalUni(text);
    IntPtr r = SendMessageW(edit, 0x000C /*WM_SETTEXT*/, IntPtr.Zero, p);
    Marshal.FreeHGlobal(p);
    return r;
  }
}
"@

function InstallerPids {
  $set = New-Object 'System.Collections.Generic.HashSet[uint32]'
  Get-CimInstance Win32_Process -Filter "Name LIKE 'ScienceDiscovery%setup%'" -ErrorAction SilentlyContinue | ForEach-Object { [void]$set.Add([uint32]$_.ProcessId) }
  return ,$set
}

switch ($Action) {
  'pid' {
    $procs = Get-CimInstance Win32_Process -Filter "Name LIKE 'ScienceDiscovery%setup%'" -ErrorAction SilentlyContinue
    if (-not $procs) { "no installer process"; exit 1 }
    foreach ($p in $procs) { "{0} {1} created={2}" -f $p.ProcessId, $p.ExecutablePath, $p.CreationDate }
  }
  'text' {
    $pids = InstallerPids
    $h = [Win32Drv]::FindDialog($pids)
    if ($h -eq [IntPtr]::Zero) { "no dialog window"; exit 1 }
    "hwnd=0x{0:X}" -f $h
    [Win32Drv]::PageTexts($h) | ForEach-Object { $_ }
  }
  'click' {
    if (-not $Text) { "click: missing -Text"; exit 1 }
    $pids = InstallerPids
    $h = [Win32Drv]::FindDialog($pids)
    if ($h -eq [IntPtr]::Zero) { "no dialog window"; exit 1 }
    $btn = [Win32Drv]::FindButton($h, $Text)
    if ($btn -eq [IntPtr]::Zero) { "button not found: $Text"; "page texts:"; [Win32Drv]::PageTexts($h) | ForEach-Object { "  $_" }; exit 1 }
    $ok = [Win32Drv]::Click($h, $btn)
    "clicked [$Text] btn=0x{0:X} posted={1}" -f $btn, $ok
  }
  'shot' {
    if (-not $ShotFile) { "shot: missing -ShotFile"; exit 1 }
    $dir = "$env:TEMP\sd-sim\gui"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $b = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
    $g = [System.Drawing.Graphics]::FromImage($b)
    $g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $b.Size)
    $b.Save((Join-Path $dir ($ShotFile + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $b.Dispose()
    "saved $dir\$ShotFile.png"
  }
  'setdir' {
    if (-not $Text) { "setdir: missing -Text (target dir)"; exit 1 }
    $pids = InstallerPids
    $h = [Win32Drv]::FindDialog($pids)
    if ($h -eq [IntPtr]::Zero) { "no dialog window"; exit 1 }
    $edit = [Win32Drv]::FindEdit($h)
    if ($edit -eq [IntPtr]::Zero) { "no edit control on current page"; exit 1 }
    $r = [Win32Drv]::SetEditText($edit, $Text)
    Start-Sleep -Milliseconds 300
    $after = [Win32Drv]::GetText($edit)
    "set edit=0x{0:X} result={1} now='{2}'" -f $edit, $r, $after
  }
  default { "unknown action: $Action"; exit 1 }
}
