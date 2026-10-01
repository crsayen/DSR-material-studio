// Parametric edit layers. A texture's result is always recomputed from its original pixels:
// each enabled layer, top to bottom, changes one or more channels where its conditions hold.
// Removing or disabling any layer, however old, leaves the others exactly as they were.
//
// A layer's "where" is a list of conditions, each with its own invert, combined top to bottom
// with AND (the smaller weight) or OR (the larger):
//   value: a channel (or brightness) above / below / between thresholds, with a soft edge whose
//          width and curve are adjustable;
//   faces: faces picked on the model, as the texture area their UVs cover (grown / feathered).
// No conditions: the whole texture.

export const CURVES = { linear: 'Linear', smooth: 'S-curve', log: 'Log (fast start)', exp: 'Exp (slow start)' };

let nextId = 1;
const uid = (p) => p + Date.now().toString(36) + (nextId++);

export function newSelector(kind, over = {}) {
  const base = { id: uid('S'), kind, combine: 'and', invert: false };
  if (kind === 'faces') return { ...base, model: null, faces: {}, uv: [], grow: 2, feather: 0, hidden: false, ...over };
  return { ...base, source: 'g', mode: 'above', lo: 128, hi: 255, soft: 16, curve: 'smooth', from: 'original', ...over };
}

export function newLayer(over = {}) {
  return { id: uid('L'), name: '', enabled: true, target: 'g', op: 'add', amount: 0, selectors: [newSelector('value')], ...over };
}

// Recipes written before conditions were lists had one `select`.
export function migrate(layer) {
  if (!layer.selectors) {
    const s = layer.select || {};
    layer.selectors = s.mode && s.mode !== 'all' ? [newSelector('value', { source: s.source, mode: s.mode, lo: s.lo, hi: s.hi, soft: s.soft, curve: s.curve, from: s.from, invert: !!s.invert })] : [];
    delete layer.select;
  }
  for (const s of layer.selectors) if (!s.id) s.id = uid('S');
  return layer;
}

function curve(kind, x) {
  switch (kind) {
    case 'smooth': return x * x * (3 - 2 * x);
    case 'log': return Math.log(1 + 9 * x) / Math.log(10);
    case 'exp': return (Math.pow(10, x) - 1) / 9;
    default: return x;
  }
}

// Weight (0..1) of a source value v (0..255) for a value condition, before its invert: full past
// the threshold, ramping in over `soft` values on the near side, shaped by the curve.
export function valueWeight(sel, v) {
  const s = Math.max(0, sel.soft);
  const above = (t) => s <= 0 ? (v >= t ? 1 : 0) : curve(sel.curve, Math.min(1, Math.max(0, (v - (t - s)) / s)));
  const below = (t) => s <= 0 ? (v <= t ? 1 : 0) : curve(sel.curve, Math.min(1, Math.max(0, ((t + s) - v) / s)));
  if (sel.mode === 'below') return below(sel.lo);
  if (sel.mode === 'between') return Math.min(above(sel.lo), below(sel.hi));
  return above(sel.lo);
}

const channel = { r: 0, g: 1, b: 2, a: 3 };
function sourceValue(px, i, source) {
  if (source === 'luma') return Math.round(px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722);
  return px[i + channel[source]];
}

// The weight of every pixel for one layer (Float32Array), reading `cur` for conditions that select
// from the result so far. faceMask(sel, w, h) supplies a faces condition's coverage.
function layerWeights(layer, original, cur, w, h, faceMask) {
  const n = w * h, out = new Float32Array(n).fill(1);
  layer.selectors.forEach((sel, k) => {
    let get;
    if (sel.kind === 'faces') { const m = faceMask(sel, w, h); get = (p) => m ? m[p] : 0; }
    else {
      const lut = new Float32Array(256); for (let v = 0; v < 256; v++) lut[v] = valueWeight(sel, v);
      const src = sel.from === 'current' ? cur : original;
      get = (p) => lut[sourceValue(src, p * 4, sel.source)];
    }
    const or = k > 0 && sel.combine === 'or';
    for (let p = 0; p < n; p++) {
      let v = get(p); if (sel.invert) v = 1 - v;
      out[p] = k === 0 ? v : or ? Math.max(out[p], v) : Math.min(out[p], v);
    }
  });
  return out;
}

// original: RGBA bytes. Returns { pixels (Uint8ClampedArray), mask: weights of `maskLayerId` or null }.
export function evaluate(original, layers, w, h, faceMask, maskLayerId = null) {
  const cur = new Uint8ClampedArray(original);
  let mask = null;
  for (const layer of layers) {
    const wantMask = layer.id === maskLayerId;
    if (!layer.enabled && !wantMask) continue;
    const weights = layerWeights(layer, original, cur, w, h, faceMask);
    if (wantMask) mask = weights;
    if (!layer.enabled) continue;
    const tg = layer.target === 'rgb' ? [0, 1, 2] : [channel[layer.target]], amt = layer.amount;
    for (let p = 0, i = 0; p < weights.length; p++, i += 4) {
      const wt = weights[p]; if (wt <= 0) continue;
      for (const c of tg) {
        const x = cur[i + c];
        cur[i + c] = layer.op === 'add' ? x + amt * wt : layer.op === 'scale' ? x * (1 + (amt - 1) * wt) : x + (amt - x) * wt;
      }
    }
  }
  return { pixels: cur, mask };
}

export function histogram(px, source) {
  const h = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) h[sourceValue(px, i, source)]++;
  return h;
}

const TN = { r: 'R', g: 'G', b: 'B', a: 'A', rgb: 'RGB', luma: 'brightness' };
export function describeSelector(s) {
  if (s.kind === 'faces') {
    const n = Object.values(s.faces || {}).reduce((a, f) => a + f.length, 0) || s.uv.length / 6;
    return `${s.invert ? 'not ' : ''}${n} picked face${n === 1 ? '' : 's'}`;
  }
  const where = s.mode === 'above' ? `${TN[s.source]} ≥ ${s.lo}` : s.mode === 'below' ? `${TN[s.source]} ≤ ${s.lo}` : `${s.lo} ≤ ${TN[s.source]} ≤ ${s.hi}`;
  return `${s.invert ? 'not ' : ''}${where}${s.soft > 0 ? ` (soft ${s.soft})` : ''}`;
}
export function describe(layer) {
  const what = layer.op === 'add' ? `${TN[layer.target]} ${layer.amount >= 0 ? '+' : ''}${Math.round(layer.amount)}`
    : layer.op === 'scale' ? `${TN[layer.target]} ×${(+layer.amount).toFixed(2)}` : `${TN[layer.target]} → ${Math.round(layer.amount)}`;
  if (!layer.selectors.length) return `${what} everywhere`;
  return `${what} where ` + layer.selectors.map((s, k) => (k ? (s.combine === 'or' ? ' or ' : ' and ') : '') + describeSelector(s)).join('');
}
