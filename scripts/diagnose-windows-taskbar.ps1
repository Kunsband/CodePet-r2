# Read-only diagnostics for CodePet's native taskbar host. No input, activation,
# window movement, screenshots, or settings changes are performed.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class CodePetTaskbarDiagnostics {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindow(string name, string title);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int size);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  public static object Inspect() {
    IntPtr taskbar = FindWindow("Shell_TrayWnd", null);
    Rect bounds; GetWindowRect(taskbar, out bounds);
    List<object> results = new List<object>();
    HashSet<IntPtr> seen = new HashSet<IntPtr>();
    EnumProc inspect = delegate(IntPtr hwnd, IntPtr data) {
      StringBuilder title = new StringBuilder(128); GetWindowText(hwnd, title, title.Capacity);
      if (title.ToString() != "CodePet taskbar usage" || !seen.Add(hwnd)) return true;
      Rect rect; GetWindowRect(hwnd, out rect); uint pid; GetWindowThreadProcessId(hwnd, out pid);
      results.Add(new { hwnd=hwnd.ToInt64(), processId=pid, parent=GetParent(hwnd).ToInt64(),
        visible=IsWindowVisible(hwnd), child=(GetWindowLong(hwnd,-16)&0x40000000)!=0, rect=rect,
        style=GetWindowLong(hwnd,-16).ToString("X8"), extendedStyle=GetWindowLong(hwnd,-20).ToString("X8") });
      return true;
    };
    EnumChildWindows(taskbar, inspect, IntPtr.Zero); EnumWindows(inspect, IntPtr.Zero);
    return new { taskbar=taskbar.ToInt64(), taskbarBounds=bounds, widgets=results };
  }
}
'@
[CodePetTaskbarDiagnostics]::Inspect() | ConvertTo-Json -Depth 5 -Compress
