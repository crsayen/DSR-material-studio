// The shader workbench: the game's pixel-shader variants (FRPG_FlverPBL_fpo_DX11.shaderbnd.dcx),
// rebuilt from HLSL sources with fxc (Shader Model 5, DXBC) and packed into a copy of the archive
// for a mod folder. The game cannot load a shader under a new name (it builds the names itself),
// so the workbench builds the existing names: each variant's source file and defines follow the
// game's own naming (slots Dif/Spc/Bmp/Mul/Lit/Sdw|Csd, suffixes HemEnv/Lerp/PntS/Parallax/
// Subsurf/Alp/HemDir3/Non), as reconstructed by the DSR Shader Compiler project, and a
// variants.json beside the sources can override them.
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using SoulsFormats;

namespace TextureEditor
{
    static class Fxc
    {
        // The newest fxc of an installed Windows SDK.
        public static string Find()
        {
            var kits = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Windows Kits");
            var found = new List<(Version v, string path)>();
            try
            {
                foreach (var ver in Directory.GetDirectories(Path.Combine(kits, "10", "bin")))
                {
                    var p = Path.Combine(ver, "x64", "fxc.exe");
                    if (File.Exists(p) && Version.TryParse(Path.GetFileName(ver), out var v)) found.Add((v, p));
                }
            }
            catch { }
            var p81 = Path.Combine(kits, "8.1", "bin", "x64", "fxc.exe");
            if (File.Exists(p81)) found.Add((new Version(8, 1), p81));
            return found.OrderByDescending(f => f.v).Select(f => f.path).FirstOrDefault();
        }
        public static string VersionOf(string fxc)
        {
            try { return FileVersionInfo.GetVersionInfo(fxc).FileVersion; } catch { return null; }
        }
    }

    class ShaderVariant
    {
        public string Name, Family, Slots, Suffix, Source;   // Source: the .fx file, null when there is no build rule
        public List<string> Defines = new();
        public bool Buildable => Source != null;
    }

    class ShaderWorkbench
    {
        public const string Archive = @"shader\FRPG_FlverPBL_fpo_DX11.shaderbnd.dcx";
        static readonly string[] BaseDefines = { "_WIN32=1", "_FRAGMENT_SHADER=1", "_DX11=1" };
        static readonly Regex NameRx = new(@"^FRPG_(?<fam>Phn|Gst|Sfx)_(?<slots>Dif(?:Spc|___)(?:Bmp|___)(?:Mul|___)(?:Lit|___)(?:Sdw|Csd|___))(?:_(?<suf>[A-Za-z0-9]+))?\.fpo$", RegexOptions.Compiled);
        static readonly HashSet<string> GstSuffixes = new() { "HemEnv", "HemEnvAlp", "HemEnvLerp", "HemEnvLerpAlp", "HemEnvLerpPntS", "HemEnvLerpPntSS", "HemEnvLerpPntSSSS", "HemEnvPntS", "HemEnvPntSS", "HemEnvPntSSSS", "HemDir3", "HemDir3PntS", "HemDir3PntSS", "HemDir3PntSSSS" };
        static readonly HashSet<string> PhnSuffixes = new(GstSuffixes) { "HemEnvLerpParallax", "HemEnvLerpSubsurf", "HemEnvParallax", "HemEnvSubsurf" };
        static readonly HashSet<string> SfxSuffixes = new() { "HemEnv", "HemEnvLerp", "HemEnvLerpPntS", "HemEnvPntS" };

        readonly GameFiles files;
        public ShaderWorkbench(GameFiles files) { this.files = files; }

        // ---- the catalogue: every pixel shader in the archive, with its build rule when known ----
        List<ShaderVariant> catalogue;
        public string ArchivePath => files.Resolve(Archive);
        public List<ShaderVariant> Catalogue(string sourceFolder)
        {
            if (catalogue == null)
            {
                catalogue = new List<ShaderVariant>();
                var path = ArchivePath; if (path == null) return catalogue;
                var bnd = BND3.Read(File.ReadAllBytes(path));
                foreach (var f in bnd.Files)
                {
                    var name = MtdStore.Leaf(f.Name); if (!name.EndsWith(".fpo", StringComparison.OrdinalIgnoreCase)) continue;
                    var v = new ShaderVariant { Name = name };
                    var m = NameRx.Match(name);
                    if (m.Success) { v.Family = m.Groups["fam"].Value; v.Slots = m.Groups["slots"].Value; v.Suffix = m.Groups["suf"].Success ? m.Groups["suf"].Value : ""; Rule(v); }
                    else v.Family = name.Split('_').Skip(1).FirstOrDefault() ?? "?";
                    catalogue.Add(v);
                }
                catalogue.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase));
            }
            ApplyOverrides(sourceFolder);
            return catalogue;
        }
        // The stock rule: the DSR Shader Compiler's reconstruction of the game's build.
        static void Rule(ShaderVariant v)
        {
            var d = new List<string>(BaseDefines);
            var s = v.Slots;
            if (s.Contains("Spc")) d.Add("WITH_SpecularMap");
            if (s.Contains("Bmp")) d.Add("WITH_BumpMap");
            if (s.Contains("Mul")) d.Add("WITH_MultiTexture");
            if (s.Contains("Lit")) d.Add("WITH_LightMap");
            if (s.EndsWith("Sdw")) d.Add("WITH_ShadowMap=1");
            if (s.EndsWith("Csd")) d.Add("WITH_ShadowMap=2");
            var suf = v.Suffix;
            if (suf == "Non")
            {
                if (v.Family == "Gst") return;
                d.Add("WITHOUT_DETAILBUMP=1"); if (v.Family == "Sfx") d.Add("WITH_Glow");
                v.Source = "FRPG_FS_Non.fx"; v.Defines = d; return;
            }
            if (suf == "" && v.Family == "Sfx") { d.Add("WITH_Glow"); v.Source = "FRPG_FS_Sfx.fx"; v.Defines = d; return; }
            var allowed = v.Family == "Phn" ? PhnSuffixes : v.Family == "Gst" ? GstSuffixes : SfxSuffixes;
            if (!allowed.Contains(suf)) return;
            if (v.Family == "Gst") d.Add("WITH_GhostMap");
            if (v.Family == "Sfx") d.Add("WITH_Glow");
            if (suf.Contains("Lerp") && !suf.EndsWith("LerpPntS")) d.Add("WITH_EnvLerp");
            if (suf.Contains("HemEnvParallax")) d.Add("WITH_Parallax");
            else if (suf.Contains("LerpParallax")) d.Add("FS_SUBSURF");   // the game's LerpParallax equals LerpSubsurf
            if (suf.Contains("PntSSSS")) d.AddRange(new[] { "WITH_PntS", "WITH_GBuffer", "OLD_VERSION=1", "USE_SH=1", "WITH_GBUFFER_4LIGHTS" });
            else if (suf.Contains("PntSS")) d.AddRange(new[] { "WITH_PntS", "WITH_GBuffer", "OLD_VERSION=1", "USE_SH=1" });
            else if (suf.Contains("PntS")) d.Add("WITH_PntS");
            if (suf.Contains("Subsurf")) d.Add("FS_SUBSURF");
            if (suf.Contains("Alp")) d.Add("WITH_AlphaBlend");
            if (suf.Contains("HemDir3")) d.AddRange(new[] { "WITH_HemDir3", "OLD_VERSION=1" });
            v.Source = suf.Contains("Alp") ? "FRPG_FS_HemEnv_Alpha.fx" : "FRPG_FS_HemEnv.fx"; v.Defines = d;
        }
        // variants.json beside the sources: [{ "match": "<regex on the name>", "source": "x.fx", "defines": [...], "add": [...] }]
        // `source` replaces the file, `defines` replaces the whole list, `add` appends; "source": null drops the rule.
        string overridesFrom; List<(Regex rx, JsonObject o)> overrides = new();
        void ApplyOverrides(string sourceFolder)
        {
            var file = sourceFolder != null ? Path.Combine(sourceFolder, "variants.json") : null;
            var key = file != null && File.Exists(file) ? file + "|" + File.GetLastWriteTimeUtc(file).Ticks : "";
            if (key == overridesFrom) return;
            overridesFrom = key; overrides.Clear();
            foreach (var v in catalogue) { v.Source = null; v.Defines = new(); if (v.Slots != null) Rule(v); }
            if (key == "") return;
            try
            {
                foreach (var n in JsonNode.Parse(File.ReadAllText(file)).AsArray())
                    if (n is JsonObject o && o["match"] != null) overrides.Add((new Regex((string)o["match"], RegexOptions.IgnoreCase), o));
            }
            catch (Exception e) { OverrideError = e.Message; return; }
            OverrideError = null;
            foreach (var v in catalogue)
                foreach (var (rx, o) in overrides)
                    if (rx.IsMatch(v.Name))
                    {
                        if (o.ContainsKey("source")) v.Source = (string)o["source"];
                        if (v.Defines.Count == 0 && v.Source != null) v.Defines = new(BaseDefines);
                        if (o["defines"] is JsonArray d) v.Defines = d.Select(x => (string)x).ToList();
                        if (o["add"] is JsonArray a) v.Defines.AddRange(a.Select(x => (string)x));
                    }
        }
        public string OverrideError;

        // ---- sources ----
        public static bool SourceOk(string folder) => !string.IsNullOrEmpty(folder) && Directory.Exists(folder) && Directory.GetFiles(folder, "*.fx").Length > 0;
        public static object SourceFiles(string folder)
        {
            if (!SourceOk(folder)) return Array.Empty<object>();
            var list = new List<object>();
            foreach (var dir in new[] { folder, Path.Combine(Path.GetDirectoryName(folder.TrimEnd('\\', '/')) ?? folder, "Common") })
            {
                if (!Directory.Exists(dir)) continue;
                foreach (var f in Directory.GetFiles(dir).Where(f => Regex.IsMatch(f, @"\.(fx|fxh|h|hlsl|hlsli|json)$", RegexOptions.IgnoreCase)).OrderBy(f => f, StringComparer.OrdinalIgnoreCase))
                    list.Add(new { path = Path.GetRelativePath(folder, f).Replace('\\', '/'), size = new FileInfo(f).Length, modified = File.GetLastWriteTime(f) });
            }
            return list;
        }
        public static string SourcePath(string folder, string rel)
        {
            var full = Path.GetFullPath(Path.Combine(folder, rel));
            var root = Path.GetFullPath(Path.GetDirectoryName(folder.TrimEnd('\\', '/')) ?? folder);
            if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new Exception("Outside the source folder");
            return full;
        }

        // ---- building: fxc per variant; the blobs and their logs kept in <project>\shaders ----
        public record BuildResult(string name, bool ok, string log, int size, long ms, string digest);
        public static string BlobFolder(Project project) => Path.Combine(project.Folder, "shaders");
        public BuildResult Build(ShaderVariant v, string fxc, string sourceFolder, Project project)
        {
            var sw = Stopwatch.StartNew();
            if (!v.Buildable) return new BuildResult(v.Name, false, "No build rule for this variant (add one in variants.json).", 0, 0, null);
            var src = Path.Combine(sourceFolder, v.Source);
            if (!File.Exists(src)) return new BuildResult(v.Name, false, $"{v.Source} not found in the source folder.", 0, 0, null);
            var outDir = BlobFolder(project); Directory.CreateDirectory(outDir);
            var outFile = Path.Combine(outDir, v.Name);
            var common = Path.Combine(Path.GetDirectoryName(sourceFolder.TrimEnd('\\', '/')) ?? sourceFolder, "Common");
            var args = $"\"{src}\" /Fo\"{outFile}.tmp\" /T ps_5_0 /nologo {string.Join(" ", v.Defines.Select(d => "/D" + d))} /I\"{sourceFolder}\"{(Directory.Exists(common) ? $" /I\"{common}\"" : "")} /EFragmentMain";
            var psi = new ProcessStartInfo(fxc, args) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
            string log;
            int code;
            try
            {
                using var p = Process.Start(psi);
                var so = p.StandardOutput.ReadToEndAsync(); var se = p.StandardError.ReadToEndAsync();
                p.WaitForExit(); code = p.ExitCode; log = (so.Result + se.Result).Trim();
            }
            catch (Exception e) { return new BuildResult(v.Name, false, "fxc could not be run: " + e.Message, 0, sw.ElapsedMilliseconds, null); }
            if (code != 0 || !File.Exists(outFile + ".tmp")) { try { File.Delete(outFile + ".tmp"); } catch { } File.WriteAllText(outFile + ".log", log); return new BuildResult(v.Name, false, log, 0, sw.ElapsedMilliseconds, null); }
            File.Move(outFile + ".tmp", outFile, true);
            var bytes = File.ReadAllBytes(outFile);
            File.WriteAllText(outFile + ".log", log.Length > 0 ? log : "ok");
            return new BuildResult(v.Name, true, log, bytes.Length, sw.ElapsedMilliseconds, Digest(bytes));
        }
        // The DXBC container's own checksum: the identity the game's or a mod's tooling may key on.
        public static string Digest(byte[] dxbc) => dxbc.Length >= 20 ? Convert.ToHexString(dxbc, 4, 16) : null;

        // What the project has built: blob names with sizes, digests and the last log.
        public object Built(Project project)
        {
            var dir = BlobFolder(project); if (!Directory.Exists(dir)) return new Dictionary<string, object>();
            var d = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
            foreach (var f in Directory.GetFiles(dir, "*.fpo"))
            {
                var bytes = File.ReadAllBytes(f); var log = f + ".log";
                d[Path.GetFileName(f)] = new { ok = true, size = bytes.Length, digest = Digest(bytes), time = File.GetLastWriteTime(f), log = File.Exists(log) ? File.ReadAllText(log) : "" };
            }
            foreach (var f in Directory.GetFiles(dir, "*.fpo.log"))
            {
                var name = Path.GetFileName(f)[..^4]; if (d.ContainsKey(name)) continue;
                d[name] = new { ok = false, size = 0, digest = (string)null, time = File.GetLastWriteTime(f), log = File.ReadAllText(f) };
            }
            return d;
        }
        public int Discard(Project project, IEnumerable<string> names)
        {
            int n = 0; var dir = BlobFolder(project);
            foreach (var name in names) foreach (var f in new[] { Path.Combine(dir, name), Path.Combine(dir, name + ".log") }) if (File.Exists(f)) { File.Delete(f); n++; }
            return n;
        }

        // ---- packing: the archive with the built blobs in place of the members of the same name ----
        public object Pack(Project project, string targetRoot)
        {
            var sw = Stopwatch.StartNew();
            var source = GameExport.Original(files, Archive, targetRoot) ?? throw new Exception("The shader archive was not found in the game folder");
            var bnd = BND3.Read(File.ReadAllBytes(source));
            var dir = BlobFolder(project);
            var replaced = new List<string>(); var unknown = new List<string>();
            if (Directory.Exists(dir))
                foreach (var f in Directory.GetFiles(dir, "*.fpo"))
                {
                    var name = Path.GetFileName(f);
                    var member = bnd.Files.FirstOrDefault(x => MtdStore.Leaf(x.Name).Equals(name, StringComparison.OrdinalIgnoreCase));
                    if (member == null) { unknown.Add(name); continue; }   // the game would never ask for it
                    member.Bytes = File.ReadAllBytes(f); replaced.Add(name);
                }
            var dest = Path.Combine(targetRoot, Archive);
            GameExport.Backup(dest, source);
            Directory.CreateDirectory(Path.GetDirectoryName(dest));
            File.WriteAllBytes(dest + ".tmp", bnd.Write()); File.Move(dest + ".tmp", dest, true);
            // the digests of what is now in the archive, for tooling that identifies shaders by DXBC checksum
            var digests = Path.Combine(dir, "digests.txt");
            if (Directory.Exists(dir)) File.WriteAllLines(digests, bnd.Files.Where(x => x.Name.EndsWith(".fpo", StringComparison.OrdinalIgnoreCase)).Select(x => $"{Digest(x.Bytes)}\t{MtdStore.Leaf(x.Name)}"));
            return new { file = dest, replaced, unknown, digests = Directory.Exists(dir) ? digests : null, ms = sw.ElapsedMilliseconds };
        }
    }
}
