// Per-user settings: %APPDATA%\DSR Texture Editor\settings.json (the default game folder, recent
// projects, the window's last position).
using System.Text.Json;

namespace TextureEditor
{
    class Settings
    {
        public string GameFolder { get; set; }
        public bool UseMods { get; set; } = true;
        public string LastProject { get; set; }
        public List<string> RecentProjects { get; set; } = new();
        public int[] Window { get; set; }          // x, y, width, height of the normal (not maximized) window
        public bool WindowMaximized { get; set; }
        public string ExportTarget { get; set; }   // the last "export to game" target folder
        public string FxcPath { get; set; }        // the shader compiler; null = the newest installed Windows SDK's
        public string ShaderSource { get; set; }   // the HLSL source folder, when no project is open

        public static readonly string Folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "DSR Texture Editor");
        static string FilePath => Path.Combine(Folder, "settings.json");
        // The app's earlier name; its settings are taken over once.
        static string OldFilePath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "DSR Texture Studio", "settings.json");

        public static Settings Load()
        {
            foreach (var p in new[] { FilePath, OldFilePath })
                try { if (File.Exists(p)) return JsonSerializer.Deserialize<Settings>(File.ReadAllText(p)) ?? new(); } catch { }
            return new Settings();
        }
        public void Save()
        {
            Directory.CreateDirectory(Folder);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        }
        public void Remember(string folder)
        {
            LastProject = folder;
            RecentProjects.RemoveAll(p => string.Equals(p, folder, StringComparison.OrdinalIgnoreCase));
            RecentProjects.Insert(0, folder);
            if (RecentProjects.Count > 12) RecentProjects.RemoveRange(12, RecentProjects.Count - 12);
            Save();
        }
    }
}
