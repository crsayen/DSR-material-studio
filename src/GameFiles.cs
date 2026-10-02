// Game files: models, materials and textures read from the game folder through the ModEngine2
// mods it enables.
using System.Numerics;
using System.Text.RegularExpressions;
using BCnEncoder.Decoder;
using BCnEncoder.Shared;
using SoulsFormats;

namespace TextureEditor
{
    // ---- game files through the enabled ModEngine2 mods ------------------------------------------
    class GameFiles
    {
        public readonly string[] Roots;
        public readonly List<(string name, string path)> Mods = new();   // the enabled ModEngine2 mods, in load order
        readonly string game;
        readonly Dictionary<string, Tex> textures = new();
        BND3 mtdBundle;

        public GameFiles(string game, bool useMods = true)
        {
            this.game = game;
            var roots = new List<string>();
            var toml = Path.Combine(game, "ModEngine2", "config_darksoulsremastered.toml");
            if (useMods && File.Exists(toml))
                foreach (Match m in Regex.Matches(File.ReadAllText(toml), @"\{\s*enabled\s*=\s*true\s*,\s*name\s*=\s*""([^""]*)""\s*,\s*path\s*=\s*""([^""]+)"""))
                {
                    var p = Path.Combine(game, "ModEngine2", m.Groups[2].Value);
                    if (Directory.Exists(p)) { roots.Add(p); Mods.Add((m.Groups[1].Value, p)); }
                }
            roots.Add(game);
            Roots = roots.ToArray();
        }

        public static bool LooksLikeGame(string folder) => !string.IsNullOrEmpty(folder) && Directory.Exists(folder) &&
            (File.Exists(Path.Combine(folder, "DarkSoulsRemastered.exe")) || Directory.Exists(Path.Combine(folder, "parts")));

        // The game folder from Steam's library list, else the default Steam location.
        public static string FindGame()
        {
            var steam = new List<string>();
            try
            {
                foreach (var key in new[] { @"HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Valve\Steam", @"HKEY_LOCAL_MACHINE\SOFTWARE\Valve\Steam", @"HKEY_CURRENT_USER\SOFTWARE\Valve\Steam" })
                {
                    var v = (OperatingSystem.IsWindows() ? Microsoft.Win32.Registry.GetValue(key, key.StartsWith("HKEY_CURRENT_USER") ? "SteamPath" : "InstallPath", null) : null) as string;
                    if (!string.IsNullOrEmpty(v)) steam.Add(v.Replace('/', Path.DirectorySeparatorChar));
                }
            }
            catch { }
            steam.Add(@"C:\Program Files (x86)\Steam");
            foreach (var s in steam.Distinct(StringComparer.OrdinalIgnoreCase))
            {
                var libraries = new List<string> { s };
                var vdf = Path.Combine(s, "steamapps", "libraryfolders.vdf");
                if (File.Exists(vdf)) foreach (Match m in Regex.Matches(File.ReadAllText(vdf), @"""path""\s+""([^""]+)""")) libraries.Add(m.Groups[1].Value.Replace(@"\\", @"\"));
                foreach (var lib in libraries)
                {
                    var g = Path.Combine(lib, "steamapps", "common", "DARK SOULS REMASTERED");
                    if (LooksLikeGame(g)) return g;
                }
            }
            return @"C:\Program Files (x86)\Steam\steamapps\common\DARK SOULS REMASTERED";
        }

        public string Resolve(string relative)
        {
            foreach (var r in Roots) { var p = Path.Combine(r, relative); if (File.Exists(p)) return p; }
            return null;
        }

        public record ModelEntry(string path, string name, string category);
        public List<ModelEntry> ListModels()
        {
            var seen = new SortedDictionary<string, ModelEntry>(StringComparer.OrdinalIgnoreCase);
            foreach (var (folder, pattern, category) in new[] { ("parts", "*.partsbnd.dcx", "parts"), ("obj", "*.objbnd.dcx", "objects"), ("chr", "*.chrbnd.dcx", "characters") })
                foreach (var r in Roots)
                {
                    var dir = Path.Combine(r, folder); if (!Directory.Exists(dir)) continue;
                    foreach (var f in Directory.GetFiles(dir, pattern))
                    {
                        var rel = folder + "/" + Path.GetFileName(f);
                        if (!seen.ContainsKey(rel)) seen[rel] = new ModelEntry(rel, Path.GetFileName(f).Split('.')[0], category);
                    }
                }
            return seen.Values.ToList();
        }

        BND3 Mtds() => mtdBundle ??= BND3.Read(DCX.Decompress(File.ReadAllBytes(Resolve(Path.Combine("mtd", "Mtd.mtdbnd.dcx")))));

        static string Leaf(string p) => p.Split('\\', '/').Last();
        static string Stem(string p) { var l = Leaf(p); var d = l.IndexOf('.'); return d < 0 ? l : l.Substring(0, d); }

        // Every TPF reachable from an archive: inside it, or a chr's .chrtpfbhd/.chrtpfbdt pair.
        IEnumerable<(TPF tpf, string source)> Tpfs(BND3 bnd, string relative)
        {
            foreach (var f in bnd.Files)
            {
                var n = f.Name.ToLowerInvariant();
                if (n.EndsWith(".tpf")) yield return (TPF.Read(f.Bytes), relative);
                else if (n.EndsWith(".chrtpfbhd"))
                {
                    var bdt = Resolve(Path.Combine(Path.GetDirectoryName(relative), Stem(f.Name) + ".chrtpfbdt"));
                    if (bdt == null) continue;
                    var bxf = BXF3.Read(f.Bytes, File.ReadAllBytes(bdt));
                    foreach (var b in bxf.Files) if (b.Name.ToLowerInvariant().EndsWith(".tpf")) yield return (TPF.Read(b.Bytes), relative);
                }
            }
        }

        public object LoadModel(string relative, Project project)
        {
            var path = Resolve(relative.Replace('/', '\\')) ?? throw new Exception(relative + ": not found");
            var bnd = BND3.Read(DCX.Decompress(File.ReadAllBytes(path)));
            var flvers = bnd.Files.Where(f => f.Name.ToLowerInvariant().EndsWith(".flver")).ToList();
            if (flvers.Count == 0) throw new Exception(relative + ": no model inside");
            var tpfTextures = new Dictionary<string, (TPF.Texture tex, string source)>(StringComparer.OrdinalIgnoreCase);
            foreach (var (tpf, source) in Tpfs(bnd, relative))
                foreach (var t in tpf.Textures) tpfTextures.TryAdd(t.Name, (t, source));

            var meshes = new List<object>(); var materials = new List<object>();
            int materialBase = 0;
            foreach (var ff in flvers)
            {
                var flver = FLVER2.Read(ff.Bytes);
                // World transforms of the nodes (row vectors: local * parent).
                var world = new Matrix4x4[flver.Nodes.Count];
                for (int i = 0; i < flver.Nodes.Count; i++)
                {
                    var m = flver.Nodes[i].ComputeLocalTransform();
                    for (int p = flver.Nodes[i].ParentIndex; p >= 0; p = flver.Nodes[p].ParentIndex) m *= flver.Nodes[p].ComputeLocalTransform();
                    world[i] = m;
                }
                foreach (var mat in flver.Materials) materials.Add(MaterialJson(mat, tpfTextures, project));
                foreach (var mesh in flver.Meshes)
                {
                    var faces = mesh.FaceSets.FirstOrDefault(); if (faces == null) continue;
                    var idx = faces.Triangulate(mesh.Vertices.Count < ushort.MaxValue);
                    int n = mesh.Vertices.Count;
                    var pos = new float[n * 3]; var nrm = new float[n * 3]; var tan = new float[n * 4]; var bin = new float[n * 3]; var uv = new float[n * 2]; var col = new float[n * 4];
                    for (int i = 0; i < n; i++)
                    {
                        var v = mesh.Vertices[i];
                        var p = v.Position; var nn = v.Normal;
                        var t = v.Tangents.Count > 0 ? v.Tangents[0] : new Vector4(1, 0, 0, 1);
                        var b = new Vector3(v.Bitangent.X, v.Bitangent.Y, v.Bitangent.Z);
                        if (!mesh.UseBoneWeights)
                        {   // bound to one node, not in bind pose: that node's transform applies
                            int node = mesh.BoneIndices.Count > 0 && v.NormalW >= 0 && v.NormalW < mesh.BoneIndices.Count ? mesh.BoneIndices[v.NormalW] : mesh.NodeIndex;
                            if (node >= 0 && node < world.Length)
                            {
                                var w = world[node]; p = Vector3.Transform(p, w); nn = Vector3.TransformNormal(nn, w);
                                var t3 = Vector3.TransformNormal(new Vector3(t.X, t.Y, t.Z), w); t = new Vector4(t3, t.W); b = Vector3.TransformNormal(b, w);
                            }
                        }
                        if (b.LengthSquared() < 1e-8f) b = Vector3.Cross(nn, new Vector3(t.X, t.Y, t.Z)) * t.W;
                        pos[i * 3] = p.X; pos[i * 3 + 1] = p.Y; pos[i * 3 + 2] = p.Z;
                        nrm[i * 3] = nn.X; nrm[i * 3 + 1] = nn.Y; nrm[i * 3 + 2] = nn.Z;
                        tan[i * 4] = t.X; tan[i * 4 + 1] = t.Y; tan[i * 4 + 2] = t.Z; tan[i * 4 + 3] = t.W;
                        bin[i * 3] = b.X; bin[i * 3 + 1] = b.Y; bin[i * 3 + 2] = b.Z;
                        var u = v.UVs.Count > 0 ? v.UVs[0] : Vector3.Zero; uv[i * 2] = u.X; uv[i * 2 + 1] = u.Y;
                        var c = v.Colors.Count > 0 ? v.Colors[0] : new FLVER.VertexColor(1f, 1f, 1f, 1f);
                        col[i * 4] = c.R; col[i * 4 + 1] = c.G; col[i * 4 + 2] = c.B; col[i * 4 + 3] = c.A;
                    }
                    meshes.Add(new
                    {
                        material = materialBase + mesh.MaterialIndex,
                        position = B64(pos), normal = B64(nrm), tangent = B64(tan), bitangent = B64(bin), uv = B64(uv), color = B64(col),
                        index = Convert.ToBase64String(idx.SelectMany(BitConverter.GetBytes).ToArray()),
                    });
                }
                materialBase += flver.Materials.Count;
            }
            return new { path = relative, meshes, materials };
        }

        static string B64(float[] a) { var b = new byte[a.Length * 4]; Buffer.BlockCopy(a, 0, b, 0, b.Length); return Convert.ToBase64String(b); }

        object MaterialJson(FLVER2.Material mat, Dictionary<string, (TPF.Texture tex, string source)> tpfTextures, Project project)
        {
            var mtdName = Leaf(mat.MTD);
            var file = Mtds().Files.FirstOrDefault(f => Leaf(f.Name).Equals(mtdName, StringComparison.OrdinalIgnoreCase));
            var prm = new Dictionary<string, object>();
            string shader = null;
            if (file != null)
            {
                var mtd = MTD.Read(file.Bytes); shader = Leaf(mtd.ShaderPath);
                foreach (var p in mtd.Params) prm[p.Name] = p.Value is Array a ? a.Cast<object>().ToArray() : p.Value;
            }
            var textures = new List<object>();
            foreach (var t in mat.Textures)
            {
                if (string.IsNullOrEmpty(t.Path)) continue;
                var name = Stem(t.Path);
                object info = null;
                if (tpfTextures.TryGetValue(name, out var found))
                {
                    var tex = Register(found.tex, found.source);
                    if (tex != null) info = new { id = tex.Id, name = tex.Name, width = tex.Width, height = tex.Height, format = tex.FormatName, hashes = tex.Hashes.Select(h => h.ToString("X16")), source = tex.Source, exported = project?.IsExported(tex) ?? false, recipe = Project.KeyOf(tex) };
                }
                textures.Add(new { param = t.ParamName, path = t.Path, name, texture = info });
            }
            return new { name = mat.Name, mtd = mtdName, shader, @params = prm, textures };
        }

        // ---- textures: decoded once, kept by id ----
        public class Tex
        {
            public string Id, Name, Source, FormatName; public int Width, Height, Dxgi; public ulong[] Hashes; public byte[] Rgba;
        }
        public Tex Texture(string id) { lock (textures) return textures.TryGetValue(id, out var t) ? t : null; }

        Tex Register(TPF.Texture t, string source)
        {
            var id = (source + "|" + t.Name).ToLowerInvariant();
            lock (textures) if (textures.TryGetValue(id, out var have)) return have;
            var dds = new DdsInfo(t.Bytes);
            if (dds.Dxgi == 0) return null;
            var tex = new Tex { Id = id, Name = t.Name, Source = source, Width = dds.Width, Height = dds.Height, Dxgi = dds.Dxgi, FormatName = dds.FormatName };
            tex.Hashes = RuntimeHash.Candidates(dds);
            tex.Rgba = Decode(dds);
            if (tex.Rgba == null) return null;
            lock (textures) textures[id] = tex;
            return tex;
        }

        static byte[] Decode(DdsInfo d)
        {
            int w = d.Width, h = d.Height;
            var mip0 = d.Mip0();
            CompressionFormat f;
            switch (d.Family)
            {
                case "BC1": f = CompressionFormat.Bc1WithAlpha; break;
                case "BC2": f = CompressionFormat.Bc2; break;
                case "BC3": f = CompressionFormat.Bc3; break;
                case "BC4": f = CompressionFormat.Bc4; break;
                case "BC5": f = CompressionFormat.Bc5; break;
                case "BC7": f = CompressionFormat.Bc7; break;
                case "RGBA8":
                    return mip0;
                case "BGRA8":
                    { var o = (byte[])mip0.Clone(); for (int i = 0; i < o.Length; i += 4) (o[i], o[i + 2]) = (o[i + 2], o[i]); return o; }
                default: return null;
            }
            var px = new BcDecoder().DecodeRaw(mip0, w, h, f);
            var o2 = new byte[w * h * 4];
            for (int i = 0; i < px.Length; i++) { o2[i * 4] = px[i].r; o2[i * 4 + 1] = px[i].g; o2[i * 4 + 2] = px[i].b; o2[i * 4 + 3] = px[i].a; }
            if (d.Family == "BC5") for (int i = 0; i < px.Length; i++) { o2[i * 4 + 2] = 0; o2[i * 4 + 3] = 255; }
            return o2;
        }
    }
}
