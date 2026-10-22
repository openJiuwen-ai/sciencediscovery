$src = @'
using System; using System.Text; using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool EnumWindows(Delegate cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, Delegate cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  public struct RECT { public int L, T, R, B; }
}
'@
Add-Type $src
$pids = New-Object 'System.Collections.Generic.HashSet[uint32]'
Get-Process | Where-Object { $_.Name -match "ScienceDiscovery" } | ForEach-Object { [void]$pids.Add([uint32]$_.Id) }
"installer pids=" + ($pids -join ',')
$dlgs = New-Object System.Collections.Generic.List[string]
$cb = [W+CB]{ param($h,$l); if (![W]::IsWindowVisible($h)) { return $true }; uint pid=0; [W]::GetWindowThreadProcessId($h, [ref]$pid); if (!$pids.Contains(pid)) { return $true }; [StringBuilder]$cls = new StringBuilder 256; [StringBuilder]$txt = new StringBuilder 512; [W]::GetClassNameW($h, $cls, 256); [W]::GetWindowTextW($h, $txt, 512); [W+RECT]$r; [W]::GetWindowRect($h, [ref]$r); $global:dlgs.Add("pid=$pid cls="+$cls.ToString()+" txt="+$txt.ToString()+" rect="+$r.L+","+$r.T+"-"+$r.R+","+$r.B); return $true }
[W]::EnumWindows($cb, [IntPtr]::Zero)
"--- top-level windows ---"
$dlgs
