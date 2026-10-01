import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { newLayer, newSelector, migrate, evaluate, histogram, valueWeight, describe, describeSelector, CURVES } from './layers.js';
import { mtdParams, bake, dataTexture, refresh } from './material.js';
import { PRESETS } from './env.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree; THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree; THREE.Mesh.prototype.raycast = acceleratedRaycast;

const $ = (id) => document.getElementById(id);
const api = async (url, opts) => { const r = await fetch(url, opts); if (!r.ok) throw new Error(`${url}: ${r.status} ${await r.text()}`); return r; };

// ------------------------------------------------------------------ renderer, scene
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 200);
camera.position.set(0, 1.4, 3);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = false;
const pmrem = new THREE.PMREMGenerator(renderer);
const pathTracer = new WebGLPathTracer(renderer);
pathTracer.bounces = 6; pathTracer.filterGlossyFactor = 0.5; pathTracer.renderDelay = 0; pathTracer.minSamples = 1;
pathTracer.textureSize.set(2048, 2048);

const S = {
  mode: 'raster', view: 'lit', preset: 'studio', model: null, modelGroup: null, presetGroup: null,
  env: null, envPmrem: null, textures: new Map(), groups: [], editing: null, selectedLayer: null,
  chanView: 'rgb', showMask: true, normalOpts: { flipNormalX: false, flipNormalY: false, swapNormalXY: false },
};

let lastSize = '';
function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  const key = `${Math.round(r.width)}x${Math.round(r.height)}`; if (key === lastSize) return; lastSize = key;   // only real size changes reset the path tracer
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(1, r.height); camera.updateProjectionMatrix();
  if (S.mode === 'path') pathTracer.updateCamera();
}
new ResizeObserver(resize).observe(canvas.parentElement);

controls.addEventListener('change', () => { if (S.mode === 'path') pathTracer.updateCamera(); });

let ptDirty = false;   // the path tracer's scene needs rebuilding
function frame() {
  requestAnimationFrame(frame);
  controls.update();
  if (S.mode === 'path' && S.modelGroup) {
    if (ptDirty) { ptDirty = false; pathTracer.setScene(scene, camera); }
    pathTracer.renderSample();
    $('samples').textContent = `${Math.floor(pathTracer.samples)} samples`;
  } else {
    renderer.render(scene, camera);
    $('samples').textContent = '';
  }
}
requestAnimationFrame(frame);

// ------------------------------------------------------------------ lighting
for (const [k, p] of Object.entries(PRESETS)) $('preset').add(new Option(p.label, k));
function applyPreset() {
  const p = PRESETS[S.preset];
  if (S.env) S.env.dispose(); if (S.envPmrem) S.envPmrem.dispose();
  S.env = p.env();
  if (S.presetGroup) { scene.remove(S.presetGroup); S.presetGroup = null; }
  if (p.objects && S.modelGroup) {
    S.presetGroup = p.objects(new THREE.Box3().setFromObject(S.modelGroup));
    scene.add(S.presetGroup);
    // Raster reflections of the emitters: a probe of them over the dark environment.
    const probe = new THREE.Scene(); probe.background = S.env;
    for (const o of S.presetGroup.children) if (o.userData.emitter) { const c = o.clone(); probe.add(c); }
    const centre = new THREE.Box3().setFromObject(S.modelGroup).getCenter(new THREE.Vector3());
    probe.position.sub(centre);
    S.envPmrem = pmrem.fromScene(probe, 0.02);
  } else S.envPmrem = pmrem.fromEquirectangular(S.env);
  applyMode();
}
function applyEnvRotation() {
  const r = THREE.MathUtils.degToRad(+$('envRot').value);
  scene.environmentRotation.set(0, r, 0); scene.backgroundRotation.set(0, r, 0);
  if (S.presetGroup) { const c = new THREE.Box3().setFromObject(S.modelGroup).getCenter(new THREE.Vector3()); S.presetGroup.position.set(0, 0, 0); S.presetGroup.rotation.set(0, 0, 0);
    S.presetGroup.position.sub(c).applyAxisAngle(new THREE.Vector3(0, 1, 0), r).add(c); S.presetGroup.rotation.y = r; }
  if (S.mode === 'path') { pathTracer.updateEnvironment(); ptDirty = true; }
}
function applyMode() {
  const path = S.mode === 'path';
  scene.environment = path ? S.env : S.envPmrem?.texture ?? S.env;
  scene.background = $('showBg').checked ? (path ? S.env : S.env) : new THREE.Color(0x101214);
  scene.backgroundBlurriness = path ? 0 : 0.35;
  if (S.presetGroup) for (const o of S.presetGroup.children) if (o.userData.rasterOnly) o.visible = !path;
  setView(path ? 'lit' : S.view);
  $('viewMode').disabled = path;
  if (path && S.faceMode) setFaceMode(null);
  if (typeof updateFaceOverlay === 'function' && S.editing) updateFaceOverlay();
  if (path) { pathTracer.updateEnvironment(); ptDirty = true; }
}
$('preset').onchange = () => { S.preset = $('preset').value; applyPreset(); applyEnvRotation(); };
$('envRot').oninput = applyEnvRotation;
$('exposure').oninput = () => { renderer.toneMappingExposure = Math.pow(2, +$('exposure').value); $('exposureOut').textContent = (+$('exposure').value).toFixed(1); if (S.mode === 'path') pathTracer.reset(); };
$('showBg').onchange = applyMode;
for (const b of $('renderMode').querySelectorAll('button')) b.onclick = () => {
  S.mode = b.dataset.v; for (const x of $('renderMode').querySelectorAll('button')) x.classList.toggle('on', x === b); applyMode();
};

// ------------------------------------------------------------------ debug views (raster)
const viewChannel = { rough: 1, metal: 2, f0: 0 };
function channelMaterial(tex, ch, scale = 1) {
  return new THREE.ShaderMaterial({
    uniforms: { t: { value: tex }, ch: { value: ch }, scale: { value: scale } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
    fragmentShader: 'uniform sampler2D t; uniform int ch; uniform float scale; varying vec2 vUv; void main(){ vec4 c = texture2D(t, vUv); gl_FragColor = vec4(ch < 0 ? c.rgb : vec3(c[ch] * scale), 1.); }',
  });
}
function setView(v) {
  for (const g of S.groups) for (const m of g.meshes) {
    if (v === 'lit') m.material = g.material;
    else if (v === 'base') m.material = g.views.base ??= new THREE.MeshBasicMaterial({ map: g.maps.base, vertexColors: true });
    else if (v === 'normal') m.material = g.views.normal ??= (g.maps.normal ? channelMaterial(g.maps.normal, -1) : new THREE.MeshBasicMaterial({ color: 0x8080ff }));
    else { const tex = v === 'f0' ? g.maps.f0 : g.maps.rm; m.material = g.views[v] ??= channelMaterial(tex, viewChannel[v], 1); }
  }
}
$('viewMode').onchange = () => { S.view = $('viewMode').value; setView(S.view); };

// ------------------------------------------------------------------ models
let allModels = [];
async function loadModels() {
  allModels = await (await api('/api/models')).json();
  renderModelList();
}
function renderModelList() {
  const q = $('modelSearch').value.trim().toLowerCase(), cats = new Set([...document.querySelectorAll('.cat:checked')].map(c => c.value));
  const ul = $('modelList'); ul.innerHTML = '';
  let shown = 0;
  for (const m of allModels) {
    if (!cats.has(m.category) || (q && !m.name.toLowerCase().includes(q))) continue;
    if (++shown > 400) break;
    const li = document.createElement('li'); li.innerHTML = `<span>${m.name}</span><span class="dim small">${m.category}</span>`;
    li.onclick = () => { for (const x of ul.children) x.classList.remove('on'); li.classList.add('on'); openModel(m.path); };
    if (S.model?.path === m.path) li.classList.add('on');
    ul.appendChild(li);
  }
}
$('modelSearch').oninput = renderModelList;
for (const c of document.querySelectorAll('.cat')) c.onchange = renderModelList;

const f32 = (b64) => { const s = atob(b64), b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return new Float32Array(b.buffer); };
const u32 = (b64) => { const s = atob(b64), b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return new Uint32Array(b.buffer); };

function buildGeometry(m) {
  const pos = f32(m.position), nrm = f32(m.normal), tan = f32(m.tangent), bin = f32(m.bitangent), uv = f32(m.uv), col = f32(m.color);
  let idx = u32(m.index);
  const n = pos.length / 3;
  // The game is left-handed: mirror X into three.js's right-handed space.
  for (let i = 0; i < n; i++) { pos[i * 3] *= -1; nrm[i * 3] *= -1; tan[i * 4] *= -1; bin[i * 3] *= -1; }
  // Front faces: whichever winding agrees with the vertex normals.
  let agree = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    agree += Math.sign(fx * (nrm[a] + nrm[b] + nrm[c]) + fy * (nrm[a + 1] + nrm[b + 1] + nrm[c + 1]) + fz * (nrm[a + 2] + nrm[b + 2] + nrm[c + 2]));
  }
  if (agree < 0) { idx = idx.slice(); for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]]; }
  // The game's normal map: normal = binormal * x + tangent * y + normal * z (FRPG_Common.fxh).
  // three.js: tangent * x + (cross(normal, tangent) * w) * y. So three's tangent is the game's
  // binormal, with w chosen so the cross product gives the game's tangent.
  const t4 = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const N = new THREE.Vector3(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]), B = new THREE.Vector3(bin[i * 3], bin[i * 3 + 1], bin[i * 3 + 2]), T = new THREE.Vector3(tan[i * 4], tan[i * 4 + 1], tan[i * 4 + 2]);
    const w = new THREE.Vector3().crossVectors(N, B).dot(T) >= 0 ? 1 : -1;
    t4[i * 4] = B.x; t4[i * 4 + 1] = B.y; t4[i * 4 + 2] = B.z; t4[i * 4 + 3] = w;
  }
  // Vertex colour multiplies the albedo before the game's pow(2.2): linear = colour^2.2.
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) col[i * 4 + c] = Math.pow(Math.max(0, col[i * 4 + c]), 2.2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('tangent', new THREE.BufferAttribute(t4, 4));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

const roleOf = (param) => /Diffuse/i.test(param) ? 'albedo' : /Specular/i.test(param) ? 'spec' : /Bump/i.test(param) && !/Detail/i.test(param) ? 'normal' : null;

async function loadTexture(info) {
  if (S.textures.has(info.id)) return S.textures.get(info.id);
  const buf = new Uint8Array(await (await api('/api/texture?id=' + encodeURIComponent(info.id))).arrayBuffer());
  let layers = [], dirty = false;
  try {
    const r = await (await api('/api/recipe?key=' + encodeURIComponent(info.recipe))).json();
    if (r && r.layers) { layers = r.layers.map(migrate); dirty = layers.length > 0 && (!r.exported || (r.edited && r.edited > r.exported)); }
  } catch { }
  const t = { info, original: buf, width: info.width, height: info.height, layers, edited: null, mask: null, dirty, users: new Set() };
  t.edited = evaluate(t.original, t.layers, t.width, t.height, faceMask).pixels;
  S.textures.set(info.id, t);
  return t;
}

async function openModel(path) {
  $('loading').hidden = false;
  try {
    const model = await (await api('/api/model?path=' + encodeURIComponent(path))).json();
    if (S.modelGroup) { scene.remove(S.modelGroup); S.modelGroup.traverse(o => o.geometry?.dispose()); }
    for (const g of S.groups) { g.material.dispose(); for (const v of Object.values(g.views)) v.dispose?.(); for (const m of Object.values(g.maps)) m?.dispose?.(); }
    setFaceMode(null); S.groups = []; S.textures.clear(); S.editing = null; S.selectedLayer = null; S.activeSel = null; showEditor();
    S.model = model;
    // Materials with the same textures and parameters share one three.js material.
    const groupsByKey = new Map(), matGroup = [];
    for (const mat of model.materials) {
      const tex = {};
      for (const t of mat.textures) { const r = roleOf(t.param); if (r && t.texture && !tex[r]) tex[r] = t.texture; }
      const prm = mtdParams(mat);
      const key = JSON.stringify([tex.albedo?.id, tex.spec?.id, tex.normal?.id, prm]);
      let g = groupsByKey.get(key);
      if (!g) {
        g = { key, prm, tex: {}, maps: {}, views: {}, meshes: [], materials: [] };
        for (const r of ['albedo', 'spec', 'normal']) if (tex[r]) { g.tex[r] = await loadTexture(tex[r]); g.tex[r].users.add(g); }
        groupsByKey.set(key, g); S.groups.push(g);
        g.material = new THREE.MeshPhysicalMaterial({ roughness: 1, metalness: 1, specularIntensity: 1, ior: 1.5, vertexColors: true,
          alphaTest: prm.alphaTest ? 0.5 : 0, side: prm.alphaTest ? THREE.DoubleSide : THREE.FrontSide });
        rebake(g);
      }
      g.materials.push(mat); matGroup.push(g);
    }
    const group = new THREE.Group();
    model.meshes.forEach((m, i) => {
      const g = matGroup[m.material]; if (!g) return;
      const geo = buildGeometry(m); geo.computeBoundsTree({ indirect: true });   // keep the triangle order: picked faces are stored by index
      const mesh = new THREE.Mesh(geo, g.material); mesh.userData.meshIndex = i; g.meshes.push(mesh); group.add(mesh);
    });
    S.modelGroup = group; scene.add(group);
    const box = new THREE.Box3().setFromObject(group), c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.y, size.z);
    controls.target.copy(c); camera.position.copy(c).add(new THREE.Vector3(0, r * .15, r * 2.4)); camera.near = r / 100; camera.far = r * 100; camera.updateProjectionMatrix();
    controls.update();
    $('modelName').textContent = path.split('/').pop();
    renderMaterials();
    applyPreset(); applyEnvRotation();
    setView(S.mode === 'path' ? 'lit' : S.view);
    ptDirty = true;
    refreshState();   // the project lists the model now
  } catch (e) { alert(e.message); console.error(e); }
  finally { $('loading').hidden = true; }
}

// The game material -> three.js maps for one group; `changed` limits the work to what a texture edit touches.
function rebake(g, changed = null) {
  const img = (t) => t ? { pixels: t.edited, width: t.width, height: t.height } : null;
  const needBase = !changed || changed === g.tex.albedo || changed === g.tex.spec;
  const needSpec = !changed || changed === g.tex.spec;
  const needNormal = !changed || changed === g.tex.normal;
  const b = bake({ albedo: needBase ? img(g.tex.albedo) : null, spec: img(g.tex.spec), normal: needNormal ? img(g.tex.normal) : null }, g.prm, S.normalOpts);
  const m = g.material;
  if (needBase && b.base) m.map = g.maps.base = refresh(g.maps.base, b.base, true);
  if (needSpec) {
    m.roughnessMap = m.metalnessMap = g.maps.rm = refresh(g.maps.rm, b.rm, false);
    m.specularColorMap = g.maps.f0 = refresh(g.maps.f0, b.f0, false);
    m.specularColor = new THREE.Color(b.f0.scale, b.f0.scale, b.f0.scale);
  }
  if (needNormal && b.normal) { m.normalMap = g.maps.normal = refresh(g.maps.normal, b.normal, false); }
  if (!g.tex.albedo) m.color.set(0x808080);
  m.needsUpdate = true;
  for (const k of Object.keys(g.views)) { g.views[k].dispose?.(); delete g.views[k]; }
  updateMaskOverlay(g);
}

// The selected layer's region, magenta, on the model.
function updateMaskOverlay(g) {
  const t = S.editing, m = g.material;
  const on = S.showMask && t && t.mask && (g.tex.albedo === t || g.tex.spec === t || g.tex.normal === t);
  if (!on) { if (m.emissiveMap) { m.emissiveMap = null; m.emissiveIntensity = 0; m.needsUpdate = true; } return; }
  const px = new Uint8ClampedArray(t.width * t.height * 4);
  for (let i = 0; i < t.mask.length; i++) { const v = t.mask[i] * 255; px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v; px[i * 4 + 3] = 255; }
  g.maps.mask = refresh(g.maps.mask, { pixels: px, width: t.width, height: t.height }, false);
  if (m.emissiveMap !== g.maps.mask) { m.emissiveMap = g.maps.mask; m.needsUpdate = true; }
  m.emissive.setRGB(0.9, 0.1, 0.85); m.emissiveIntensity = 0.6;
}

function renderMaterials() {
  $('materialsSection').hidden = false;
  const box = $('materials'); box.innerHTML = '';
  const seen = new Set();
  for (const g of S.groups) for (const mat of g.materials) {
    const sig = mat.name + '|' + mat.mtd; if (seen.has(sig)) continue; seen.add(sig);
    const d = document.createElement('div'); d.className = 'material';
    const wf = g.prm.workflow === 0 ? 'metalness' : 'specular';
    d.innerHTML = `<div><b>${mat.name}</b></div><div class="mtd">${mat.mtd} · ${wf} workflow${g.prm.workflowDefaulted ? ' (assumed)' : ''}</div>`;
    for (const t of mat.textures) {
      const r = roleOf(t.param), row = document.createElement('div'); row.className = 'tex';
      const tt = t.texture && S.textures.get(t.texture.id);
      if (S.editing && tt === S.editing) row.classList.add('editing');
      const badges = tt ? (tt.layers.length ? `<span class="badge">${tt.layers.length} layer${tt.layers.length > 1 ? 's' : ''}</span>` : '') + (tt.info.exported ? `<span class="badge ${tt.dirty ? 'warn' : ''}">${tt.dirty ? 'export outdated' : 'exported'}</span>` : '') : '';
      row.innerHTML = `<span>${t.param.replace('g_', '')}: ${t.name}${badges}</span>`;
      if (tt && r) { const b = document.createElement('button'); b.textContent = 'Edit'; b.onclick = () => openEditor(tt, r, g.prm); row.appendChild(b); }
      else if (!t.texture) row.innerHTML += '<span class="dim small">not found</span>';
      d.appendChild(row);
    }
    box.appendChild(d);
  }
}

// ------------------------------------------------------------------ editor
const SEMANTICS = {
  spec0: { r: 'Roughness', g: 'Metalness', b: 'Non-metal reflectance', a: 'Light power' },
  spec1: { r: 'Specular R', g: 'Specular G', b: 'Specular B', a: 'Roughness' },
  albedo: { r: 'Red', g: 'Green', b: 'Blue', a: 'Alpha (cut-out)' },
  normal: { r: 'Normal X', g: 'Normal Y', b: '(unused)', a: '(unused)' },
};
function semanticsFor(role, prm) { return role === 'spec' ? (prm.workflow === 0 ? SEMANTICS.spec0 : SEMANTICS.spec1) : SEMANTICS[role]; }
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const channelOptions = (withLuma) => ['r', 'g', 'b', 'a'].map(c => [c, `${c.toUpperCase()} · ${S.editing.sem[c]}`]).concat(withLuma ? [['luma', 'Brightness (RGB)']] : []);

function openEditor(t, role, prm) {
  setFaceMode(null);
  S.editing = t; t.role = role; t.sem = semanticsFor(role, prm);
  S.selectedLayer = t.layers[t.layers.length - 1]?.id ?? null;
  S.activeSel = layer()?.selectors[0]?.id ?? null;
  $('texTitle').textContent = t.info.name;
  $('texInfo').innerHTML = `${t.width}×${t.height} ${t.info.format} · ${t.info.source}<br>game ids ${t.info.hashes.join(' ')}`;
  $('channelLegend').innerHTML = ['r', 'g', 'b', 'a'].map(c => `<span><b>${c.toUpperCase()}</b> ${t.sem[c]}</span>`).join('');
  $('lTarget').innerHTML = ''; for (const [v, l] of channelOptions(false)) $('lTarget').add(new Option(l, v)); $('lTarget').add(new Option('RGB together', 'rgb'));
  if (!t.hist) initHistory(t);
  showEditor(); recompute(); renderMaterials(); updateUndoButtons();
}
function showEditor() {
  $('editor').hidden = !S.editing; $('noEdit').hidden = !!S.editing;
  if (!S.editing) return;
  renderLayers(); renderLayerForm(); updateSaveState();
}

function renderLayers() {
  const t = S.editing, ol = $('layers'); ol.innerHTML = '';
  $('noLayers').hidden = t.layers.length > 0;
  t.layers.forEach((L, i) => {
    const li = document.createElement('li'); if (L.id === S.selectedLayer) li.classList.add('on'); if (!L.enabled) li.classList.add('off');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = L.enabled; cb.title = 'On / off';
    cb.onclick = (e) => { e.stopPropagation(); L.enabled = cb.checked; changed(); };
    const what = document.createElement('div'); what.className = 'what'; what.innerHTML = (L.name ? `<b>${escapeHtml(L.name)}</b>` : '') + escapeHtml(describe(L));
    const tools = document.createElement('span'); tools.className = 'tools';
    const btn = (label, title, fn) => { const b = document.createElement('button'); b.textContent = label; b.title = title; b.onclick = (e) => { e.stopPropagation(); fn(); }; tools.appendChild(b); };
    btn('↑', 'Move up (applied earlier)', () => { if (i > 0) { [t.layers[i - 1], t.layers[i]] = [t.layers[i], t.layers[i - 1]]; changed(); } });
    btn('↓', 'Move down (applied later)', () => { if (i < t.layers.length - 1) { [t.layers[i + 1], t.layers[i]] = [t.layers[i], t.layers[i + 1]]; changed(); } });
    btn('⧉', 'Duplicate', () => { const c = structuredClone(L); c.id = newLayer().id; for (const s of c.selectors) s.id = newSelector(s.kind).id; t.layers.splice(i + 1, 0, c); selectLayer(c.id); changed(); });
    btn('✕', 'Delete this layer (the others stay as they are)', () => { t.layers.splice(i, 1); if (S.selectedLayer === L.id) selectLayer(t.layers[Math.min(i, t.layers.length - 1)]?.id ?? null); changed(); });
    li.append(cb, what, tools);
    li.onclick = () => { selectLayer(L.id); renderLayers(); renderLayerForm(); recompute(); };
    ol.appendChild(li);
  });
}
function selectLayer(id) { S.selectedLayer = id; S.activeSel = layer()?.selectors[0]?.id ?? null; setFaceMode(null); }

$('addLayer').onclick = () => {
  const t = S.editing; if (!t) return;
  const metal = t.role === 'spec' && t.sem.g === 'Metalness';
  const L = newLayer(metal ? {} : { target: 'r', selectors: [newSelector('value', { source: 'r' })] });
  t.layers.push(L); selectLayer(L.id); changed();
};

function layer() { return S.editing?.layers.find(l => l.id === S.selectedLayer) ?? null; }
function activeSelector() { return layer()?.selectors.find(s => s.id === S.activeSel) ?? null; }

function amountRange(L) {
  if (L.op === 'add') return { min: -255, max: 255, step: 1, label: 'Raise / lower' };
  if (L.op === 'scale') return { min: 0, max: 4, step: 0.01, label: 'Factor' };
  return { min: 0, max: 255, step: 1, label: 'Value' };
}
function renderLayerForm() {
  const L = layer(); $('layerForm').hidden = !L; if (!L) return;
  const r = amountRange(L);
  $('lName').value = L.name; $('lTarget').value = L.target; $('lOp').value = L.op;
  for (const id of ['lAmount', 'lAmountNum']) Object.assign($(id), { min: r.min, max: r.max, step: r.step });
  $('lAmount').value = $('lAmountNum').value = L.amount; $('lAmountLabel').textContent = r.label;
  renderSelectors();
  $('layerSummary').textContent = describe(L);
}
function bindNum(rangeId, numId, set) {
  const apply = (v) => { const L = layer(); if (!L) return; set(L, +v); $(rangeId).value = $(numId).value = v; changed(false); };
  $(rangeId).oninput = () => apply($(rangeId).value); $(numId).onchange = () => apply($(numId).value);
}
bindNum('lAmount', 'lAmountNum', (L, v) => L.amount = v);
$('lName').oninput = () => { const L = layer(); if (L) { L.name = $('lName').value; changed(false); } };
$('lTarget').onchange = () => { const L = layer(); if (L) { L.target = $('lTarget').value; changed(); } };
$('lOp').onchange = () => { const L = layer(); if (!L) return; L.op = $('lOp').value; L.amount = L.op === 'scale' ? 1 : L.op === 'set' ? 128 : 0; changed(); };

// ---- conditions ("where") ----
$('addValueSel').onclick = () => { const L = layer(); if (!L) return; const s = newSelector('value', { source: L.target === 'rgb' ? 'luma' : L.target }); L.selectors.push(s); S.activeSel = s.id; changed(); };
$('addFaceSel').onclick = () => { const L = layer(); if (!L) return; const s = newSelector('faces', { model: S.model?.path }); L.selectors.push(s); S.activeSel = s.id; changed(); setFaceMode(s.id); };

function el(tag, attrs = {}, ...kids) { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k.startsWith('on')) e[k] = v; else if (k === 'cls') e.className = v; else e.setAttribute(k, v); } for (const k of kids) e.append(k); return e; }
function selectInput(options, value, onchange) { const s = el('select'); for (const [v, l] of options) s.add(new Option(l, v)); s.value = value; s.onchange = () => onchange(s.value); return s; }
function sliderRow(min, max, step, value, oninput) {
  const r = el('input', { type: 'range', min, max, step }), n = el('input', { type: 'number', min, max, step, cls: 'num' });
  r.value = n.value = value;
  r.oninput = () => { n.value = r.value; oninput(+r.value); }; n.onchange = () => { r.value = n.value; oninput(+n.value); };
  return el('div', { cls: 'row' }, r, n);
}

function renderSelectors() {
  const L = layer(), box = $('selectors'); box.innerHTML = '';
  $('everywhere').hidden = L.selectors.length > 0;
  L.selectors.forEach((s, k) => {
    const card = el('div', { cls: 'selcard' + (s.id === S.activeSel ? ' active' : '') });
    const desc = el('span', { cls: 'desc' }); desc.textContent = describeSelector(s);
    const head = el('div', { cls: 'head' });
    if (k > 0) head.append(selectInput([['and', 'and'], ['or', 'or']], s.combine, v => { s.combine = v; changed(); }));
    const inv = el('input', { type: 'checkbox', title: 'Invert this condition' }); inv.checked = s.invert;
    inv.onclick = (e) => { e.stopPropagation(); s.invert = inv.checked; changed(); };
    const del = el('button', { title: 'Remove this condition' }, '✕');
    del.onclick = (e) => { e.stopPropagation(); L.selectors.splice(k, 1); if (S.faceMode === s.id) setFaceMode(null); if (S.activeSel === s.id) S.activeSel = L.selectors[0]?.id ?? null; changed(); };
    head.append(desc, el('label', { cls: 'small', title: 'Invert this condition' }, inv, ' invert'), del);
    head.onclick = (e) => { if (e.target.tagName === 'SELECT') return; if (S.activeSel !== s.id) { S.activeSel = s.id; if (S.faceMode && S.faceMode !== s.id) setFaceMode(null); renderSelectors(); drawHistogram(); updateFaceOverlay(); } };
    card.append(head);
    if (s.id === S.activeSel) card.append(s.kind === 'faces' ? facesBody(s, desc) : valueBody(s, desc));
    box.append(card);
  });
  updateFaceOverlay();
}
function valueBody(s, desc) {
  const upd = (full) => { desc.textContent = describeSelector(s); changed(full); };
  const g = el('div', { cls: 'grid' });
  g.append(el('label', {}, 'Select by'), selectInput(channelOptions(true), s.source, v => { s.source = v; upd(true); }));
  g.append(el('label', {}, 'Region'), selectInput([['above', 'At or above'], ['below', 'At or below'], ['between', 'Between']], s.mode, v => { s.mode = v; upd(true); }));
  g.append(el('label', {}, s.mode === 'between' ? 'Lower' : 'Threshold'), sliderRow(0, 255, 1, s.lo, v => { s.lo = v; upd(false); }));
  if (s.mode === 'between') g.append(el('label', {}, 'Upper'), sliderRow(0, 255, 1, s.hi, v => { s.hi = v; upd(false); }));
  g.append(el('label', {}, 'Soft edge'), sliderRow(0, 255, 1, s.soft, v => { s.soft = v; upd(false); }));
  g.append(el('label', {}, 'Edge curve'), selectInput(Object.entries(CURVES), s.curve, v => { s.curve = v; upd(true); }));
  const from = el('input', { type: 'checkbox' }); from.checked = s.from === 'current'; from.onchange = () => { s.from = from.checked ? 'current' : 'original'; upd(true); };
  g.append(el('label', {}, 'Source'), el('label', { cls: 'small' }, from, ' the result of the layers above (not the original)'));
  return g;
}
function facesBody(s, desc) {
  const upd = (full) => { desc.textContent = describeSelector(s); bumpFaces(s); changed(full); };
  const g = el('div', { cls: 'grid' });
  const pick = el('button', { cls: S.faceMode === s.id ? 'on' : '' }, S.faceMode === s.id ? 'Picking… (Esc: done)' : 'Pick faces on the model');
  pick.onclick = () => setFaceMode(S.faceMode === s.id ? null : s.id);
  const clear = el('button', {}, 'Clear'); clear.onclick = () => { s.faces = {}; s.uv = []; upd(true); };
  g.append(el('label', {}, 'Faces'), el('div', { cls: 'row' }, pick, clear));
  g.append(el('label', {}, 'Grow (px)'), sliderRow(0, 16, 1, s.grow, v => { s.grow = v; upd(false); }));
  g.append(el('label', {}, 'Feather (px)'), sliderRow(0, 64, 1, s.feather, v => { s.feather = v; upd(false); }));
  const hid = el('input', { type: 'checkbox' }); hid.checked = s.hidden; hid.onchange = () => { s.hidden = hid.checked; };
  g.append(el('label', {}, 'Box select'), el('label', { cls: 'small' }, hid, ' include faces hidden behind others'));
  const note = el('div', { cls: 'small dim' });
  note.textContent = 'The condition covers the texture area under the picked faces (mirrored parts that share that area are included).' + (s.model && S.model && s.model !== S.model.path ? ` Picked on ${s.model}.` : '');
  g.append(el('span'), note);
  return g;
}

// ---- faces: texture coverage of picked faces ----
const faceVersions = new WeakMap(), faceCache = new Map();
function bumpFaces(s) { faceVersions.set(s, (faceVersions.get(s) || 0) + 1); }
function faceMask(s, w, h) {
  const key = `${w}x${h}|${s.grow}|${s.feather}|${s.uv.length}|${faceVersions.get(s) || 0}`;
  const hit = faceCache.get(s.id); if (hit && hit.key === key) return hit.mask;
  const a = document.createElement('canvas'); a.width = w; a.height = h;
  const cx = a.getContext('2d'); cx.fillStyle = cx.strokeStyle = '#fff'; cx.lineJoin = 'round'; cx.lineWidth = s.grow * 2;
  for (let i = 0; i + 5 < s.uv.length; i += 6) {
    const ou = Math.floor(Math.min(s.uv[i], s.uv[i + 2], s.uv[i + 4])), ov = Math.floor(Math.min(s.uv[i + 1], s.uv[i + 3], s.uv[i + 5]));   // tiled UVs: into 0..1
    cx.beginPath();
    for (let j = 0; j < 3; j++) { const x = (s.uv[i + j * 2] - ou) * w, y = (s.uv[i + j * 2 + 1] - ov) * h; j ? cx.lineTo(x, y) : cx.moveTo(x, y); }
    cx.closePath(); cx.fill(); if (s.grow > 0) cx.stroke();
  }
  let src = a;
  if (s.feather > 0) { const b = document.createElement('canvas'); b.width = w; b.height = h; const bx = b.getContext('2d'); bx.filter = `blur(${s.feather / 2}px)`; bx.drawImage(a, 0, 0); src = b; }
  const d = src.getContext('2d').getImageData(0, 0, w, h).data, mask = new Float32Array(w * h);
  for (let p = 0; p < mask.length; p++) mask[p] = d[p * 4] / 255;
  faceCache.set(s.id, { key, mask });
  return mask;
}

// Meshes whose material uses the texture being edited: the ones faces can be picked on.
function editableMeshes() { const t = S.editing; return t ? S.groups.filter(g => t.users.has(g)).flatMap(g => g.meshes) : []; }
function allMeshes() { return S.groups.flatMap(g => g.meshes); }

function setFaceMode(id) {
  S.faceMode = id;
  $('viewport').classList.toggle('picking', !!id); $('faceHelp').hidden = !id;
  controls.mouseButtons = id ? { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE } : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  if (id && S.mode === 'path') document.querySelector('#renderMode button[data-v=raster]').click();
  if (layer()) renderSelectors();
}
addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.faceMode) setFaceMode(null); });

function rebuildUv(s) {
  const uv = [];
  for (const m of allMeshes()) {
    const tris = s.faces[m.userData.meshIndex]; if (!tris || !tris.length) continue;
    const ix = m.geometry.index.array, u = m.geometry.attributes.uv.array;
    for (const t of tris) for (let j = 0; j < 3; j++) { const v = ix[t * 3 + j]; uv.push(+u[v * 2].toFixed(5), +u[v * 2 + 1].toFixed(5)); }
  }
  s.uv = uv; s.model = S.model?.path; bumpFaces(s);
}
function applyFaces(s, picked, op) {
  if (op === 'replace') s.faces = {};
  for (const [mesh, t] of picked) {
    const list = new Set(s.faces[mesh] || []);
    op === 'remove' ? list.delete(t) : list.add(t);
    s.faces[mesh] = [...list].sort((a, b) => a - b);
    if (!s.faces[mesh].length) delete s.faces[mesh];
  }
  rebuildUv(s); changed(true);
}

const raycaster = new THREE.Raycaster(); raycaster.firstHitOnly = true;
const FACE_HELP = 'Picking faces · click: select · shift: add · ctrl: remove · drag: box · right-drag: orbit · Esc: done';
let helpTimer = 0;
function flashHelp(msg) { $('faceHelp').textContent = msg; clearTimeout(helpTimer); helpTimer = setTimeout(() => { $('faceHelp').textContent = FACE_HELP; }, 1500); }
function ndc(x, y) { const r = canvas.getBoundingClientRect(); return new THREE.Vector2((x - r.left) / r.width * 2 - 1, -(y - r.top) / r.height * 2 + 1); }
function pickFace(x, y) {
  raycaster.setFromCamera(ndc(x, y), camera);
  const hit = raycaster.intersectObjects(allMeshes(), false)[0];
  if (hit && !editableMeshes().includes(hit.object)) { flashHelp('That face uses a different texture.'); return []; }
  if (!hit) return [];
  return [[hit.object.userData.meshIndex, hit.faceIndex]];
}
function boxFaces(a, b, hidden) {
  const lo = new THREE.Vector2(Math.min(a.x, b.x), Math.min(a.y, b.y)), hi = new THREE.Vector2(Math.max(a.x, b.x), Math.max(a.y, b.y));
  const out = [], c = new THREE.Vector3(), p = new THREE.Vector3(), all = allMeshes(), rc = new THREE.Raycaster(); rc.firstHitOnly = true;
  for (const m of editableMeshes()) {
    const ix = m.geometry.index.array, pos = m.geometry.attributes.position.array;
    for (let t = 0; t < ix.length / 3; t++) {
      c.set(0, 0, 0);
      for (let j = 0; j < 3; j++) { const v = ix[t * 3 + j] * 3; c.x += pos[v]; c.y += pos[v + 1]; c.z += pos[v + 2]; }
      c.multiplyScalar(1 / 3);
      p.copy(c).project(camera);
      if (p.z > 1 || p.x < lo.x || p.x > hi.x || p.y < lo.y || p.y > hi.y) continue;
      if (!hidden) {   // only faces whose centre the camera sees
        const dir = c.clone().sub(camera.position), dist = dir.length(); rc.set(camera.position, dir.normalize()); rc.far = dist * 1.001;
        const h = rc.intersectObjects(all, false)[0];
        if (h && !(h.object === m && h.faceIndex === t) && h.distance < dist * 0.999) continue;
      }
      out.push([m.userData.meshIndex, t]);
    }
  }
  return out;
}
{
  let start = null;
  canvas.addEventListener('pointerdown', (e) => { if (!S.faceMode || e.button !== 0) return; start = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (!start) return;
    const r = $('viewport').getBoundingClientRect(), box = $('selectBox');
    box.hidden = Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4;
    Object.assign(box.style, { left: Math.min(start.x, e.clientX) - r.left + 'px', top: Math.min(start.y, e.clientY) - r.top + 'px', width: Math.abs(e.clientX - start.x) + 'px', height: Math.abs(e.clientY - start.y) + 'px' });
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!start) return;
    const s = activeSelector(), op = e.shiftKey ? 'add' : (e.ctrlKey || e.altKey) ? 'remove' : 'replace';
    const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y) >= 4;
    if (s && s.kind === 'faces') applyFaces(s, moved ? boxFaces(ndc(start.x, start.y), ndc(e.clientX, e.clientY), s.hidden) : pickFace(e.clientX, e.clientY), op);
    start = null; $('selectBox').hidden = true;
  });
}

// Picked faces of the active faces condition, highlighted on the model.
let faceOverlay = null;
function updateFaceOverlay() {
  if (faceOverlay) { scene.remove(faceOverlay); faceOverlay.geometry.dispose(); faceOverlay = null; }
  const s = activeSelector(); if (!s || s.kind !== 'faces' || S.mode === 'path') return;
  const pts = [];
  for (const m of allMeshes()) {
    const tris = s.faces[m.userData.meshIndex]; if (!tris) continue;
    const ix = m.geometry.index.array, pos = m.geometry.attributes.position.array;
    for (const t of tris) for (let j = 0; j < 3; j++) { const v = ix[t * 3 + j] * 3; pts.push(pos[v], pos[v + 1], pos[v + 2]); }
  }
  if (!pts.length) return;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  faceOverlay = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: s.invert ? 0x50a0ff : 0xffa030, transparent: true, opacity: .45, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  faceOverlay.renderOrder = 2; scene.add(faceOverlay);
}

// ---- undo / redo: snapshots of the edited texture's layers (faces, conditions, everything) ----
// Every change is a step, except that a run of slider drags or typing (changed(false)) within a
// second of each other is one step. Each texture keeps its own history while the model is open.
function snapshot(t) { return JSON.stringify({ layers: t.layers, sel: S.selectedLayer, act: S.activeSel }); }
function initHistory(t) { t.hist = { undo: [], redo: [], last: snapshot(t), lastLayers: JSON.stringify(t.layers), at: 0, coalescing: false }; }
function recordHistory(t, coalesce) {
  if (!t.hist) initHistory(t);
  const h = t.hist, layersJson = JSON.stringify(t.layers);
  if (layersJson === h.lastLayers) return;
  const now = performance.now();
  if (!(coalesce && h.coalescing && now - h.at < 1000)) { h.undo.push(h.last); if (h.undo.length > 500) h.undo.shift(); }
  h.redo = []; h.last = snapshot(t); h.lastLayers = layersJson; h.at = now; h.coalescing = coalesce;
  updateUndoButtons();
}
function restore(t, snap) {
  const v = JSON.parse(snap), h = t.hist;
  t.layers = v.layers.map(migrate);
  S.selectedLayer = t.layers.some(l => l.id === v.sel) ? v.sel : t.layers[t.layers.length - 1]?.id ?? null;
  S.activeSel = layer()?.selectors.some(x => x.id === v.act) ? v.act : layer()?.selectors[0]?.id ?? null;
  faceCache.clear();
  h.last = snapshot(t); h.lastLayers = JSON.stringify(t.layers); h.coalescing = false;
  t.dirty = true;
  renderLayers(); renderLayerForm(); scheduleSave(t); recompute(); updateSaveState(); renderMaterials(); updateUndoButtons();
}
function undo() { const t = S.editing; if (!t?.hist?.undo.length) return; recordHistory(t, false); t.hist.redo.push(snapshot(t)); restore(t, t.hist.undo.pop()); }
function redo() { const t = S.editing; if (!t?.hist?.redo.length) return; t.hist.undo.push(snapshot(t)); restore(t, t.hist.redo.pop()); }
function updateUndoButtons() {
  const h = S.editing?.hist;
  $('undoBtn').disabled = !h?.undo.length; $('redoBtn').disabled = !h?.redo.length;
  $('undoBtn').title = `Undo (Ctrl+Z)${h?.undo.length ? ` · ${h.undo.length} step${h.undo.length > 1 ? 's' : ''}` : ''}`;
  $('redoBtn').title = `Redo (Ctrl+Shift+Z or Ctrl+Y)${h?.redo.length ? ` · ${h.redo.length} step${h.redo.length > 1 ? 's' : ''}` : ''}`;
}
$('undoBtn').onclick = undo; $('redoBtn').onclick = redo;
addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || !S.editing) return;
  const a = document.activeElement;   // text fields keep their own undo
  if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['range', 'checkbox'].includes(a.type)))) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
});

// A layer changed: re-render the list/form (full) or just recompute (while dragging).
function changed(full = true) {
  const t = S.editing; if (!t) return;
  t.dirty = true;
  recordHistory(t, !full);
  if (full) { renderLayers(); renderLayerForm(); }
  else { renderLayers(); $('layerSummary').textContent = layer() ? describe(layer()) : ''; }
  scheduleSave(t); recompute(); updateSaveState(); renderMaterials();
}

let pending = false;
function recompute() {
  if (pending) return; pending = true;
  requestAnimationFrame(() => {
    pending = false;
    const t = S.editing; if (!t) return;
    const r = evaluate(t.original, t.layers, t.width, t.height, faceMask, S.selectedLayer);
    t.edited = r.pixels; t.mask = S.showMask ? r.mask : null;
    for (const g of t.users) rebake(g, t);
    if (S.mode === 'path') { pathTracer.updateMaterials(); pathTracer.reset(); }
    draw2d(); drawHistogram();
  });
}

// ------------------------------------------------------------------ 2D texture + histogram
const off = document.createElement('canvas');
function draw2d() {
  const t = S.editing; if (!t) return;
  off.width = t.width; off.height = t.height;
  const ctx = off.getContext('2d'), img = ctx.createImageData(t.width, t.height), d = img.data, e = t.edited, m = t.mask;
  const ch = { r: 0, g: 1, b: 2, a: 3 }[S.chanView];
  for (let i = 0, p = 0; i < e.length; i += 4, p++) {
    let r, g, b;
    if (ch === undefined) { r = e[i]; g = e[i + 1]; b = e[i + 2]; } else r = g = b = e[i + ch];
    if (m && S.showMask) { const w = m[p] * .55; r = r + (230 - r) * w; g = g + (30 - g) * w; b = b + (220 - b) * w; }
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const c = $('tex2d'), cx = c.getContext('2d'); cx.fillStyle = '#0d0f11'; cx.fillRect(0, 0, c.width, c.height);
  const sc = Math.min(c.width / t.width, c.height / t.height), w = t.width * sc, h = t.height * sc;
  cx.imageSmoothingQuality = 'high'; cx.drawImage(off, (c.width - w) / 2, (c.height - h) / 2, w, h);
}
function drawHistogram() {
  const L = layer(), s = activeSelector(), c = $('histogram'), cx = c.getContext('2d'), W = c.width, H = c.height;
  c.hidden = !s || s.kind !== 'value';
  cx.fillStyle = '#0d0f11'; cx.fillRect(0, 0, W, H);
  if (c.hidden) return;
  const t = S.editing, src = s.from === 'current' ? evaluate(t.original, t.layers.slice(0, t.layers.indexOf(L)), t.width, t.height, faceMask).pixels : t.original;
  const h = histogram(src, s.source); let max = 1; for (const v of h) max = Math.max(max, Math.log1p(v));
  cx.fillStyle = '#5a6470';
  for (let v = 0; v < 256; v++) { const bh = Math.log1p(h[v]) / max * (H - 14); cx.fillRect(v / 256 * W, H - 12 - bh, W / 256 + .5, bh); }
  cx.strokeStyle = '#fff'; cx.lineWidth = 1.5; cx.beginPath();
  for (let v = 0; v < 256; v++) { let wv = valueWeight(s, v); if (s.invert) wv = 1 - wv; const y = H - 12 - wv * (H - 16); v ? cx.lineTo((v + .5) / 256 * W, y) : cx.moveTo(.5 / 256 * W, y); }
  cx.stroke();
  cx.fillStyle = '#8a929c'; cx.font = '10px system-ui'; cx.fillText('0', 2, H - 2); cx.fillText('255', W - 20, H - 2);
  cx.fillStyle = '#e0a24a'; cx.fillRect((s.lo + .5) / 256 * W - .5, 0, 1, H - 12);
  if (s.mode === 'between') cx.fillRect((s.hi + .5) / 256 * W - .5, 0, 1, H - 12);
}
$('histogram').onclick = (e) => {
  const s = activeSelector(); if (!s || s.kind !== 'value') return;
  const r = $('histogram').getBoundingClientRect(), v = Math.max(0, Math.min(255, Math.round((e.clientX - r.left) / r.width * 256 - .5)));
  if (e.shiftKey) { s.hi = v; s.mode = 'between'; } else s.lo = v;
  changed();
};
for (const b of $('chanView').querySelectorAll('button')) b.onclick = () => { S.chanView = b.dataset.v; for (const x of $('chanView').querySelectorAll('button')) x.classList.toggle('on', x === b); draw2d(); };
$('showMask').onchange = () => { S.showMask = $('showMask').checked; recompute(); if (!S.showMask) for (const g of S.groups) updateMaskOverlay(g); };

// ------------------------------------------------------------------ saving, export
// Layers are saved to the project as they change; Export writes the textures.
function updateSaveState() {
  const t = S.editing, el = $('saveState'); if (!t) return;
  const noProject = !S.state?.project;
  $('writeGame').disabled = noProject; $('revertGame').disabled = noProject || !t.info.exported;
  if (noProject) el.innerHTML = '<span class="unsaved">Not saved.</span> Create or open a project to keep these edits and export them.';
  else if (t.dirty) el.innerHTML = '<span class="unsaved">Not exported yet.</span> The layers are saved in the project; Export writes the texture.';
  else if (t.info.exported) el.innerHTML = '<span class="ok">Exported</span> to the project folder.';
  else el.innerHTML = '<span class="dim">Not exported: the original texture.</span>';
}
const saveTimers = new Map();
function scheduleSave(t) {
  if (!S.state?.project) return;
  clearTimeout(saveTimers.get(t)); saveTimers.set(t, setTimeout(() => saveLayers(t), 400));
}
async function saveLayers(t) {
  saveTimers.delete(t);
  try { await api('/api/recipe?id=' + encodeURIComponent(t.info.id), { method: 'POST', body: JSON.stringify({ layers: t.layers }) }); }
  catch (e) { $('saveState').innerHTML = `<span class="err">Could not save: ${escapeHtml(e.message)}</span>`; }
}
$('writeGame').onclick = async () => {
  const t = S.editing; if (!t) return;
  $('writeGame').disabled = true;
  try {
    if (saveTimers.has(t)) { clearTimeout(saveTimers.get(t)); await saveLayers(t); }
    if (t.layers.length === 0) { await api('/api/unexport?id=' + encodeURIComponent(t.info.id), { method: 'POST' }); t.info.exported = false; }
    else { const r = await (await api(`/api/export?id=${encodeURIComponent(t.info.id)}&width=${t.width}&height=${t.height}`, { method: 'POST', body: t.edited })).json(); t.info.exported = r.written.length > 0; }
    t.dirty = false;
  } catch (e) { $('saveState').innerHTML = `<span class="err">${escapeHtml(e.message)}</span>`; $('writeGame').disabled = false; return; }
  updateSaveState(); renderMaterials(); refreshState();
};
$('revertGame').onclick = async () => {
  const t = S.editing; if (!t) return;
  await api('/api/unexport?id=' + encodeURIComponent(t.info.id), { method: 'POST' });
  t.info.exported = false; t.dirty = t.layers.length > 0; updateSaveState(); renderMaterials(); refreshState();
};

// ------------------------------------------------------------------ project and game folder
// "3 minutes ago", "yesterday", or the date.
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) { const m = Math.round(s / 60); return `${m} minute${m === 1 ? '' : 's'} ago`; }
  if (s < 86400) { const h = Math.round(s / 3600); return `${h} hour${h === 1 ? '' : 's'} ago`; }
  const d = Math.round(s / 86400);
  return d === 1 ? 'yesterday' : d < 14 ? `${d} days ago` : new Date(iso).toLocaleDateString();
}
async function refreshState() {
  S.state = await (await api('/api/state')).json();
  const st = S.state, p = st.project;
  $('closeProject').hidden = !p;
  $('projectInfo').innerHTML = p
    ? `<b>${escapeHtml(p.name)}</b> · ${p.textures.length} texture${p.textures.length === 1 ? '' : 's'} edited<div class="path">${escapeHtml(p.folder)}</div>`
    : '<span class="dim">No project: edits are not saved. New… picks the game install and a project folder.</span>';
  const ul = $('projectModels'); ul.innerHTML = '';
  for (const m of p?.models ?? []) {
    const li = document.createElement('li'); li.innerHTML = `<span>${escapeHtml(m.split('/').pop())}</span><span class="dim small">${escapeHtml(m.split('/')[0])}</span>`;
    li.title = 'Reopen'; li.onclick = () => openModel(m); if (S.model?.path === m) li.classList.add('on'); ul.appendChild(li);
  }
  $('gameInfo').innerHTML = `${st.game.ok ? '' : '<span class="err">Not a Dark Souls Remastered folder. </span>'}<div class="path">${escapeHtml(st.game.folder || '(none)')}</div>`
    + `<label class="small"><input id="useMods" type="checkbox" ${st.game.useMods ? 'checked' : ''}> through its ModEngine2 mods</label>`
    + (st.game.fromProject ? '<div class="small dim">This project\'s install.</div>' : '<div class="small dim">Default install (no project open).</div>');
  $('useMods').onchange = () => setGame(st.game.folder, $('useMods').checked);
  $('searchOrder').innerHTML = st.game.searchOrder.map(r => `<li>${escapeHtml(r)}</li>`).join('');
  if (S.editing) updateSaveState();
}
async function setGame(folder, useMods) {
  try { await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gameFolder: folder, useMods }) }); }
  catch (e) { alert(e.message); }
  await afterSwitch();
}
// The game files or the project changed: start over with no model.
async function afterSwitch() {
  closeModel(); await refreshState(); await loadModels();
}
function closeModel() {
  setFaceMode(null);
  if (S.modelGroup) { scene.remove(S.modelGroup); S.modelGroup.traverse(o => o.geometry?.dispose()); S.modelGroup = null; }
  if (S.presetGroup) { scene.remove(S.presetGroup); S.presetGroup = null; }
  S.groups = []; S.textures.clear(); S.editing = null; S.model = null; $('materialsSection').hidden = true; showEditor();
}
$('changeGame').onclick = async () => {
  const f = await pickFolder({ title: 'Game folder (Dark Souls Remastered)', start: S.state.game.folder, want: 'game' });
  if (f) setGame(f, S.state.game.useMods);
};
$('closeProject').onclick = async () => { await api('/api/project/close', { method: 'POST' }); afterSwitch(); };
$('newProject').onclick = () => {
  const st = S.state;
  $('npGame').value = st.project ? st.game.folder : st.defaultGame.folder; $('npMods').checked = st.project ? st.game.useMods : st.defaultGame.useMods;
  $('npFolder').value = ''; $('npError').textContent = '';
  $('newProjectDialog').showModal();
};
$('npGameBrowse').onclick = async () => { const f = await pickFolder({ title: 'Game folder (Dark Souls Remastered)', start: $('npGame').value, want: 'game' }); if (f) $('npGame').value = f; };
$('npFolderBrowse').onclick = async () => { const f = await pickFolder({ title: 'Project folder', start: $('npFolder').value || $('npGame').value, want: 'newProject' }); if (f) $('npFolder').value = f; };
$('npCancel').onclick = () => $('newProjectDialog').close();
$('npCreate').onclick = async () => {
  $('npError').textContent = '';
  if (!$('npFolder').value.trim()) { $('npError').textContent = 'Choose a project folder.'; return; }
  try {
    const q = new URLSearchParams({ folder: $('npFolder').value.trim(), gameFolder: $('npGame').value.trim(), useMods: $('npMods').checked });
    await api('/api/project/create?' + q, { method: 'POST' });
  } catch (e) { $('npError').textContent = e.message.replace(/^[^:]*: \d+ /, ''); return; }
  $('newProjectDialog').close(); afterSwitch();
};
async function openProject(folder) {
  try { await api('/api/project/open?folder=' + encodeURIComponent(folder), { method: 'POST' }); } catch (e) { alert(e.message.replace(/^[^:]*: \d+ /, '')); return; }
  $('openProjectDialog').close(); await afterSwitch();
  const last = S.state.project?.models?.[0]; if (last) openModel(last);
}
$('openProject').onclick = () => {
  const ul = $('recentProjects'); ul.innerHTML = '';
  for (const r of S.state.recent) {
    const li = document.createElement('li'); li.className = 'recent';
    li.innerHTML = `<div class="row between"><b>${escapeHtml(r.name)}</b><span class="dim small">${escapeHtml(ago(r.modified))}</span></div>`
      + `<div class="small dim">${r.textures} texture${r.textures === 1 ? '' : 's'} edited, ${r.exported} exported</div><div class="path small">${escapeHtml(r.folder)}</div>`;
    li.title = `Last edited ${new Date(r.modified).toLocaleString()}\nGame: ${r.game ?? '?'}`;
    li.onclick = () => openProject(r.folder); ul.appendChild(li);
  }
  if (!S.state.recent.length) ul.innerHTML = '<li class="dim">No recent projects.</li>';
  $('openProjectDialog').showModal();
};
$('opCancel').onclick = () => $('openProjectDialog').close();
$('opBrowse').onclick = async () => { const f = await pickFolder({ title: 'Project folder (with texture-editor.project.json)', start: S.state.recent[0]?.folder || '', want: 'project' }); if (f) openProject(f); };

// want: 'game' (a game install), 'project' (has a project file), 'newProject' (no project file yet).
// In the app's window this is the system's folder dialog; in a browser (--serve) the page's own
// browser of the server's file system, since the page cannot see real paths.
async function pickFolder({ title, start, want }) {
  if (!S.state?.native) return browseFolder({ title, start, want });
  const r = await (await api(`/api/fs/pick?title=${encodeURIComponent(title)}&start=${encodeURIComponent(start || '')}`)).json();
  if (!r.path) return null;
  const info = await (await api('/api/fs/list?path=' + encodeURIComponent(r.path))).json();
  if (want === 'game' && !info.isGame) { alert(`${r.path}\n\nis not a Dark Souls Remastered folder (no DarkSoulsRemastered.exe).`); return null; }
  if (want === 'project' && !info.hasProject) { alert(`${r.path}\n\nhas no project file (texture-editor.project.json).`); return null; }
  if (want === 'newProject' && info.hasProject) { alert(`${r.path}\n\nalready has a project: use Open… instead.`); return null; }
  return r.path;
}
function browseFolder({ title, start, want }) {
  return new Promise((resolve) => {
    const dlg = $('folderDialog'); $('fdTitle').textContent = title;
    let cur = null;
    const hints = { game: 'Pick the folder with DarkSoulsRemastered.exe.', project: 'Pick a folder with texture-editor.project.json.', newProject: 'Pick an empty folder, or make one with New folder.' };
    $('fdHint').textContent = hints[want] || '';
    const show = async (path) => {
      cur = await (await api('/api/fs/list?path=' + encodeURIComponent(path || ''))).json();
      $('fdPath').value = cur.path;
      $('fdDrives').innerHTML = ''; for (const d of cur.drives) { const b = document.createElement('button'); b.textContent = d; b.onclick = () => show(d); $('fdDrives').append(b); }
      const ul = $('fdList'); ul.innerHTML = '';
      for (const d of cur.dirs) {
        const li = document.createElement('li'); li.className = 'dir'; li.textContent = d;
        li.onclick = () => show(cur.path.replace(/[\\/]$/, '') + '\\' + d); ul.appendChild(li);
      }
      if (!cur.path) ul.innerHTML = '<li class="dim">Pick a drive.</li>';
      let note = '', ok = !!cur.path;
      if (cur.error) { note = `<span class="err">${escapeHtml(cur.error)}</span>`; ok = false; }
      else if (want === 'game') { note = cur.isGame ? '<span class="ok">This is a Dark Souls Remastered folder.</span>' : '<span class="dim">Not a game folder (no DarkSoulsRemastered.exe).</span>'; ok = cur.isGame; }
      else if (want === 'project') { note = cur.hasProject ? '<span class="ok">This folder has a project.</span>' : '<span class="dim">No project file here.</span>'; ok = cur.hasProject; }
      else if (want === 'newProject' && cur.hasProject) { note = '<span class="err">This folder already has a project: use Open… instead.</span>'; ok = false; }
      $('fdNote').innerHTML = note; $('fdOk').disabled = !ok; $('fdUp').disabled = !cur.parent && !cur.path;
    };
    $('fdUp').onclick = () => show(cur.parent || '');
    $('fdPath').onkeydown = (e) => { if (e.key === 'Enter') show($('fdPath').value.trim()); };
    $('fdNew').onclick = async () => {
      if (!cur?.path) return;
      const name = prompt('New folder name'); if (!name) return;
      try { cur = await (await api('/api/fs/mkdir?path=' + encodeURIComponent(cur.path.replace(/[\\/]$/, '') + '\\' + name), { method: 'POST' })).json(); show(cur.path); }
      catch (e) { alert(e.message); }
    };
    const done = (v) => { dlg.close(); resolve(v); };
    $('fdOk').onclick = () => done(cur?.path || null);
    $('fdCancel').onclick = () => done(null);
    dlg.oncancel = (e) => { e.preventDefault(); done(null); };
    dlg.showModal(); show(start);
  });
}

// ------------------------------------------------------------------ display settings
for (const [id, k] of [['flipNX', 'flipNormalX'], ['flipNY', 'flipNormalY'], ['swapNXY', 'swapNormalXY']])
  $(id).onchange = () => { S.normalOpts[k] = $(id).checked; for (const g of S.groups) if (g.tex.normal) rebake(g, g.tex.normal); if (S.mode === 'path') { pathTracer.updateMaterials(); pathTracer.reset(); } };

S.preset = 'studio'; $('preset').value = 'studio';
applyPreset();
refreshState().then(() => { loadModels(); const last = S.state.project?.models?.[0]; if (last) openModel(last); });
window.S = S; window.pathTracer = pathTracer; window.editor = { scene, camera, renderer };   // for debugging in the console
