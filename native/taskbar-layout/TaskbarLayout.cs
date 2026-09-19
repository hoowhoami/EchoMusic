// Read-only Windows shell geometry probe. Never changes Explorer or input focus.
// UI Automation is isolated in a short-lived process so a hung shell provider
// cannot block Electron's main thread. The caller enforces a timeout.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;

class TaskbarLayout
{
    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT monitor, work; public uint flags; }
    delegate bool EnumWindowProc(IntPtr hwnd, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowProc callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumWindowProc callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rectangle);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out RECT rectangle);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);

    class Box
    {
        public int x, y, width, height;
        public Box(RECT r) { x = r.Left; y = r.Top; width = r.Right - r.Left; height = r.Bottom - r.Top; }
        public Box(Rect r) { x = (int)Math.Floor(r.X); y = (int)Math.Floor(r.Y); width = (int)Math.Ceiling(r.Width); height = (int)Math.Ceiling(r.Height); }
    }
    class Bar
    {
        public Box bounds;
        public bool reliable;
        public List<Box> occupied = new List<Box>();
        public bool playerVisible, shellAbovePlayer, foregroundFullscreen;
        public Box playerBounds;
    }
    static string ClassName(IntPtr hwnd)
    {
        var name = new StringBuilder(256);
        GetClassName(hwnd, name, name.Capacity);
        return name.ToString();
    }
    static bool Intersects(Box a, Box b)
    {
        return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    }
    static Bar ReadBar(IntPtr hwnd)
    {
        RECT rectangle;
        if (!GetWindowRect(hwnd, out rectangle)) return null;
        // Shell window borders can extend outside the taskbar's client surface.
        RECT client;
        var origin = new POINT();
        if (GetClientRect(hwnd, out client) && ClientToScreen(hwnd, ref origin) && client.Right > 0 && client.Bottom > 0) {
            rectangle = new RECT { Left = origin.X, Top = origin.Y, Right = origin.X + client.Right, Bottom = origin.Y + client.Bottom };
        }
        var bar = new Bar { bounds = new Box(rectangle) };
        // Classic Win10 tray/clock regions may not expose individual UIA nodes.
        EnumChildWindows(hwnd, delegate(IntPtr child, IntPtr ignored) {
            string name = ClassName(child);
            if (name == "TrayNotifyWnd" || name == "TrayClockWClass" || name == "ShowDesktopButton") {
                RECT r;
                if (IsWindowVisible(child) && GetWindowRect(child, out r)) bar.occupied.Add(new Box(r));
            }
            return true;
        }, IntPtr.Zero);
        try {
            var root = AutomationElement.FromHandle(hwnd);
            var interactive = new OrCondition(
                new PropertyCondition(AutomationElement.IsKeyboardFocusableProperty, true),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ListItem),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem));
            var elements = root.FindAll(TreeScope.Descendants, interactive);
            bool complete = elements.Count <= 512;
            for (int i = 0; i < elements.Count && i < 512; i++) {
                try {
                    var info = elements[i].Current;
                    Rect r = info.BoundingRectangle;
                    if (info.IsOffscreen || r.IsEmpty || r.Width <= 0 || r.Height <= 0) continue;
                    var box = new Box(r);
                    if (Intersects(bar.bounds, box)) bar.occupied.Add(box);
                } catch (ElementNotAvailableException) { complete = false; }
            }
            // A provider returning no interactive elements is not evidence of
            // an empty taskbar. The app uses the adjacent work area in that case.
            bar.reliable = complete && bar.occupied.Count > 0;
        } catch (Exception) { bar.reliable = false; }
        return bar;
    }
    [MTAThread]
    static void Main(string[] args)
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
        catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
        var bars = new List<Bar>();
        long playerValue;
        var player = args.Length == 1 && long.TryParse(args[0], out playerValue) ? new IntPtr(playerValue) : IntPtr.Zero;
        var ordered = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr ignored) { ordered.Add(hwnd); return true; }, IntPtr.Zero);
        int playerIndex = ordered.IndexOf(player);
        RECT playerRect;
        Box playerBox = player != IntPtr.Zero && GetWindowRect(player, out playerRect) ? new Box(playerRect) : null;
        var foreground = GetForegroundWindow();
        string foregroundClass = ClassName(foreground);
        RECT foregroundRect;
        var monitor = new MONITORINFO { cbSize = Marshal.SizeOf(typeof(MONITORINFO)) };
        bool fullscreen = foreground != player && !IsZoomed(foreground) && foregroundClass != "Progman" && foregroundClass != "WorkerW"
            && foregroundClass != "Shell_TrayWnd" && foregroundClass != "Shell_SecondaryTrayWnd"
            && GetWindowRect(foreground, out foregroundRect)
            && GetMonitorInfo(MonitorFromWindow(foreground, 2), ref monitor)
            && foregroundRect.Left <= monitor.monitor.Left && foregroundRect.Top <= monitor.monitor.Top
            && foregroundRect.Right >= monitor.monitor.Right && foregroundRect.Bottom >= monitor.monitor.Bottom;
        EnumWindows(delegate(IntPtr hwnd, IntPtr ignored) {
            string name = ClassName(hwnd);
            if (name == "Shell_TrayWnd" || name == "Shell_SecondaryTrayWnd") {
                var bar = ReadBar(hwnd);
                if (bar != null) {
                    bar.playerBounds = playerBox;
                    bar.playerVisible = player != IntPtr.Zero && IsWindowVisible(player);
                    int shellIndex = ordered.IndexOf(hwnd);
                    bar.shellAbovePlayer = playerIndex >= 0 && shellIndex >= 0 && shellIndex < playerIndex
                        && IsWindowVisible(hwnd) && playerBox != null && Intersects(bar.bounds, playerBox);
                    bar.foregroundFullscreen = fullscreen && Intersects(bar.bounds, new Box(monitor.monitor));
                    bars.Add(bar);
                }
            }
            return true;
        }, IntPtr.Zero);
        Console.WriteLine(new JavaScriptSerializer().Serialize(bars));
    }
}
