// DDS headers, the runtime content hash the DSR lighting mod's DLL gives a texture (its texture override
// files are named by it), and the RGBA8 DDS writer for exports.
namespace TextureEditor
{
    // ---- DDS header + the DLL's runtime content hash ----------------------------------------------
    class DdsInfo
    {
        public readonly byte[] Bytes; public readonly int Width, Height, Dxgi, DataOffset; public readonly string Family;
        public string FormatName => Family;
        public DdsInfo(byte[] b)
        {
            Bytes = b;
            if (b.Length < 128 || BitConverter.ToUInt32(b, 0) != 0x20534444) return;
            Height = BitConverter.ToInt32(b, 12); Width = BitConverter.ToInt32(b, 16);
            uint pfFlags = BitConverter.ToUInt32(b, 80), fourCC = BitConverter.ToUInt32(b, 84), rgbBits = BitConverter.ToUInt32(b, 88);
            uint rMask = BitConverter.ToUInt32(b, 92);
            DataOffset = 128;
            string four = System.Text.Encoding.ASCII.GetString(b, 84, 4);
            if ((pfFlags & 4) != 0 && four == "DX10") { Dxgi = BitConverter.ToInt32(b, 128); DataOffset = 148; }
            else if ((pfFlags & 4) != 0)
                Dxgi = four switch { "DXT1" => 71, "DXT2" or "DXT3" => 74, "DXT4" or "DXT5" => 77, "ATI1" or "BC4U" => 80, "ATI2" or "BC5U" => 83, _ => 0 };
            else if (rgbBits == 32) Dxgi = rMask == 0xff ? 28 : 87;
            Family = Dxgi switch
            {
                >= 70 and <= 72 => "BC1", >= 73 and <= 75 => "BC2", >= 76 and <= 78 => "BC3", >= 79 and <= 81 => "BC4", >= 82 and <= 84 => "BC5", >= 97 and <= 99 => "BC7",
                27 or 28 or 29 => "RGBA8", 87 or 91 => "BGRA8", _ => null,
            };
            if (Family == null) Dxgi = 0;
        }
        public int BlockBytes => Family switch { "BC1" or "BC4" => 8, "BC2" or "BC3" or "BC5" or "BC7" => 16, _ => 0 };
        public (int rowBytes, int rows) Layout() => BlockBytes > 0 ? (Math.Max(1, (Width + 3) / 4) * BlockBytes, Math.Max(1, (Height + 3) / 4)) : (Width * 4, Height);
        public byte[] Mip0() { var (rb, rows) = Layout(); var o = new byte[rb * rows]; Buffer.BlockCopy(Bytes, DataOffset, o, 0, o.Length); return o; }
        // The DXGI formats the game may create the texture as (typeless / unorm / srgb).
        public int[] FormatCandidates() => Family switch
        {
            "BC1" => new[] { 70, 71, 72 }, "BC2" => new[] { 73, 74, 75 }, "BC3" => new[] { 76, 77, 78 }, "BC4" => new[] { 79, 80, 81 }, "BC5" => new[] { 82, 83, 84 }, "BC7" => new[] { 97, 98, 99 },
            "RGBA8" => new[] { 27, 28, 29 }, "BGRA8" => new[] { 87, 90, 91 }, _ => Array.Empty<int>(),
        };
    }

    static class RuntimeHash
    {
        // = game_textures.h mix / hashBytes / hashTexture.
        static ulong Mix(ulong h, ulong v) { h ^= v * 0x9E3779B97F4A7C15ul; h = (h << 31) | (h >> 33); return h * 0xC2B2AE3D27D4EB4Ful; }
        static ulong HashBytes(byte[] p, int off, int n, ulong seed)
        {
            ulong a = seed, b = seed ^ 0x165667B19E3779F9ul, c = seed + 0x27D4EB2F165667C5ul, d = seed ^ 0x85EBCA77C2B2AE63ul;
            int i = 0;
            for (; i + 32 <= n; i += 32)
            {
                a = Mix(a, BitConverter.ToUInt64(p, off + i)); b = Mix(b, BitConverter.ToUInt64(p, off + i + 8));
                c = Mix(c, BitConverter.ToUInt64(p, off + i + 16)); d = Mix(d, BitConverter.ToUInt64(p, off + i + 24));
            }
            ulong tail = 0; for (int k = 0; i < n; i++, k++) tail ^= (ulong)p[off + i] << ((k & 7) * 8);
            return Mix(Mix(Mix(Mix(Mix(a, b), c), d), tail), (ulong)n);
        }
        public static ulong[] Candidates(DdsInfo d)
        {
            var (rowBytes, rows) = d.Layout();
            if (d.DataOffset + rowBytes * rows > d.Bytes.Length) return Array.Empty<ulong>();
            return d.FormatCandidates().Select(f =>
            {
                ulong h = Mix(Mix(Mix(0x5D5E7E1A11ul, (ulong)d.Width), (ulong)d.Height), (ulong)f);
                for (int r = 0; r < rows; r++) h = HashBytes(d.Bytes, d.DataOffset + r * rowBytes, rowBytes, h);
                return h | 1;
            }).ToArray();
        }
    }

    static class DdsWriter
    {
        public static byte[] Rgba8WithMips(byte[] rgba, int w, int h)
        {
            var levels = new List<byte[]> { rgba };
            int lw = w, lh = h;
            while (lw > 1 || lh > 1)
            {
                int nw = Math.Max(1, lw / 2), nh = Math.Max(1, lh / 2); var src = levels[^1]; var dst = new byte[nw * nh * 4];
                for (int y = 0; y < nh; y++) for (int x = 0; x < nw; x++) for (int c = 0; c < 4; c++)
                {
                    int x0 = Math.Min(x * 2, lw - 1), x1 = Math.Min(x * 2 + 1, lw - 1), y0 = Math.Min(y * 2, lh - 1), y1 = Math.Min(y * 2 + 1, lh - 1);
                    int s = src[(y0 * lw + x0) * 4 + c] + src[(y0 * lw + x1) * 4 + c] + src[(y1 * lw + x0) * 4 + c] + src[(y1 * lw + x1) * 4 + c];
                    dst[(y * nw + x) * 4 + c] = (byte)((s + 2) / 4);
                }
                levels.Add(dst); lw = nw; lh = nh;
            }
            using var ms = new MemoryStream(); using var bw = new BinaryWriter(ms);
            bw.Write(0x20534444u); bw.Write(124u);
            bw.Write(0x1u | 0x2u | 0x4u | 0x8u | 0x1000u | 0x20000u);   // caps, height, width, pitch, pixelformat, mipcount
            bw.Write((uint)h); bw.Write((uint)w); bw.Write((uint)(w * 4)); bw.Write(0u); bw.Write((uint)levels.Count);
            for (int i = 0; i < 11; i++) bw.Write(0u);
            bw.Write(32u); bw.Write(0x41u); bw.Write(0u); bw.Write(32u);   // pixel format: RGB | alpha, 32 bits
            bw.Write(0x000000FFu); bw.Write(0x0000FF00u); bw.Write(0x00FF0000u); bw.Write(0xFF000000u);
            bw.Write(0x1000u | 0x8u | 0x400000u); bw.Write(0u); bw.Write(0u); bw.Write(0u); bw.Write(0u);
            foreach (var l in levels) bw.Write(l);
            return ms.ToArray();
        }
    }
}
