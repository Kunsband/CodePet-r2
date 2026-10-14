using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// A child of Explorer's taskbar, never a floating/topmost desktop window.
// Layered rendering adapted from RHPLUSSEUNG/codex-usage-monitor and
// upstream-ray/codex-usage-monitor. See THIRD_PARTY_NOTICES.md.
public sealed class CodePetTaskbar : Form {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr hwnd, IntPtr parent);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] static extern int SetWindowLong(IntPtr hwnd, int index, int value);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr value);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr value);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("user32.dll", SetLastError = true)] static extern bool UpdateLayeredWindow(
    IntPtr hwnd, IntPtr destinationDc, IntPtr destination, ref NativeSize size,
    IntPtr sourceDc, ref NativePoint source, uint colorKey, ref BlendFunction blend, uint flags);
  [StructLayout(LayoutKind.Sequential)] struct NativeSize { public int Width, Height; }
  [StructLayout(LayoutKind.Sequential)] struct NativePoint { public int X, Y; }
  [StructLayout(LayoutKind.Sequential, Pack = 1)] struct BlendFunction { public byte Operation, Flags, Alpha, Format; }
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  public class Row { public string label; public double? remainingPercent; public bool stale; }
  public class State { public bool visible = true; public int offset; public string icon; public Row[] rows = new Row[0]; }
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  readonly IntPtr taskbar;
  State state = new State();
  Image picture;
  readonly ToolTip tooltip = new ToolTip();
  string reportedState;
  bool needsRender = true;
  public bool Rendered { get; private set; }
  public int RenderError { get; private set; }
  int renderedWidth, renderedHeight;
  public CodePetTaskbar(IntPtr parent) {
    taskbar = parent;
    Text = "CodePet taskbar usage";
    AccessibleName = "CodePet 남은 한도: 클릭하여 전체 한도 보기";
    FormBorderStyle = FormBorderStyle.None;
    TopLevel = false;
    ShowInTaskbar = false;
    AutoScaleMode = AutoScaleMode.None;
    Cursor = Cursors.Hand;
    BackColor = Color.FromArgb(32, 32, 32);
    MouseUp += delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Left) Emit("click"); };
  }
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get {
      CreateParams cp = base.CreateParams;
      cp.Parent = taskbar;
      cp.Style = 0x40000000 | 0x04000000; // WS_CHILD | WS_CLIPSIBLINGS
      cp.ExStyle = 0x08000000 | 0x00000080 | 0x00080000; // NOACTIVATE | TOOLWINDOW | LAYERED
      return cp;
    }
  }
  void Emit(string type) {
    Rect r; GetWindowRect(Handle, out r);
    Console.WriteLine(Json.Serialize(new { type = type, attached = GetParent(Handle) == taskbar,
      visible = IsWindowVisible(Handle), child = (GetWindowLong(Handle, -16) & 0x40000000) != 0,
      rendered = Rendered, renderError = RenderError,
      hwnd = Handle.ToInt64(), parent = taskbar.ToInt64(), x = r.Left, y = r.Top,
      width = r.Right - r.Left, height = r.Bottom - r.Top }));
    Console.Out.Flush();
  }
  public void UpdateState(State next) {
    state = next;
    if (!String.IsNullOrEmpty(next.icon)) {
      try {
        using (MemoryStream stream = new MemoryStream(Convert.FromBase64String(next.icon))) {
          using (Image source = Image.FromStream(stream)) { if (picture != null) picture.Dispose(); picture = new Bitmap(source); }
        }
      } catch { }
    }
    string hint = "CodePet · 남은 한도 · 클릭하여 전체 보기";
    foreach (Row row in state.rows) hint += "\n" + row.label + ": " + (row.remainingPercent.HasValue ? Math.Round(row.remainingPercent.Value) + "% 남음" : "조회 불가") + (row.stale ? " (이전 조회값)" : "");
    tooltip.SetToolTip(this, hint);
    AccessibleName = hint;
    needsRender = true;
    Position();
  }
  public void Position() {
    if (!IsWindow(taskbar) || !IsHandleCreated || GetParent(Handle) != taskbar) { Hide(); return; }
    Rect tr, client; GetWindowRect(taskbar, out tr); GetClientRect(taskbar, out client);
    int height = client.Bottom, available = client.Right;
    // Horizontal taskbars only: no detached fallback on unsupported layouts.
    if (height > available || height < 1) { Hide(); return; }
    IntPtr notify = FindWindowEx(taskbar, IntPtr.Zero, "TrayNotifyWnd", null);
    Rect nr;
    if (notify != IntPtr.Zero && GetWindowRect(notify, out nr)) available = Math.Max(0, nr.Left - tr.Left);
    float scale = Math.Max(1f, height / 48f);
    int width = Math.Min(available, (int)((32 + Math.Max(1, state.rows.Length) * 65) * scale));
    int offset = Math.Max(0, Math.Min(state.offset, Math.Max(0, available - width)));
    bool show = state.visible && width > 0;
    // Keep the native child above taskbar siblings, without activating any app.
    SetWindowPos(Handle, IntPtr.Zero, available - width - offset, 0, width, height,
      0x0010u | (show ? 0x0040u : 0x0080u)); // NOACTIVATE + SHOWWINDOW/HIDEWINDOW
    if (show && (needsRender || width != renderedWidth || height != renderedHeight)) {
      Rendered = Present(width, height);
      needsRender = !Rendered;
      renderedWidth = width; renderedHeight = height;
    }
    string currentState = show + ":" + available + ":" + width + ":" + height + ":" + Rendered + ":" + RenderError;
    if (reportedState != currentState) { reportedState = currentState; Emit("attached"); }
  }
  // WM_PAINT alone does not publish a surface to Explorer's composed taskbar.
  // Supply a premultiplied-alpha bitmap through UpdateLayeredWindow instead.
  bool Present(int width, int height) {
    using (Bitmap bitmap = RenderSurface(width, height)) {
      IntPtr screenDc = GetDC(IntPtr.Zero);
      IntPtr memoryDc = CreateCompatibleDC(screenDc);
      IntPtr nativeBitmap = bitmap.GetHbitmap(Color.FromArgb(0));
      IntPtr previous = SelectObject(memoryDc, nativeBitmap);
      try {
        NativeSize size = new NativeSize { Width = width, Height = height };
        NativePoint source = new NativePoint();
        BlendFunction blend = new BlendFunction { Alpha = 255, Format = 1 };
        bool ok = UpdateLayeredWindow(Handle, screenDc, IntPtr.Zero, ref size, memoryDc, ref source, 0, ref blend, 2);
        RenderError = ok ? 0 : Marshal.GetLastWin32Error();
        return ok;
      } finally {
        SelectObject(memoryDc, previous); DeleteObject(nativeBitmap);
        DeleteDC(memoryDc); ReleaseDC(IntPtr.Zero, screenDc);
      }
    }
  }
  public Bitmap RenderSurface(int width, int height) {
    Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppPArgb);
    bitmap.SetResolution(96, 96);
    using (Graphics graphics = Graphics.FromImage(bitmap)) {
      graphics.Clear(BackColor);
      graphics.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
      DrawContent(graphics, height);
    }
    return bitmap;
  }
  void DrawContent(Graphics graphics, int height) {
    float s = Math.Max(1f, height / 48f);
    int x = (int)(32 * s), iconSize = (int)(24 * s);
    if (picture != null) graphics.DrawImage(picture, (int)(4 * s), (height - iconSize) / 2, iconSize, iconSize);
    using (Font labelFont = new Font("Segoe UI", 8 * s, FontStyle.Regular, GraphicsUnit.Point))
    using (Font valueFont = new Font("Segoe UI", 10 * s, FontStyle.Bold, GraphicsUnit.Point))
    using (StringFormat format = new StringFormat { Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap }) {
      if (state.rows.Length == 0) graphics.DrawString("CodePet", labelFont, Brushes.Gainsboro, x, height / 2 - 8);
      foreach (Row row in state.rows) {
        int width = (int)(65 * s);
        graphics.DrawString(row.label, labelFont, Brushes.Gainsboro, new Rectangle(x, (int)(3 * s), width, (int)(18 * s)), format);
        string value = row.remainingPercent.HasValue ? Math.Round(row.remainingPercent.Value) + "%" + (row.stale ? "*" : "") : "—";
        Color color = row.remainingPercent <= 10 ? Color.Salmon : row.remainingPercent <= 30 ? Color.Khaki : Color.White;
        using (Brush brush = new SolidBrush(color)) graphics.DrawString(value, valueFont, brush, new Rectangle(x, (int)(20 * s), width, (int)(23 * s)), format);
        x += width;
      }
    }
  }
  protected override void OnPaintBackground(PaintEventArgs e) { }
  protected override void OnPaint(PaintEventArgs e) { }
  protected override void Dispose(bool disposing) {
    if (disposing) { tooltip.Dispose(); if (picture != null) picture.Dispose(); }
    base.Dispose(disposing);
  }
  [STAThread] public static void Run() {
    SetProcessDPIAware();
    Application.EnableVisualStyles();
    State pending = new State();
    bool ended = false;
    object gate = new object();
    Thread reader = new Thread(delegate() {
      try { string line; while ((line = Console.ReadLine()) != null) {
        State next = Json.Deserialize<State>(line);
        if (next != null && next.rows != null && next.rows.Length <= 4) lock (gate) { pending = next; }
      } } catch { } finally { lock (gate) { ended = true; } }
    });
    reader.IsBackground = true; reader.Start();
    CodePetTaskbar widget = null;
    State applied = null;
    using (System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer()) {
      timer.Interval = 500;
      timer.Tick += delegate {
        State next; bool exit; lock (gate) { next = pending; exit = ended; }
        if (exit) { if (widget != null) widget.Dispose(); Application.ExitThread(); return; }
        IntPtr parent = FindWindow("Shell_TrayWnd", null);
        if (parent == IntPtr.Zero) { if (widget != null) { widget.Dispose(); widget = null; } return; }
        if (widget == null || widget.IsDisposed || !IsWindow(widget.Handle) || widget.taskbar != parent) {
          if (widget != null) widget.Dispose();
          widget = new CodePetTaskbar(parent); IntPtr handle = widget.Handle;
          SetWindowLong(handle, -16, 0x40000000 | 0x04000000);
          SetParent(handle, parent); applied = null;
        }
        if (!Object.ReferenceEquals(applied, next)) { widget.UpdateState(next); applied = next; }
        else widget.Position();
      };
      timer.Start(); Application.Run();
      if (widget != null) widget.Dispose();
    }
  }
}
