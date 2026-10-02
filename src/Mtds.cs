// Material definitions (MTD): the game's mtd\Mtd.mtdbnd.dcx (with MtdPatch.mtdbnd.dcx laid over it),
// the project's edited and new definitions, and the merged bundles written by the game export.
//
// An MTD names a shader family (ShaderPath, e.g. FRPG_Phn_ColDifSpcBmp.spx: the game builds the
// pixel shader's name from it, so only families the game knows are usable), typed parameters and
// texture slots (type, UV set, sampler register). The project keeps whole definitions under the
// MTD's file name (C[D].mtd), and per-model reassignments of a FLVER material to another MTD.
using System.Text.Json.Nodes;
using SoulsFormats;

namespace TextureEditor
{
    class MtdStore
    {
        readonly BND3 bundle, patch;          // Mtd.mtdbnd.dcx and MtdPatch.mtdbnd.dcx (may be null)
        readonly Dictionary<string, MTD> originals = new(StringComparer.OrdinalIgnoreCase);
        readonly Dictionary<string, string> binderNames = new(StringComparer.OrdinalIgnoreCase);   // leaf -> full binder name
        public readonly string NamePrefix;    // N:\FRPG\data\Material\mtd\

        public MtdStore(GameFiles files)
        {
            var main = files.Resolve(Path.Combine("mtd", "Mtd.mtdbnd.dcx")) ?? throw new Exception("mtd\\Mtd.mtdbnd.dcx not found in the game folder");
            bundle = BND3.Read(File.ReadAllBytes(main));
            var patchPath = files.Resolve(Path.Combine("mtd", "MtdPatch.mtdbnd.dcx"));
            patch = patchPath != null ? BND3.Read(File.ReadAllBytes(patchPath)) : null;
            foreach (var f in bundle.Files) Add(f);
            if (patch != null) foreach (var f in patch.Files) Add(f);   // the patch's definitions win, as in the game
            var first = bundle.Files.FirstOrDefault()?.Name ?? @"N:\FRPG\data\Material\mtd\x.mtd";
            NamePrefix = first.Substring(0, first.LastIndexOfAny(new[] { '\\', '/' }) + 1);
        }
        void Add(BinderFile f)
        {
            if (!f.Name.EndsWith(".mtd", StringComparison.OrdinalIgnoreCase)) return;
            try { var leaf = Leaf(f.Name); originals[leaf] = MTD.Read(f.Bytes); binderNames[leaf] = f.Name; } catch { }
        }
        public static string Leaf(string p) => p.Split('\\', '/').Last();

        public IEnumerable<string> Names => originals.Keys;
        public MTD Original(string name) => originals.TryGetValue(name, out var m) ? m : null;

        // The definition in force: the project's, else the game's.
        public MTD Effective(string name, Project project)
        {
            var o = project?.Material(name); if (o != null) return FromJson(o);
            return Original(name);
        }

        // ---- JSON form: { shaderPath, description, params: [{ name, type, value }], textures: [{ type, uvNumber, shaderDataIndex }] } ----
        public static JsonObject ToJson(MTD m) => new JsonObject
        {
            ["shaderPath"] = m.ShaderPath, ["description"] = m.Description,
            ["params"] = new JsonArray(m.Params.Select(p => (JsonNode)new JsonObject { ["name"] = p.Name, ["type"] = p.Type.ToString(), ["value"] = ValueJson(p.Value) }).ToArray()),
            ["textures"] = new JsonArray(m.Textures.Select(t => (JsonNode)new JsonObject { ["type"] = t.Type, ["uvNumber"] = t.UVNumber, ["shaderDataIndex"] = t.ShaderDataIndex }).ToArray()),
        };
        static JsonNode ValueJson(object v) => v switch
        {
            int i => i, bool b => b, float f => f,
            int[] a => new JsonArray(a.Select(x => (JsonNode)x).ToArray()),
            float[] a => new JsonArray(a.Select(x => (JsonNode)x).ToArray()),
            _ => null,
        };
        public static MTD FromJson(JsonObject j)
        {
            var m = new MTD { ShaderPath = (string)j["shaderPath"] ?? "", Description = (string)j["description"] ?? "" };
            foreach (var p in j["params"]?.AsArray() ?? new JsonArray())
            {
                var type = Enum.Parse<MTD.ParamType>((string)p["type"], true);
                m.Params.Add(new MTD.Param { Name = (string)p["name"], Type = type, Value = ParseValue(type, p["value"]) });
            }
            foreach (var t in j["textures"]?.AsArray() ?? new JsonArray())
                m.Textures.Add(new MTD.Texture { Type = (string)t["type"], UVNumber = (int?)t["uvNumber"] ?? 1, ShaderDataIndex = (int?)t["shaderDataIndex"] ?? 0 });
            return m;
        }
        static object ParseValue(MTD.ParamType type, JsonNode v)
        {
            float[] Floats(int n) { var a = v?.AsArray(); var o = new float[n]; for (int i = 0; i < n; i++) o[i] = a != null && i < a.Count ? (float)a[i] : 0; return o; }
            return type switch
            {
                MTD.ParamType.Bool => (bool?)v ?? false,
                MTD.ParamType.Int => (int?)v ?? 0,
                MTD.ParamType.Int2 => (v?.AsArray() ?? new JsonArray()).Select(x => (int)x).Concat(new[] { 0, 0 }).Take(2).ToArray(),
                MTD.ParamType.Float => (float?)v ?? 0f,
                MTD.ParamType.Float2 => Floats(2), MTD.ParamType.Float3 => Floats(3), MTD.ParamType.Float4 => Floats(4),
                _ => 0,
            };
        }

        // ---- the list: every definition with where it comes from ----
        public static string Family(string shaderPath) { var l = Leaf(shaderPath ?? ""); return l.EndsWith(".spx", StringComparison.OrdinalIgnoreCase) ? l[..^4] : l; }
        static int? IntParam(MTD m, string name) => m.Params.FirstOrDefault(p => p.Name == name)?.Value is int i ? i : null;
        public object Summary(string name, MTD m, string source) => new
        {
            name, shaderPath = m.ShaderPath, family = Family(m.ShaderPath), source,
            blend = IntParam(m, "g_BlendMode"), lighting = IntParam(m, "g_LightingType"), workflow = IntParam(m, "g_MaterialWorkflow"),
            paramCount = m.Params.Count, textures = m.Textures.Select(t => t.Type).ToArray(),
        };
        public object List(Project project)
        {
            var list = new List<object>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var name in originals.Keys.OrderBy(n => n, StringComparer.OrdinalIgnoreCase))
            {
                seen.Add(name);
                var o = project?.Material(name);
                list.Add(Summary(name, o != null ? FromJson(o) : originals[name], o != null ? "edited" : "game"));
            }
            if (project != null) foreach (var name in project.MaterialNames()) if (!seen.Contains(name)) list.Add(Summary(name, FromJson(project.Material(name)), "new"));
            return new { mtds = list, families = Families() };
        }

        // What the game's own definitions show each shader family to use: the parameters (with
        // their commonest value) and texture slots (with their commonest UV set and register).
        object families;
        public object Families() => families ??= originals.Values.GroupBy(m => m.ShaderPath).OrderByDescending(g => g.Count()).Select(g =>
        {
            var prms = g.SelectMany(m => m.Params).GroupBy(p => p.Name).OrderByDescending(x => x.Count())
                .Select(x => { var mode = x.GroupBy(p => ValueJson(p.Value)?.ToJsonString() ?? "").OrderByDescending(y => y.Count()).First().First(); return new { name = x.Key, type = mode.Type.ToString(), value = ValueJson(mode.Value), used = x.Count() }; });
            var texs = g.SelectMany(m => m.Textures).GroupBy(t => t.Type).OrderByDescending(x => x.Count())
                .Select(x => { var mode = x.GroupBy(t => (t.UVNumber, t.ShaderDataIndex)).OrderByDescending(y => y.Count()).First().First(); return new { type = x.Key, uvNumber = mode.UVNumber, shaderDataIndex = mode.ShaderDataIndex, used = x.Count() }; });
            return new { shaderPath = g.Key, family = Family(g.Key), count = g.Count(), @params = prms, textures = texs };
        }).ToList();

        public JsonObject Detail(string name, Project project)
        {
            var o = project?.Material(name); var orig = Original(name);
            if (o == null && orig == null) return null;
            var j = o != null ? (JsonObject)JsonNode.Parse(o.ToJsonString()) : ToJson(orig);
            j["name"] = name; j["source"] = o == null ? "game" : orig == null ? "new" : "edited";
            j["original"] = orig != null && o != null ? ToJson(orig) : null;
            return j;
        }

        // ---- the bundles for the game export: the game's with the project's definitions merged in ----
        public List<string> WriteBundles(Project project, string targetRoot)
        {
            var names = project.MaterialNames().ToList(); if (names.Count == 0) return new();
            var written = new List<string>();
            var main = BND3.Read(bundle.Write());   // a copy to edit
            foreach (var name in names)
            {
                var bytes = FromJson(project.Material(name)).Write();
                var f = main.Files.FirstOrDefault(x => Leaf(x.Name).Equals(name, StringComparison.OrdinalIgnoreCase));
                if (f != null) f.Bytes = bytes;
                else main.Files.Add(new BinderFile(Binder.FileFlags.Flag1, main.Files.Max(x => x.ID) + 1, NamePrefix + name, bytes));
            }
            var dest = Path.Combine(targetRoot, "mtd", "Mtd.mtdbnd.dcx");
            Directory.CreateDirectory(Path.GetDirectoryName(dest)); main.Write(dest); written.Add(dest);
            if (patch != null && patch.Files.Any(x => names.Contains(Leaf(x.Name), StringComparer.OrdinalIgnoreCase)))
            {   // the patch bundle overrides the main one in the game, so an edited definition in it is updated there too
                var p = BND3.Read(patch.Write());
                foreach (var f in p.Files) { var name = Leaf(f.Name); if (names.Contains(name, StringComparer.OrdinalIgnoreCase)) f.Bytes = FromJson(project.Material(name)).Write(); }
                var pd = Path.Combine(targetRoot, "mtd", "MtdPatch.mtdbnd.dcx"); p.Write(pd); written.Add(pd);
            }
            return written;
        }
    }
}
