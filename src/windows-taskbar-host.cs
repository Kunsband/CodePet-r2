using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

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
  bool hover, lightTheme = ReadLightTheme();
  // Column geometry at 100% scale (48px taskbar); keep Position() and DrawContent() in sync.
  const int IconColumn = 36, RowWidth = 52, TrailingPad = 6;
  public CodePetTaskbar(IntPtr parent) {
    taskbar = parent;
    Text = "CodePet taskbar usage";
    AccessibleName = "CodePet 남은 한도: 클릭하여 전체 한도 보기";
    FormBorderStyle = FormBorderStyle.None;
    TopLevel = false;
    ShowInTaskbar = false;
    AutoScaleMode = AutoScaleMode.None;
    Cursor = Cursors.Hand;
    MouseEnter += delegate { hover = true; needsRender = true; Position(); };
    MouseLeave += delegate { hover = false; needsRender = true; Position(); };
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
    int width = Math.Min(available, (int)((IconColumn + Math.Max(1, state.rows.Length) * RowWidth + TrailingPad) * scale));
    bool light = ReadLightTheme();
    if (light != lightTheme) { lightTheme = light; needsRender = true; }
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
  // The taskbar follows SystemUsesLightTheme (not the app theme).
  public static bool ReadLightTheme() {
    try {
      using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")) {
        object value = key == null ? null : key.GetValue("SystemUsesLightTheme");
        return value is int && (int)value != 0;
      }
    } catch { return false; }
  }
  public bool LightTheme { get { return lightTheme; } set { lightTheme = value; needsRender = true; } }
  public Bitmap RenderSurface(int width, int height) {
    Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppPArgb);
    bitmap.SetResolution(96, 96);
    using (Graphics graphics = Graphics.FromImage(bitmap)) {
      // Alpha 1 keeps the whole widget clickable while letting the taskbar's
      // own material show through, like the native tray buttons.
      graphics.Clear(Color.FromArgb(1, 0, 0, 0));
      graphics.SmoothingMode = SmoothingMode.AntiAlias;
      graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
      graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
      // ClearType needs an opaque backdrop; grayscale AA composes correctly.
      graphics.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
      DrawContent(graphics, width, height);
    }
    return bitmap;
  }
  static GraphicsPath RoundedRect(RectangleF r, float radius) {
    GraphicsPath path = new GraphicsPath();
    float d = radius * 2;
    path.AddArc(r.X, r.Y, d, d, 180, 90);
    path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
    path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
    path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
    path.CloseFigure();
    return path;
  }
  void DrawContent(Graphics graphics, int surfaceWidth, int height) {
    float s = Math.Max(1f, height / 48f);
    Color ink = lightTheme ? Color.FromArgb(255, 26, 26, 26) : Color.White;
    Color muted = lightTheme ? Color.FromArgb(160, 0, 0, 0) : Color.FromArgb(178, 255, 255, 255);
    Color warn = lightTheme ? Color.FromArgb(180, 83, 9) : Color.FromArgb(251, 191, 36);
    Color danger = lightTheme ? Color.FromArgb(220, 38, 38) : Color.FromArgb(248, 113, 113);
    if (hover) {
      RectangleF plate = new RectangleF(2 * s, 4 * s, surfaceWidth - 4 * s, height - 8 * s);
      using (GraphicsPath path = RoundedRect(plate, 4 * s))
      using (Brush brush = new SolidBrush(lightTheme ? Color.FromArgb(18, 0, 0, 0) : Color.FromArgb(22, 255, 255, 255)))
        graphics.FillPath(brush, path);
    }
    int iconSize = (int)(22 * s);
    if (picture != null) graphics.DrawImage(picture, (int)(9 * s), (height - iconSize) / 2, iconSize, iconSize);
    float x = IconColumn * s, top = (height - 34 * s) / 2;
    using (Font labelFont = new Font("Segoe UI", 7.5f * s, FontStyle.Regular, GraphicsUnit.Point))
    using (Font valueFont = new Font("Segoe UI Semibold", 10f * s, FontStyle.Regular, GraphicsUnit.Point))
    using (Brush labelBrush = new SolidBrush(muted))
    using (StringFormat format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center,
      Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap }) {
      if (state.rows.Length == 0) {
        using (Brush brush = new SolidBrush(muted)) graphics.DrawString("CodePet", labelFont, brush, new RectangleF(x, 0, RowWidth * s, height), format);
        return;
      }
      float width = RowWidth * s;
      foreach (Row row in state.rows) {
        graphics.DrawString(row.label, labelFont, labelBrush, new RectangleF(x, top, width, 14 * s), format);
        string value = row.remainingPercent.HasValue ? Math.Round(row.remainingPercent.Value) + "%" + (row.stale ? "*" : "") : "—";
        Color color = row.remainingPercent <= 10 ? danger : row.remainingPercent <= 30 ? warn : ink;
        using (Brush brush = new SolidBrush(color)) graphics.DrawString(value, valueFont, brush, new RectangleF(x, top + 13 * s, width, 21 * s), format);
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
