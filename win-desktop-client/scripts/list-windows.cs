using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public class ListWindows {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  public struct RECT { public int L, T, R, B; }
  public static void Main(string[] args) {
    var pids = new HashSet<uint>();
    foreach (var p in System.Diagnostics.Process.GetProcesses()) { if (p.ProcessName.IndexOf("ScienceDiscovery") >= 0) { pids.Add((uint)p.Id); } }
    Console.WriteLine("pids=" + string.Join(",", pids));
    var dlgs = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!pids.Contains(pid)) return true;
      var cls = new StringBuilder(256); var txt = new StringBuilder(512);
      GetClassNameW(h, cls, 256); GetWindowTextW(h, txt, 512);
      RECT r; GetWindowRect(h, out r);
      dlgs.Add("pid=" + pid + " cls=" + cls.ToString() + " txt=" + txt.ToString() + " rect=" + r.L + "," + r.T + "-" + r.R + "," + r.B);
      return true;
    }, IntPtr.Zero);
    foreach (var d in dlgs) Console.WriteLine(d);
    foreach (var d in dlgs) {
      if (!d.Contains("cls=#32770")) continue;
      Console.WriteLine("--- children ---");
      // parse pid from d
      var pidStr = d.Substring(d.IndexOf("pid=") + 4).Split(' ')[0];
      var hWnd = new IntPtr(uint.Parse(pidStr)); // not real handle, dummy
      var kids = new List<string>();
      // can't easily get handle back, skip children for now
    }
  }
}
