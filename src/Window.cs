// The desktop window: a WebView2 (the Edge engine every Windows 10/11 has) showing the page the
// in-process server serves on the loopback interface.
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace TextureEditor
{
    static class Window
    {
        static Form form;
        public static bool Active => form != null;

        public static void Run(string url, Settings settings)
        {
            Application.EnableVisualStyles();
            Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
            Application.SetCompatibleTextRenderingDefault(false);
            var f = new Form { Text = "DSR Texture Editor", StartPosition = FormStartPosition.CenterScreen };
            try { f.Icon = System.Drawing.Icon.ExtractAssociatedIcon(Environment.ProcessPath); } catch { }
            // The page is laid out to fit the window without scrolling down to about 1100 x 760 CSS pixels,
            // so the window cannot shrink below that (in device pixels at the monitor's scale).
            static System.Drawing.Size Css(int w, int h, int dpi) => new((int)Math.Round(w * dpi / 96.0), (int)Math.Round(h * dpi / 96.0));
            f.HandleCreated += (_, _) =>
            {
                int dpi = f.DeviceDpi;
                f.MinimumSize = Css(1100, 760, dpi);
                if (settings.Window == null)
                {
                    var area = Screen.FromControl(f).WorkingArea;
                    var want = Css(1500, 900, dpi);
                    f.StartPosition = FormStartPosition.Manual;
                    f.Size = new System.Drawing.Size(Math.Min(want.Width, area.Width), Math.Min(want.Height, area.Height));
                    f.Location = new System.Drawing.Point(area.Left + (area.Width - f.Width) / 2, area.Top + (area.Height - f.Height) / 2);
                }
            };
            f.DpiChanged += (_, e) => f.MinimumSize = Css(1100, 760, e.DeviceDpiNew);
            RestoreBounds(f, settings);
            var view = new WebView2 { Dock = DockStyle.Fill };
            f.Controls.Add(view);
            f.Shown += async (_, _) =>
            {
                try
                {
                    // The browser's profile (cache, local storage) in the user's profile, not beside the exe.
                    var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DSR Texture Editor", "WebView2"));
                    await view.EnsureCoreWebView2Async(env);
                    var core = view.CoreWebView2;
                    core.Settings.IsStatusBarEnabled = false;
                    core.Settings.AreDefaultContextMenusEnabled = true;    // keeps Inspect and Reload
                    core.NewWindowRequested += (_, e) => { e.Handled = true; try { Process.Start(new ProcessStartInfo(e.Uri) { UseShellExecute = true }); } catch { } };
                    view.Source = new Uri(url);
                }
                catch (WebView2RuntimeNotFoundException)
                {
                    const string link = "https://developer.microsoft.com/microsoft-edge/webview2/";
                    if (MessageBox.Show(f, "DSR Texture Editor needs the Microsoft Edge WebView2 Runtime, which this Windows does not have.\n\nOpen its download page?", "WebView2 Runtime missing", MessageBoxButtons.YesNo, MessageBoxIcon.Error) == DialogResult.Yes)
                        try { Process.Start(new ProcessStartInfo(link) { UseShellExecute = true }); } catch { }
                    f.Close();
                }
                catch (Exception e) { MessageBox.Show(f, e.ToString(), "DSR Texture Editor could not start", MessageBoxButtons.OK, MessageBoxIcon.Error); f.Close(); }
            };
            f.FormClosing += (_, _) => SaveBounds(f, settings);
            form = f;
            Application.Run(f);
            form = null;
        }

        // A native folder dialog, on the window's thread. Null without a window (the --serve mode).
        public static string PickFolder(string title, string start)
        {
            var f = form; if (f == null || !f.IsHandleCreated) return null;
            return (string)f.Invoke(new Func<string>(() =>
            {
                using var d = new FolderBrowserDialog { Description = title, UseDescriptionForTitle = true, ShowNewFolderButton = true };
                if (!string.IsNullOrEmpty(start) && Directory.Exists(start)) d.InitialDirectory = start;
                return d.ShowDialog(f) == DialogResult.OK ? d.SelectedPath : null;
            }));
        }

        static void RestoreBounds(Form f, Settings s)
        {
            var w = s.Window; if (w == null || w.Length != 4 || w[2] < 400 || w[3] < 300) return;
            var r = new System.Drawing.Rectangle(w[0], w[1], w[2], w[3]);
            if (!Screen.AllScreens.Any(sc => sc.WorkingArea.IntersectsWith(r))) return;   // the screen it was on is gone
            f.StartPosition = FormStartPosition.Manual; f.Bounds = r;
            if (s.WindowMaximized) f.WindowState = FormWindowState.Maximized;
        }
        static void SaveBounds(Form f, Settings s)
        {
            var r = f.WindowState == FormWindowState.Normal ? f.Bounds : f.RestoreBounds;
            s.Window = new[] { r.X, r.Y, r.Width, r.Height }; s.WindowMaximized = f.WindowState == FormWindowState.Maximized;
            try { s.Save(); } catch { }
        }
    }

    static class Native
    {
        [DllImport("kernel32.dll")] static extern bool AttachConsole(int pid);
        // A windowed exe has no console; --serve wants to print its URL to the one it was started from.
        public static void UseParentConsole() { try { AttachConsole(-1); } catch { } }
    }
}
