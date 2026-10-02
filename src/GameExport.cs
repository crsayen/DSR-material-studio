// Writing edits back into the game's own files: a model's archive rebuilt with the project's exported
// textures re-encoded in each texture's original DDS format and mip count. The rebuilt archive goes
// to a target folder in the game's layout (the game folder, a ModEngine2 mod folder or the project
// folder); the original is always read from the game or another mod folder, so a texture whose
// export was removed comes back as the game ships it.
using BCnEncoder.Encoder;
using BCnEncoder.Shared;
using SoulsFormats;

namespace TextureEditor
{
    static class GameExport
    {
        public record Result(List<string> files, List<string> textures, List<string> skipped, long ms);

        public static Result Repack(GameFiles files, Project project, string relative, string targetRoot)
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            var rel = relative.Replace('/', '\\');
            var dest = Path.Combine(targetRoot, rel);
            var source = Original(files, rel, targetRoot) ?? throw new Exception($"{relative}: not found in the game folder or its mods");
            var bnd = BND3.Read(File.ReadAllBytes(source));
            var written = new List<string>(); var replaced = new List<string>(); var skipped = new List<string>();
            var assignments = project.AssignmentsFor(relative);
            foreach (var f in bnd.Files)
            {
                var n = f.Name.ToLowerInvariant();
                if (n.EndsWith(".flver") && assignments.Count > 0)   // materials pointed at other MTDs
                {
                    var flver = FLVER2.Read(f.Bytes); bool any = false;
                    foreach (var mat in flver.Materials)
                        if (assignments.TryGetValue(mat.Name, out var mtd))
                        {
                            var cut = mat.MTD.LastIndexOfAny(new[] { '\\', '/' });
                            mat.MTD = (cut >= 0 ? mat.MTD[..(cut + 1)] : "") + mtd; any = true; replaced.Add($"material {mat.Name} -> {mtd}");
                        }
                    if (any) f.Bytes = flver.Write();
                }
                else if (n.EndsWith(".tpf"))
                {
                    var tpf = TPF.Read(f.Bytes);
                    if (Replace(tpf, project, replaced, skipped)) f.Bytes = tpf.Write();
                }
                else if (n.EndsWith(".chrtpfbhd"))   // a character's textures: header inside the archive, data beside it
                {
                    var bdtRel = Path.Combine(Path.GetDirectoryName(rel), Stem(f.Name) + ".chrtpfbdt");
                    var bdtSource = Original(files, bdtRel, targetRoot); if (bdtSource == null) continue;
                    var bxf = BXF3.Read(f.Bytes, File.ReadAllBytes(bdtSource));
                    bool any = false;
                    foreach (var b in bxf.Files)
                        if (b.Name.ToLowerInvariant().EndsWith(".tpf")) { var tpf = TPF.Read(b.Bytes); if (Replace(tpf, project, replaced, skipped)) { b.Bytes = tpf.Write(); any = true; } }
                    if (any)
                    {
                        bxf.Write(out byte[] bhd, out byte[] bdt); f.Bytes = bhd;
                        var bdtDest = Path.Combine(targetRoot, bdtRel);
                        Backup(bdtDest, bdtSource); WriteBytes(bdtDest, bdt); written.Add(bdtDest);
                    }
                }
            }
            Backup(dest, source);
            Directory.CreateDirectory(Path.GetDirectoryName(dest));
            WriteBytes(dest, bnd.Write());
            written.Add(dest);
            // The material definitions the project edited or added, merged into the game's bundle.
            foreach (var b in files.Mtds().WriteBundles(project, targetRoot)) written.Add(b);
            return new Result(written, replaced, skipped, sw.ElapsedMilliseconds);
        }

        // The untouched file: from any root other than the target, else the backup kept beside the
        // target, else the target itself (backed up before it is overwritten).
        internal static string Original(GameFiles files, string rel, string targetRoot)
        {
            foreach (var r in files.Roots)
            {
                if (SamePath(r, targetRoot)) continue;
                var p = Path.Combine(r, rel); if (File.Exists(p)) return p;
            }
            var dest = Path.Combine(targetRoot, rel);
            if (File.Exists(dest + ".orig")) return dest + ".orig";
            return File.Exists(dest) ? dest : null;
        }
        static bool SamePath(string a, string b) => string.Equals(Path.GetFullPath(a).TrimEnd('\\', '/'), Path.GetFullPath(b).TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase);
        internal static void Backup(string dest, string source) { if (SamePath(dest, source) && !File.Exists(dest + ".orig")) File.Copy(dest, dest + ".orig"); }
        static void WriteBytes(string path, byte[] bytes) { File.WriteAllBytes(path + ".tmp", bytes); File.Move(path + ".tmp", path, true); }
        static string Stem(string p) { var l = p.Split('\\', '/').Last(); var d = l.IndexOf('.'); return d < 0 ? l : l.Substring(0, d); }

        // Replaces every texture of the TPF that the project exports. True when any changed.
        static bool Replace(TPF tpf, Project project, List<string> replaced, List<string> skipped)
        {
            bool changed = false;
            foreach (var tex in tpf.Textures)
            {
                var dds = new DdsInfo(tex.Bytes); if (dds.Dxgi == 0) continue;
                var export = RuntimeHash.Candidates(dds).Select(h => Path.Combine(project.Folder, h.ToString("X16") + ".dds")).FirstOrDefault(File.Exists);
                if (export == null) continue;
                var src = new DdsInfo(File.ReadAllBytes(export));
                if (src.Family != "RGBA8" || src.Width != dds.Width || src.Height != dds.Height) { skipped.Add($"{tex.Name}: the export is {src.Width}x{src.Height} {src.Family ?? "?"}, the texture {dds.Width}x{dds.Height}"); continue; }
                tex.Bytes = Encode(dds, src.Mip0());
                replaced.Add($"{tex.Name} ({dds.Family}, {Math.Max(1, dds.MipCount)} mip{(dds.MipCount == 1 ? "" : "s")})");
                changed = true;
            }
            return changed;
        }

        // The original's header, then its mip levels re-encoded from the RGBA8 pixels.
        static byte[] Encode(DdsInfo o, byte[] rgba)
        {
            var levels = DdsWriter.MipLevels(rgba, o.Width, o.Height, Math.Max(1, o.MipCount));
            using var ms = new MemoryStream();
            ms.Write(o.Bytes, 0, o.DataOffset);
            CompressionFormat? fmt = o.Family switch
            {
                "BC1" => HasCutout(rgba) ? CompressionFormat.Bc1WithAlpha : CompressionFormat.Bc1,
                "BC2" => CompressionFormat.Bc2, "BC3" => CompressionFormat.Bc3, "BC4" => CompressionFormat.Bc4, "BC5" => CompressionFormat.Bc5, "BC7" => CompressionFormat.Bc7,
                _ => null,
            };
            int w = o.Width, h = o.Height;
            foreach (var level in levels)
            {
                if (fmt == null)
                {
                    if (o.Family == "BGRA8") { var b = (byte[])level.Clone(); for (int i = 0; i < b.Length; i += 4) (b[i], b[i + 2]) = (b[i + 2], b[i]); ms.Write(b); }
                    else ms.Write(level);
                }
                else
                {
                    var enc = new BcEncoder();
                    enc.OutputOptions.GenerateMipMaps = false;
                    enc.OutputOptions.Format = fmt.Value;
                    enc.OutputOptions.Quality = CompressionQuality.Balanced;
                    enc.Options.IsParallel = true;
                    ms.Write(enc.EncodeToRawBytes(level, w, h, PixelFormat.Rgba32)[0]);
                }
                w = Math.Max(1, w / 2); h = Math.Max(1, h / 2);
            }
            return ms.ToArray();
        }
        static bool HasCutout(byte[] rgba) { for (int i = 3; i < rgba.Length; i += 4) if (rgba[i] < 128) return true; return false; }
    }
}
