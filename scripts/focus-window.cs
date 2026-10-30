// dsh-notify window raiser.
//
// Compiled once by scripts\install-activation.ps1 into assets\focus.exe and run
// by assets\activate.vbs on a click. It exists because the two obvious options
// are both too slow or too weak:
//
//   * WScript.Shell.AppActivate — a few milliseconds, but it does not restore a
//     minimised window (the common case for a toast click).
//   * PowerShell + Add-Type + SetForegroundWindow — restores reliably, but
//     starts in ~2 s (process start, script parse, C# compile), which is a
//     visible pause between the click and the window.
//
// The window is found by asking the desktop, not by asking the process: for a
// minimised window System.Diagnostics' MainWindowHandle is not a reliable
// answer (it reports 0), and that is exactly the state this tool exists for.
// EnumWindows + a title match ("…— DeepSeek Harness") finds it either way.
//
// Raising has two halves, and which one runs depends on the state:
//
//   * visible window (behind, or minimised) -> SW_RESTORE + SetForegroundWindow.
//     Fast, and it is the only thing a click needs.
//   * hidden window (closed to the tray) -> never ShowWindow(SW_SHOW): the app
//     hid the window itself, a foreign show leaves Electron believing it is
//     still hidden and Chromium hides it again a moment later (that is what
//     "the click closed my window" looked like). The supported way back is the
//     app's own focusPrimaryWindow(), which the shell runs when Explorer
//     activates the already-running app — `explorer.exe "<app exe>"`. That
//     makes it visible; the foreground call follows once it is.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

static class DshNotifyFocus
{
    private const int SwRestore = 9;

    /// <summary>Window is hidden by the app (tray): raising it from outside cannot work.</summary>
    private const int HiddenWindow = 3;

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, char[] text, int count);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, int command);

    private static IntPtr titled = IntPtr.Zero;
    private static IntPtr owned = IntPtr.Zero;

    private static string TitleOf(IntPtr hWnd)
    {
        int length = GetWindowTextLength(hWnd);
        if (length <= 0)
        {
            return string.Empty;
        }
        char[] buffer = new char[length + 1];
        int copied = GetWindowText(hWnd, buffer, buffer.Length);
        return copied <= 0 ? string.Empty : new string(buffer, 0, copied);
    }

    private static bool IsDshProcess(IntPtr hWnd)
    {
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        if (pid == 0)
        {
            return false;
        }
        try
        {
            return string.Equals(Process.GetProcessById((int)pid).ProcessName, "DeepSeek Harness", StringComparison.Ordinal);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Collect candidate main windows.
    ///
    /// The app's process owns several top-level windows — the DevTools window,
    /// hidden helper windows with no title — and raising the wrong one looks
    /// exactly like "the click did nothing". So a window only counts when it is
    /// an unowned, *titled* window; the title match wins over the process match
    /// because the helper windows have no title at all.
    /// </summary>
    private static bool Collect(IntPtr hWnd, IntPtr lParam)
    {
        if (GetWindow(hWnd, 4 /* GW_OWNER */) != IntPtr.Zero)
        {
            return true; // owned popup (dialog, menu), not the main window
        }
        string title = TitleOf(hWnd);
        if (title.Length == 0)
        {
            return true; // hidden helper window: nothing to raise
        }
        if (title.Contains("DeepSeek Harness"))
        {
            titled = hWnd;
            return false;
        }
        if (owned == IntPtr.Zero && IsDshProcess(hWnd))
        {
            owned = hWnd;
        }
        return true;
    }

    /// <summary>
    /// Append one line describing what this run saw and did.
    ///
    /// The handler has no console (a click must not flash a window), so a
    /// failure is otherwise invisible: this is the only way to tell "never ran"
    /// from "ran and could not raise" after the fact.
    /// </summary>
    private static void Log(string line)
    {
        try
        {
            string dir = System.IO.Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "dsh-notify");
            System.IO.Directory.CreateDirectory(dir);
            System.IO.File.AppendAllText(
                System.IO.Path.Combine(dir, "focus.log"),
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " " + line + Environment.NewLine);
        }
        catch
        {
            // Logging must never be the reason a click fails.
        }
    }

    private static bool RaiseForeground(IntPtr window)
    {
        if (SetForegroundWindow(window))
        {
            return true;
        }
        // Windows only grants the foreground to the thread that owns it, so a
        // window raised from a background process often lands *behind*.
        // Attaching to the foreground thread's input queue lifts that limit for
        // the length of the call.
        uint ignored;
        uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
        uint targetThread = GetWindowThreadProcessId(window, out ignored);
        AttachThreadInput(foregroundThread, targetThread, true);
        bool raised = SetForegroundWindow(window);
        AttachThreadInput(foregroundThread, targetThread, false);
        return raised;
    }

    /// <summary>
    /// Ask the shell to activate the already-running app.
    ///
    /// Explorer is the only launcher that gets "activate the existing instance"
    /// semantics; a plain CreateProcess or ShellExecute from another process
    /// starts a second copy that quits without touching the first one's window.
    /// </summary>
    private static bool ActivateThroughShell(IntPtr window)
    {
        uint pid;
        GetWindowThreadProcessId(window, out pid);
        string exe = null;
        try
        {
            exe = Process.GetProcessById((int)pid).MainModule.FileName;
        }
        catch
        {
            foreach (Process process in Process.GetProcessesByName("DeepSeek Harness"))
            {
                try
                {
                    exe = process.MainModule.FileName;
                    break;
                }
                catch
                {
                }
            }
        }
        if (exe == null)
        {
            Log("activate: no exe path");
            return false;
        }
        try
        {
            ProcessStartInfo info = new ProcessStartInfo(
                System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe"),
                "\"" + exe + "\"");
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            Process.Start(info);
            Log("activate: explorer " + exe);
            return true;
        }
        catch (Exception error)
        {
            Log("activate: failed " + error.GetType().Name);
            return false;
        }
    }

    private static bool WaitVisible(IntPtr window, int milliseconds)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(milliseconds);
        while (DateTime.UtcNow < deadline)
        {
            if (IsWindowVisible(window))
            {
                return true;
            }
            // The window handle can be recreated while the app shows itself.
            EnumWindows(Collect, IntPtr.Zero);
            if (titled != IntPtr.Zero)
            {
                window = titled;
            }
            System.Threading.Thread.Sleep(50);
        }
        return IsWindowVisible(window);
    }

    private static int Main(string[] args)
    {
        EnumWindows(Collect, IntPtr.Zero);
        IntPtr found = titled != IntPtr.Zero ? titled : owned;
        if (found == IntPtr.Zero)
        {
            Log("no-window");
            return 1;
        }
        Log("found hwnd=" + found.ToInt64() +
            " visible=" + IsWindowVisible(found) +
            " iconic=" + IsIconic(found) +
            " title=" + TitleOf(found));

        if (!IsWindowVisible(found))
        {
            if (!ActivateThroughShell(found))
            {
                Log("hidden-window left alone");
                return HiddenWindow;
            }
            if (!WaitVisible(found, 2500))
            {
                Log("stayed hidden after activation");
                return HiddenWindow;
            }
            found = titled != IntPtr.Zero ? titled : found;
            Log("visible after activation");
        }

        if (IsIconic(found))
        {
            ShowWindow(found, SwRestore);
        }
        bool raised = RaiseForeground(found);
        System.Threading.Thread.Sleep(200);
        Log("raised=" + raised + " visible_after=" + IsWindowVisible(found) + " iconic_after=" + IsIconic(found));
        return raised ? 0 : 2;
    }
}
