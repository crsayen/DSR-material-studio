// The game's material model (FRPG_Common_ForwardPBL.fxh PackMaterial), expressed as the maps of
// a standard three.js MeshPhysicalMaterial, so the raster view and the path tracer shade exactly
// the same material.
//
// Metalness workflow (g_MaterialWorkflow 0; specular map R roughness, G metal, B dielectric F0 x5,
// A "light power"):
//   linear   = srgb2linear(albedo * vertexColour * lerp(difMul, spcMul, G))
//   diffuse  = A * linear * (1 - G)
//   F0       = A * lerp(B/5 * luminance(spcMul), linear, G)
// Specular workflow (g_MaterialWorkflow 1; RGB specular colour, A gloss... read as roughness by the
// game's PackMaterial):
//   diffuse  = srgb2linear(albedo * difMul),  F0 = srgb2linear(rgb * spcMul),  roughness = A
// three.js: diffuse = base * (1 - metal), F0 = lerp(0.04 * specularColor * specMap, base, metal).
// So: base = A * linear (sRGB-encoded map), metal = G, roughness = R, and the dielectric F0 goes in
// specularColorMap with specularColor = 5 (0.04 x 5 = 0.2, the top of B/5).
import * as THREE from 'three';

// Per-material emission, as a tag in g_SpecularPower (unused by the PBL shaders; the game keeps it
// in a per-draw constant that mods can read): value = 252 + level/64, level 1..63, meaning the
// surface emits its linear diffuse colour times level/4 (0.25 .. 15.75). Exact in float32.
export const EMISSION_TAG_BASE = 252, EMISSION_LEVELS = 63, EMISSION_STEP = 0.25;
export function emissionLevel(specularPower) {
  const v = Number(specularPower);
  if (!(v >= EMISSION_TAG_BASE && v < EMISSION_TAG_BASE + 1)) return 0;
  const level = Math.round((v - EMISSION_TAG_BASE) * 64);
  return Math.abs(v - (EMISSION_TAG_BASE + level / 64)) < 1e-6 && level >= 1 && level <= EMISSION_LEVELS ? level : 0;
}
export const emissionTag = (level) => EMISSION_TAG_BASE + level / 64;
export const emissionStrength = (level) => level * EMISSION_STEP;

export function mtdParams(material) {
  const p = material.params || {};
  const vec = (v, d) => Array.isArray(v) ? v.map(Number) : d;
  const difColor = vec(p.g_DiffuseMapColor, [1, 1, 1]), spcColor = vec(p.g_SpecularMapColor, [1, 1, 1]);
  const difPower = p.g_DiffuseMapColorPower ?? 1, spcPower = p.g_SpecularMapColorPower ?? 1;
  return {
    workflow: p.g_MaterialWorkflow ?? 0,
    workflowDefaulted: p.g_MaterialWorkflow === undefined,
    difMul: difColor.map(c => c * difPower),
    spcMul: spcColor.map(c => c * spcPower),
    alphaTest: (p.g_BlendMode ?? 0) === 1 || /_Alp|_Edge/i.test(material.mtd || ''),
    emission: emissionStrength(emissionLevel(p.g_SpecularPower)),   // radiance = emission x linear diffuse colour
  };
}

const lum = (c) => Math.max(0.2126729 * c[0] + 0.7151522 * c[1] + 0.072175 * c[2], 0.001);

// textures: { albedo, spec, normal } each { pixels (RGBA Uint8), width, height } or null.
// Returns Uint8 RGBA arrays for the three.js maps.
export function bake(textures, prm, opts = {}) {
  const out = {};
  const A = textures.albedo, S = textures.spec, N = textures.normal;
  const sampleSpec = (x, y, w, h) => {   // the spec texel under an albedo texel (sizes may differ)
    if (!S) return null;
    const sx = Math.min(S.width - 1, Math.floor(x * S.width / w)), sy = Math.min(S.height - 1, Math.floor(y * S.height / h));
    return (sy * S.width + sx) * 4;
  };
  if (A) {
    const { width: w, height: h, pixels: a } = A, base = new Uint8ClampedArray(w * h * 4);
    const enc = 1 / 2.2;
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) {
      let metal = 0, power = 1;
      const s = sampleSpec(x, y, w, h);
      if (s !== null && prm.workflow === 0) { metal = S.pixels[s + 1] / 255; power = S.pixels[s + 3] / 255; }
      const pe = Math.pow(power, enc);
      for (let c = 0; c < 3; c++) {
        const mul = prm.workflow === 0 ? prm.difMul[c] + (prm.spcMul[c] - prm.difMul[c]) * metal : prm.difMul[c];
        base[i + c] = a[i + c] * mul * pe;    // sRGB-encoded, as the game's pow(2.2) input
      }
      base[i + 3] = a[i + 3];
    }
    out.base = { pixels: base, width: w, height: h };
  }
  {
    const w = S ? S.width : 4, h = S ? S.height : 4, rm = new Uint8ClampedArray(w * h * 4), f0 = new Uint8ClampedArray(w * h * 4);
    const dl = lum(prm.spcMul);
    for (let i = 0; i < w * h * 4; i += 4) {
      const s = S ? S.pixels : null;
      if (prm.workflow === 0) {
        const r = s ? s[i] : 255, g = s ? s[i + 1] : 0, b = s ? s[i + 2] : 0, a = s ? s[i + 3] : 255;
        rm[i + 1] = r; rm[i + 2] = g; rm[i + 3] = 255;
        const d = Math.min(1, (b / 255) / 5 * dl) * (a / 255);   // dielectric F0, 0..0.2
        f0[i] = f0[i + 1] = f0[i + 2] = d / 0.2 * 255; f0[i + 3] = 255;
      } else {
        rm[i + 1] = s ? s[i + 3] : 255; rm[i + 2] = 0; rm[i + 3] = 255;
        for (let c = 0; c < 3; c++) f0[i + c] = Math.pow(Math.min(1, (s ? s[i + c] : 0) / 255 * prm.spcMul[c]), 2.2) * 255;
        f0[i + 3] = 255;
      }
    }
    out.rm = { pixels: rm, width: w, height: h };
    out.f0 = { pixels: f0, width: w, height: h, scale: prm.workflow === 0 ? 5 : 25 };
  }
  if (N) {
    const { width: w, height: h, pixels: n } = N, o = new Uint8ClampedArray(w * h * 4);
    const fx = opts.flipNormalX ? -1 : 1, fy = opts.flipNormalY ? -1 : 1;
    for (let i = 0; i < w * h * 4; i += 4) {
      let x = (n[i] / 255 * 2 - 1) * fx, y = (n[i + 1] / 255 * 2 - 1) * fy;
      if (opts.swapNormalXY) [x, y] = [y, x];
      const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
      o[i] = (x * .5 + .5) * 255; o[i + 1] = (y * .5 + .5) * 255; o[i + 2] = (z * .5 + .5) * 255; o[i + 3] = 255;
    }
    out.normal = { pixels: o, width: w, height: h };
  }
  return out;
}

export function dataTexture(img, srgb) {
  const t = new THREE.DataTexture(img.pixels, img.width, img.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.flipY = false;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

// Updates a DataTexture in place when the size matches (keeps material bindings), else replaces it.
export function refresh(tex, img, srgb) {
  if (tex && tex.image.width === img.width && tex.image.height === img.height) { tex.image.data.set(img.pixels); tex.needsUpdate = true; return tex; }
  if (tex) tex.dispose();
  return dataTexture({ ...img, pixels: new Uint8ClampedArray(img.pixels) }, srgb);
}
