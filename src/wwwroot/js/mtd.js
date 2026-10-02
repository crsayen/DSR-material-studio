// The material definition (MTD) editor: the right pane while a model material's definition is
// being edited. An MTD names a shader family (the game builds the pixel shader's name from it,
// so only families the game's own definitions use are offered), typed parameters and texture
// slots. Edits are saved to the project as they change (one definition per MTD file name), with
// undo; a model's material can also be pointed at another definition, or at a new copy.

import { emissionLevel, emissionTag, emissionStrength, EMISSION_LEVELS, EMISSION_STEP } from './material.js';

const $ = (id) => document.getElementById(id);

// What the parameters mean (the HemEnv family's, as far as known); `preview` marks the ones the
// viewer's material model uses.
const PARAM_INFO = {
  g_BlendMode: { info: 'How the material is drawn: 0 opaque, 1 alpha test (TexEdge), 2 alpha blend, 3 water, 4 additive, 5 subtractive, 6 multiply', preview: true },
  g_LightingType: { info: '0 none (unlit "Non" shaders), 1 HemDirDifSpcx3, 3 HemEnvDifSpc' },
  g_DiffuseMapColor: { info: 'Multiplies the diffuse map (times g_DiffuseMapColorPower)', preview: true },
  g_DiffuseMapColorPower: { info: 'Scales g_DiffuseMapColor', preview: true },
  g_SpecularMapColor: { info: 'Multiplies the specular map (times g_SpecularMapColorPower); in the metalness workflow its luminance scales the non-metal reflectance', preview: true },
  g_SpecularMapColorPower: { info: 'Scales g_SpecularMapColor', preview: true },
  g_SpecularPower: { info: 'Specular exponent of the old lighting model, unused by the PBL shaders; the game keeps it in a per-draw constant, so it carries per-material tags for mods: 252 + n/64 is the emission tag (see Emission above)' },
  g_MaterialWorkflow: { info: '0 metalness: specular map R roughness, G metalness, B non-metal reflectance, A light power. 1 specular: RGB specular colour, A roughness. Absent = 0', preview: true },
  g_EnvSpcSlotNo: { info: 'Which environment reflection slot the material samples' },
  g_TexScrollType: { info: 'UV scrolling mode (0 none)' }, g_TexScroll_0: { info: 'UV scroll speed, set 0' }, g_TexScroll_1: { info: 'UV scroll speed, set 1' }, g_TexScroll_2: { info: 'UV scroll speed, set 2' },
  g_ShadowPowMul: { info: 'Shadow strength multiplier' },
  g_DetailBump_UVScale: { info: 'Detail normal map tiling' }, g_DetailBump_BumpPower: { info: 'Detail normal map strength' },
  g_IsDepthWriteTrans: { info: 'Transparent materials still write depth' }, g_MaxPntLitNum: { info: 'Point lights the shader is allowed (0, 1, 2 or 4)' },
  g_ParallaxScale: { info: 'Parallax depth for Parallax families (g_Height slot)' }, g_HeightScale: { info: 'Height map scale' },
  g_SubsurfaceStrength: { info: 'Subsurface scattering strength (Subsurf families)' }, g_SubsurfaceTranslucency: { info: 'Subsurface translucency' },
  g_Normal2Alpha_MinAngle: { info: 'NormalToAlpha: angle where the edge fade starts' }, g_Normal2Alpha_MaxAngle: { info: 'NormalToAlpha: angle where it ends' },
  g_FaceGenType: { info: 'Face generation type (characters)' }, g_useHairColor: { info: 'Takes the player hair colour' }, g_IsUnifyTOD_Skin: { info: 'Skin follows the time-of-day tint' }, g_IsNew: { info: 'QLOC flag for remastered materials' },
};
const ENUMS = {
  g_BlendMode: [[0, '0 · Normal'], [1, '1 · TexEdge (alpha test)'], [2, '2 · Blend'], [3, '3 · Water'], [4, '4 · Add'], [5, '5 · Sub'], [6, '6 · Mul'], [7, '7 · AddMul'], [8, '8 · Update'], [9, '9 · InvPaste'], [32, '32 · LSNormal'], [33, '33 · LSTexEdge'], [34, '34 · LSBlend'], [35, '35 · LSWater'], [36, '36 · LSAdd'], [37, '37 · LSSub'], [38, '38 · LSMul'], [39, '39 · LSAddMul'], [40, '40 · LSUpdate'], [41, '41 · LSInvPaste']],
  g_LightingType: [[0, '0 · None'], [1, '1 · HemDirDifSpcx3'], [3, '3 · HemEnvDifSpc']],
};
// The sampler register each texture slot normally has (shaderDataIndex).
const SLOT_REGISTER = { g_Diffuse: 0, g_Specular: 1, g_Bumpmap: 2, g_Diffuse_2: 3, g_Specular_2: 4, g_Bumpmap_2: 5, g_Lightmap: 6, g_Subsurf: 10, g_Height: 10, g_Envmap: 12, g_DetailBumpmap: 15 };
const TYPES = ['Bool', 'Int', 'Int2', 'Float', 'Float2', 'Float3', 'Float4'];
const DIMS = { Bool: 1, Int: 1, Int2: 2, Float: 1, Float2: 2, Float3: 3, Float4: 4 };

export function initMaterialEditor(ctx) {
  const { S, api, el, selectInput, escapeHtml, afterMaterialChange, reloadModel, closeTextureEditor } = ctx;
  const M = { name: null, def: null, material: null, lists: null, hist: null, timer: null };
  const open = () => !$('mtdEditor').hidden;

  async function lists() { return M.lists ??= await (await api('/api/mtd/list')).json(); }
  const family = (def) => (M.lists?.families || []).find(f => f.shaderPath === def.shaderPath);
  const paramsDict = (def) => Object.fromEntries(def.params.map(p => [p.name, p.value]));

  // ---- opening and closing ----
  async function show(mtdName, materialName) {
    closeTextureEditor();
    const d = await (await api('/api/mtd?name=' + encodeURIComponent(mtdName))).json();
    await lists();
    M.name = mtdName; M.def = d; M.material = materialName; M.hist = { undo: [], redo: [], last: JSON.stringify(d), at: 0 };
    $('mtdEditor').hidden = false; $('noEdit').hidden = true;
    render(); updateUndo();
  }
  function close() { $('mtdEditor').hidden = true; M.name = null; M.def = null; }

  // ---- rendering ----
  function render() {
    const d = M.def, fam = family(d);
    $('mtdTitle').textContent = M.name;
    const uses = S.model ? [...new Map(S.model.materials.filter(m => m.mtd === M.name).map(m => [m.name, m])).values()] : [];
    $('mtdInfo').innerHTML = `${{ game: 'The game\'s definition.', edited: '<span class="badge">edited</span> The game\'s definition, changed in this project.', new: '<span class="badge">new</span> A definition of this project.' }[d.source]}`
      + (uses.length ? ` Used by ${uses.map(m => `<b>${escapeHtml(m.name)}</b>${m.reassigned ? ' (assigned)' : ''}`).join(', ')} of this model.` : '')
      + (fam ? `<br>${fam.count} of the game's definitions use this shader family.` : '<br><span class="err">No definition of the game uses this family: the game may not have a shader for it.</span>');
    $('mtdRevert').disabled = d.source === 'game'; $('mtdRevert').textContent = d.source === 'new' ? 'Delete' : 'Revert to game\'s';
    $('mtdRevert').title = d.source === 'new' ? 'Delete this definition from the project' : 'Drop the project\'s changes to this definition';
    // shader family
    const sel = $('mtdFamily'); sel.innerHTML = '';
    for (const f of M.lists.families) sel.add(new Option(`${f.family} (${f.count})`, f.shaderPath));
    if (!fam) sel.add(new Option(d.shaderPath, d.shaderPath));
    sel.value = d.shaderPath;
    sel.onchange = () => { d.shaderPath = sel.value; changed(); };
    $('mtdDesc').value = d.description || ''; $('mtdDesc').oninput = () => { d.description = $('mtdDesc').value; changed(false); };
    renderEmission(); renderParams(); renderTextures();
  }
  // ---- emission: a tag in g_SpecularPower, for mods that light emissive materials ----
  const specPower = (d) => d.params.find(p => p.name === 'g_SpecularPower');
  function renderEmission() {
    const d = M.def, level = emissionLevel(specPower(d)?.value);
    $('mtdEmission').value = level; $('mtdEmissionNum').value = emissionStrength(level);
    $('mtdEmissionOut').textContent = level ? `x ${emissionStrength(level)} of the diffuse colour (tag ${emissionTag(level)})` : 'none';
  }
  function setEmission(level, commit) {
    level = Math.max(0, Math.min(EMISSION_LEVELS, Math.round(level)));
    const d = M.def; let p = specPower(d);
    if (level > 0) { if (!p) { p = { name: 'g_SpecularPower', type: 'Float', value: 0 }; d.params.push(p); } p.value = emissionTag(level); }
    else if (p) {   // back to what the parameter was before the tag
      const orig = (d.original?.params || []).find(x => x.name === 'g_SpecularPower') ?? (family(d)?.params || []).find(x => x.name === 'g_SpecularPower');
      if (orig) p.value = orig.value; else d.params.splice(d.params.indexOf(p), 1);
    }
    renderEmission(); if (commit) changed(); else { recordHistory(true); renderParams(); schedule(); preview(); }
  }
  $('mtdEmission').oninput = () => setEmission(+$('mtdEmission').value, false);
  $('mtdEmission').onchange = () => setEmission(+$('mtdEmission').value, true);
  $('mtdEmissionNum').onchange = () => setEmission((+$('mtdEmissionNum').value || 0) / EMISSION_STEP, true);
  function renderParams() {
    const d = M.def, box = $('mtdParams'); box.innerHTML = '';
    const fam = family(d);
    d.params.forEach((p, i) => {
      const row = el('div', { cls: 'prow' });
      const info = PARAM_INFO[p.name];
      const name = el('div', { cls: 'pname', title: (info?.info || '') + (info?.preview ? '\nShown in the viewer.' : '\nNo effect in the viewer (the game uses it).') }, p.name);
      if (info?.preview) name.append(el('span', { cls: 'badge' }, 'preview'));
      if (p.name === 'g_SpecularPower' && emissionLevel(p.value)) name.append(el('span', { cls: 'badge', title: 'This value is the emission tag' }, 'emission'));
      name.append(el('span', { cls: 'dim small' }, ' ' + p.type.toLowerCase()));
      const del = el('button', { title: 'Remove this parameter' }, '✕'); del.onclick = () => { d.params.splice(i, 1); changed(); };
      row.append(name, valueEditor(p, () => changed(false), () => changed()), del);
      box.append(row);
    });
    if (!d.params.length) box.innerHTML = '<div class="small dim">No parameters.</div>';
    // parameters the family usually has that are missing
    const add = $('mtdAddParam'); add.innerHTML = '';
    const have = new Set(d.params.map(p => p.name));
    for (const p of fam?.params || []) if (!have.has(p.name)) add.add(new Option(`${p.name} (${p.used} of ${fam.count})`, p.name));
    add.add(new Option('custom…', '*'));
  }
  function valueEditor(p, onInput, onCommit) {
    const wrap = el('div', { cls: 'pval' });
    if (p.type === 'Bool') { const c = el('input', { type: 'checkbox' }); c.checked = !!p.value; c.onchange = () => { p.value = c.checked; onCommit(); }; wrap.append(c); return wrap; }
    if (ENUMS[p.name] && p.type === 'Int') {
      const opts = ENUMS[p.name].map(([v, l]) => [String(v), l]); if (!opts.some(([v]) => +v === p.value)) opts.push([String(p.value), String(p.value)]);
      wrap.append(selectInput(opts, String(p.value), v => { p.value = +v; onCommit(); })); return wrap;
    }
    const n = DIMS[p.type], isInt = p.type.startsWith('Int'), arr = n > 1;
    const vals = arr ? [...(p.value || [])] : [p.value ?? 0];
    while (vals.length < n) vals.push(0);
    const inputs = vals.map((v, k) => {
      const inp = el('input', { type: 'number', step: isInt ? '1' : '0.01', cls: 'num' }); inp.value = v;
      inp.oninput = () => { vals[k] = isInt ? Math.round(+inp.value || 0) : +inp.value || 0; p.value = arr ? [...vals] : vals[0]; sync(); onInput(); };
      inp.onchange = () => onCommit();
      return inp;
    });
    wrap.append(...inputs);
    let swatch = null;
    if (p.type === 'Float3' && /Color/i.test(p.name)) {   // a colour picker for 0..1 colours
      swatch = el('input', { type: 'color', title: 'Pick (values above 1 are clamped in the picker only)' });
      swatch.oninput = () => { const h = swatch.value; for (let k = 0; k < 3; k++) { vals[k] = parseInt(h.substr(1 + k * 2, 2), 16) / 255; inputs[k].value = vals[k].toFixed(3); } p.value = [...vals]; onInput(); };
      swatch.onchange = () => onCommit();
      wrap.append(swatch);
    }
    const sync = () => { if (swatch) swatch.value = '#' + vals.slice(0, 3).map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join(''); };
    sync();
    return wrap;
  }
  function renderTextures() {
    const d = M.def, box = $('mtdTextures'); box.innerHTML = '';
    const fam = family(d);
    d.textures.forEach((t, i) => {
      const row = el('div', { cls: 'prow' });
      const usual = SLOT_REGISTER[t.type];
      const name = el('div', { cls: 'pname' }, t.type);
      const uv = el('input', { type: 'number', step: '1', min: '1', cls: 'num', title: 'UV set the slot reads (1 = the first)' }); uv.value = t.uvNumber;
      uv.onchange = () => { t.uvNumber = Math.max(1, Math.round(+uv.value || 1)); changed(); };
      const reg = el('input', { type: 'number', step: '1', min: '0', cls: 'num', title: 'Sampler register (shaderDataIndex)' + (usual !== undefined ? `; this slot is normally s${usual}` : '') }); reg.value = t.shaderDataIndex;
      reg.onchange = () => { t.shaderDataIndex = Math.max(0, Math.round(+reg.value || 0)); changed(); };
      if (usual !== undefined && usual !== t.shaderDataIndex) reg.classList.add('warn');
      const del = el('button', { title: 'Remove this slot' }, '✕'); del.onclick = () => { d.textures.splice(i, 1); changed(); };
      row.append(name, el('div', { cls: 'pval' }, el('span', { cls: 'small dim' }, 'UV '), uv, el('span', { cls: 'small dim' }, ' reg '), reg), del);
      box.append(row);
    });
    if (!d.textures.length) box.innerHTML = '<div class="small dim">No texture slots.</div>';
    const add = $('mtdAddTex'); add.innerHTML = '';
    const have = new Set(d.textures.map(t => t.type));
    const known = new Set((fam?.textures || []).map(t => t.type));
    for (const t of fam?.textures || []) if (!have.has(t.type)) add.add(new Option(`${t.type} (${t.used} of ${fam.count})`, t.type));
    for (const t of Object.keys(SLOT_REGISTER)) if (!have.has(t) && !known.has(t)) add.add(new Option(t, t));
    add.add(new Option('custom…', '*'));
  }

  // ---- edits: history, save, live preview ----
  function changed(full = true) {
    recordHistory(!full);
    if (full) render();
    schedule(); preview();
  }
  function preview() {
    if (!S.model) return;
    const dict = paramsDict(M.def);
    for (const m of S.model.materials) if (m.mtd === M.name) { m.params = dict; m.shader = M.def.shaderPath.split(/[\\/]/).pop(); }
    afterMaterialChange(M.name);
  }
  function schedule() { clearTimeout(M.timer); M.timer = setTimeout(save, 400); $('mtdSaveState').innerHTML = '<span class="dim">Saving…</span>'; }
  async function save() {
    M.timer = null;
    const name = M.name, body = { shaderPath: M.def.shaderPath, description: M.def.description, params: M.def.params, textures: M.def.textures };
    try {
      const d = await (await api('/api/mtd?name=' + encodeURIComponent(name), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
      if (M.name === name) { M.def.source = d.source; M.def.original = d.original; $('mtdSaveState').innerHTML = '<span class="ok">Saved to the project.</span>'; $('mtdInfo').innerHTML.includes('badge') || render(); }
      api('/api/mtd/list').then(r => r.json()).then(l => { M.lists = l; });   // sources changed
    } catch (e) { $('mtdSaveState').innerHTML = `<span class="err">Not saved: ${escapeHtml(e.message.replace(/^[^:]*: \d+ /, ''))}</span>`; }
  }
  function snapshot() { return JSON.stringify({ shaderPath: M.def.shaderPath, description: M.def.description, params: M.def.params, textures: M.def.textures }); }
  function recordHistory(coalesce) {
    const h = M.hist, now = performance.now(), snap = snapshot(); if (snap === h.last) return;
    if (!(coalesce && h.coalescing && now - h.at < 1000)) { h.undo.push(h.last); if (h.undo.length > 200) h.undo.shift(); }
    h.redo = []; h.last = snap; h.at = now; h.coalescing = coalesce; updateUndo();
  }
  function restore(snap) { const v = JSON.parse(snap); Object.assign(M.def, v); M.hist.last = snap; M.hist.coalescing = false; render(); schedule(); preview(); updateUndo(); }
  function undo() { const h = M.hist; if (!h?.undo.length) return; h.redo.push(h.last); restore(h.undo.pop()); }
  function redo() { const h = M.hist; if (!h?.redo.length) return; h.undo.push(h.last); restore(h.redo.pop()); }
  function updateUndo() { $('mtdUndo').disabled = !M.hist?.undo.length; $('mtdRedo').disabled = !M.hist?.redo.length; }
  $('mtdUndo').onclick = undo; $('mtdRedo').onclick = redo;
  addEventListener('keydown', (e) => {
    if (!open() || S.editing) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) && document.activeElement.type !== 'checkbox' && document.activeElement.type !== 'range') return;
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); } else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
  });

  // ---- adding parameters and slots ----
  $('mtdAddParamBtn').onclick = () => {
    const d = M.def, v = $('mtdAddParam').value, fam = family(d);
    let p;
    if (v === '*') {
      const name = prompt('Parameter name (e.g. g_SpecularPower)'); if (!name) return;
      const type = prompt(`Type: ${TYPES.join(', ')}`, 'Float'); if (!type || !TYPES.includes(type)) return;
      p = { name, type, value: DIMS[type] > 1 ? new Array(DIMS[type]).fill(0) : type === 'Bool' ? false : 0 };
    } else { const k = fam.params.find(x => x.name === v); p = { name: k.name, type: k.type, value: structuredClone(k.value) }; }
    d.params.push(p); changed();
  };
  $('mtdAddTexBtn').onclick = () => {
    const d = M.def, v = $('mtdAddTex').value, fam = family(d);
    let t;
    if (v === '*') { const type = prompt('Slot name (e.g. g_Diffuse)'); if (!type) return; t = { type, uvNumber: 1, shaderDataIndex: SLOT_REGISTER[type] ?? 0 }; }
    else { const k = (fam?.textures || []).find(x => x.type === v); t = k ? { type: k.type, uvNumber: k.uvNumber, shaderDataIndex: k.shaderDataIndex } : { type: v, uvNumber: 1, shaderDataIndex: SLOT_REGISTER[v] ?? 0 }; }
    d.textures.push(t); changed();
  };

  // ---- revert / delete, clone, assign ----
  $('mtdRevert').onclick = async () => {
    const d = M.def, name = M.name;
    if (d.source === 'new' && !confirm(`Delete ${name} from the project? Materials assigned to it go back to their own definition.`)) return;
    if (d.source === 'edited' && !confirm(`Drop the project's changes to ${name}?`)) return;
    clearTimeout(M.timer); M.timer = null;
    await api('/api/mtd/revert?name=' + encodeURIComponent(name), { method: 'POST' });
    if (d.source === 'new' && S.model) for (const m of S.model.materials) if (m.mtd === name) await api(`/api/model/assign?model=${encodeURIComponent(S.model.path)}&material=${encodeURIComponent(m.name)}&mtd=`, { method: 'POST' });
    M.lists = null; close();
    await reloadModel();
    if (d.source !== 'new') { const m = S.model?.materials.find(x => x.mtd === name); show(name, m?.name); }
  };
  $('mtdClone').onclick = async () => {
    const stem = M.name.replace(/\.mtd$/i, '');
    const as = prompt('Name of the new definition', stem.replace(/(\[[A-Z]+\])?$/, '_new$1') + '.mtd'); if (!as) return;
    clearTimeout(M.timer); if (M.timer) await save();
    try {
      await api(`/api/mtd/clone?name=${encodeURIComponent(M.name)}&as=${encodeURIComponent(as)}`, { method: 'POST' });
      if (M.material && S.model) await api(`/api/model/assign?model=${encodeURIComponent(S.model.path)}&material=${encodeURIComponent(M.material)}&mtd=${encodeURIComponent(as)}`, { method: 'POST' });
    } catch (e) { alert(e.message.replace(/^[^:]*: \d+ /, '')); return; }
    M.lists = null; const material = M.material; close();
    await reloadModel(); show(as, material);
  };
  $('mtdAssign').onclick = async () => {
    const l = await lists(), ul = $('mpList'), q = $('mpSearch'), material = M.material;
    if (!material || !S.model) return;
    const mat = S.model.materials.find(m => m.name === material);
    const draw = () => {
      const f = q.value.trim().toLowerCase(); ul.innerHTML = '';
      if (mat?.reassigned) { const li = document.createElement('li'); li.innerHTML = `<span>Its own: <b>${escapeHtml(mat.mtdOwn)}</b></span><span class="dim small">clear the assignment</span>`; li.onclick = () => pick(''); ul.append(li); }
      let n = 0;
      for (const m of l.mtds) {
        if (f && !(m.name.toLowerCase().includes(f) || m.family.toLowerCase().includes(f))) continue;
        if (++n > 400) break;
        const li = document.createElement('li'); li.innerHTML = `<span>${escapeHtml(m.name)}${m.source !== 'game' ? ` <span class="badge">${m.source}</span>` : ''}</span><span class="dim small">${escapeHtml(m.family)}</span>`;
        li.onclick = () => pick(m.name); ul.append(li);
      }
      $('mpHint').textContent = `${n > 400 ? '400+' : n} definitions · ${escapeHtml(material)} now uses ${mat?.mtd}`;
    };
    const pick = async (name) => {
      $('mtdPickDialog').close();
      try { await api(`/api/model/assign?model=${encodeURIComponent(S.model.path)}&material=${encodeURIComponent(material)}&mtd=${encodeURIComponent(name)}`, { method: 'POST' }); }
      catch (e) { alert(e.message.replace(/^[^:]*: \d+ /, '')); return; }
      close(); await reloadModel();
      const m2 = S.model.materials.find(m => m.name === material); if (m2) show(m2.mtd, material);
    };
    q.value = ''; q.oninput = draw; draw();
    $('mpCancel').onclick = () => $('mtdPickDialog').close();
    $('mtdPickDialog').showModal(); q.focus();
  };

  return { show, close, isOpen: open };
}
