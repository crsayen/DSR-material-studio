// A project: one folder holding texture-editor.project.json (the game install it edits, the models
// opened, every edited texture's layers) and the exported textures as <content id>.dds.
using System.Text.Json;
using System.Text.Json.Nodes;

namespace TextureEditor
{
    static class Json
    {
        public static JsonNode Clone(JsonNode n) => n == null ? null : JsonNode.Parse(n.ToJsonString());   // .NET 6 has no DeepClone
    }

    class Project
    {
        public const string FileName = "texture-editor.project.json";
        // Projects made by the app under its earlier name keep their file name.
        static readonly string[] FileNames = { FileName, "texture-studio.project.json" };
        public readonly string Folder;
        readonly string filePath;
        readonly JsonObject doc;
        readonly object gate = new();

        Project(string folder, string filePath, JsonObject doc) { Folder = folder; this.filePath = filePath; this.doc = doc; }
        static string FileIn(string folder) => string.IsNullOrEmpty(folder) ? null : FileNames.Select(n => Path.Combine(folder, n)).FirstOrDefault(File.Exists);
        public static bool Exists(string folder) => FileIn(folder) != null;

        public static Project Create(string folder, string gameFolder, bool useMods)
        {
            folder = Path.GetFullPath(folder);
            if (!Directory.Exists(folder)) throw new Exception($"{folder}: no such folder");
            if (Exists(folder)) throw new Exception("This folder already has a project: open it instead.");
            var doc = new JsonObject
            {
                ["format"] = "dsr-texture-studio-project", ["version"] = 1,
                ["created"] = DateTime.Now.ToString("s"), ["modified"] = DateTime.Now.ToString("s"),
                ["game"] = new JsonObject { ["folder"] = gameFolder, ["useMods"] = useMods },
                ["models"] = new JsonArray(),
                ["textures"] = new JsonObject(),
            };
            var p = new Project(folder, Path.Combine(folder, FileName), doc); p.Save(); return p;
        }
        public static Project Open(string folder)
        {
            folder = Path.GetFullPath(folder);
            if (File.Exists(folder) && FileNames.Contains(Path.GetFileName(folder), StringComparer.OrdinalIgnoreCase)) folder = Path.GetDirectoryName(folder);
            var file = FileIn(folder) ?? throw new Exception($"{folder} has no {FileName}");
            var doc = JsonNode.Parse(File.ReadAllText(file)) as JsonObject ?? throw new Exception("Not a project file");
            if ((string)doc["format"] != "dsr-texture-studio-project") throw new Exception("Not a DSR Texture Editor project file");
            doc["models"] ??= new JsonArray(); doc["textures"] ??= new JsonObject();
            if (doc["game"] == null) doc["game"] = new JsonObject { ["folder"] = (string)doc["gameFolder"], ["useMods"] = true };
            return new Project(folder, file, doc);
        }

        // The game install this project edits: read from (through its ModEngine2 mods when useMods).
        public string GameFolder { get { lock (gate) return (string)doc["game"]?["folder"]; } }
        public bool UseMods { get { lock (gate) return (bool?)doc["game"]?["useMods"] ?? true; } }
        public void SetGame(string folder, bool useMods) { lock (gate) { doc["game"] = new JsonObject { ["folder"] = folder, ["useMods"] = useMods }; Save(); } }

        // A texture's key: its content id as the game usually creates it (the unorm format).
        public static string KeyOf(GameFiles.Tex t) => (t.Hashes.Length > 1 ? t.Hashes[1] : t.Hashes.FirstOrDefault()).ToString("X16");
        JsonObject Textures => doc["textures"].AsObject();

        public object Summary()
        {
            lock (gate)
                return new
                {
                    folder = Folder, name = Path.GetFileName(Folder.TrimEnd('\\', '/')),
                    models = doc["models"].AsArray().Select(n => (string)n).ToArray(),
                    textures = Textures.Select(kv => new { key = kv.Key, name = (string)kv.Value["name"], source = (string)kv.Value["source"], layers = kv.Value["layers"]?.AsArray().Count ?? 0, exported = (string)kv.Value["exported"] }).ToArray(),
                };
        }
        public JsonObject Recipe(string key) { lock (gate) return Json.Clone(Textures[key]) as JsonObject; }
        public bool IsExported(GameFiles.Tex t) => t.Hashes.Any(h => File.Exists(Path.Combine(Folder, h.ToString("X16") + ".dds")));

        public void TouchModel(string model)
        {
            lock (gate)
            {
                var models = doc["models"].AsArray();
                var existing = models.FirstOrDefault(n => string.Equals((string)n, model, StringComparison.OrdinalIgnoreCase));
                if (existing != null) models.Remove(existing);
                models.Insert(0, model);
                while (models.Count > 50) models.RemoveAt(models.Count - 1);
                Save();
            }
        }
        JsonObject Entry(GameFiles.Tex t)
        {
            var key = KeyOf(t);
            if (Textures[key] is not JsonObject e)
            {
                e = new JsonObject { ["name"] = t.Name, ["source"] = t.Source, ["width"] = t.Width, ["height"] = t.Height, ["format"] = t.FormatName, ["hashes"] = new JsonArray(t.Hashes.Select(h => (JsonNode)h.ToString("X16")).ToArray()), ["layers"] = new JsonArray(), ["exported"] = null };
                Textures[key] = e;
            }
            return e;
        }
        public void SaveLayers(GameFiles.Tex t, JsonArray layers)
        {
            lock (gate)
            {
                var e = Entry(t); e["layers"] = Json.Clone(layers) ?? new JsonArray(); e["edited"] = DateTime.Now.ToString("s");
                Save();
            }
        }
        // An RGBA8 DDS with a full mip chain under every id the game may give the original.
        public List<string> Export(GameFiles.Tex t, byte[] rgba)
        {
            var dds = DdsWriter.Rgba8WithMips(rgba, t.Width, t.Height);
            var written = new List<string>();
            foreach (var h in t.Hashes)
            {
                var p = Path.Combine(Folder, h.ToString("X16") + ".dds");
                File.WriteAllBytes(p + ".tmp", dds); File.Move(p + ".tmp", p, true);
                written.Add(p);
            }
            lock (gate) { Entry(t)["exported"] = DateTime.Now.ToString("s"); Save(); }
            return written;
        }
        public List<string> Unexport(GameFiles.Tex t)
        {
            var removed = new List<string>();
            foreach (var h in t.Hashes) { var p = Path.Combine(Folder, h.ToString("X16") + ".dds"); if (File.Exists(p)) { File.Delete(p); removed.Add(p); } }
            lock (gate) { if (Textures[KeyOf(t)] is JsonObject e) { e["exported"] = null; Save(); } }
            return removed;
        }
        void Save()
        {
            doc["modified"] = DateTime.Now.ToString("s");
            var json = doc.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(filePath + ".tmp", json); File.Move(filePath + ".tmp", filePath, true);
        }
    }

    // The page's own folder browser, used when there is no native dialog (the --serve mode in a browser).
    static class FolderBrowser
    {
        public static object List(string path)
        {
            var drives = DriveInfo.GetDrives().Where(d => d.IsReady).Select(d => d.RootDirectory.FullName).ToArray();
            if (string.IsNullOrWhiteSpace(path) || !Directory.Exists(path))
                return new { path = "", parent = (string)null, dirs = Array.Empty<string>(), drives, hasProject = false, isGame = false, error = string.IsNullOrWhiteSpace(path) ? null : "No such folder" };
            path = Path.GetFullPath(path);
            string[] dirs;
            try
            {
                dirs = Directory.GetDirectories(path).Where(d => (new DirectoryInfo(d).Attributes & (FileAttributes.Hidden | FileAttributes.System)) == 0)
                    .Select(Path.GetFileName).OrderBy(n => n, StringComparer.OrdinalIgnoreCase).ToArray();
            }
            catch (Exception e) { return new { path, parent = Path.GetDirectoryName(path), dirs = Array.Empty<string>(), drives, hasProject = false, isGame = false, error = e.Message }; }
            return new { path, parent = Path.GetDirectoryName(path), dirs, drives, hasProject = Project.Exists(path), isGame = GameFiles.LooksLikeGame(path), error = (string)null };
        }
    }
}
