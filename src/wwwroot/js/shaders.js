// The shader workbench: an overlay with the HLSL sources (edited in place), the archive's pixel
// shader variants with their build rules, building with fxc, and packing the built shaders into a
// copy of the archive for a mod folder.

const $ = (id) => document.getElementById(id);

export function initShaderWorkbench(ctx) {
  const { api, el, escapeHtml, pickFolder, exportTargets } = ctx;
  const W = { state: null, file: null, text: null, saved: null, selected: new Set(), filter: '', family: '', onlyBuildable: true, building: false };

  // ---- opening ----
  async function open() {
    $('shaderBench').hidden = false;
    await refresh();
  }
  function close() { $('shaderBench').hidden = true; }
  $('shadersOpen').onclick = open;
  $('sbClose').onclick = close;
  addEventListener('keydown', (e) => {
    if ($('shaderBench').hidden) return;
    if (e.key === 'Escape' && document.activeElement !== $('sbEditor')) close();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); }
  });
  async function refresh() {
    W.state = await (await api('/api/shaders/state')).json();
    renderHeader(); renderFiles(); renderVariants();
  }

  // ---- header: fxc, the source folder, the archive ----
  function renderHeader() {
    const s = W.state;
    $('sbFxc').innerHTML = s.fxc.found
      ? `<span class="ok">fxc ${escapeHtml(s.fxc.version || '')}</span> <span class="path">${escapeHtml(s.fxc.path)}</span>${s.fxc.custom ? ' <span class="dim">(set by you)</span>' : ' <span class="dim">(the installed Windows SDK)</span>'}`
      : `<span class="err">fxc not found.</span> Install a Windows SDK (its "Windows SDK for Desktop C++" part has fxc.exe), or set the path.`;
    $('sbSource').innerHTML = s.source.ok
      ? `<span class="path">${escapeHtml(s.source.folder)}</span> · ${s.source.files.length} files${s.source.overrideError ? ` <span class="err">variants.json: ${escapeHtml(s.source.overrideError)}</span>` : ''}`
      : `<span class="dim">No source folder${s.source.folder ? ` (${escapeHtml(s.source.folder)} has no .fx files)` : ''}. Choose the folder with FRPG_FS_HemEnv.fx and the other FlverPBL sources.</span>`;
    $('sbArchive').textContent = s.archive.path ? `${s.archive.count} shaders in ${s.archive.path}` : 'The game\'s shader archive was not found.';
    $('sbBuild').disabled = !s.fxc.found || !s.source.ok || !s.project;
    $('sbPack').disabled = !s.project;
    $('sbProjectNote').hidden = s.project;
  }
  $('sbFxcEdit').onclick = async () => {
    const p = prompt('Path to fxc.exe (empty: use the installed Windows SDK\'s)', W.state.fxc.custom ? W.state.fxc.path : '');
    if (p === null) return;
    await api('/api/shaders/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fxc: p }) });
    refresh();
  };
  $('sbSourceEdit').onclick = async () => {
    const f = await pickFolder({ title: 'HLSL source folder (with FRPG_FS_HemEnv.fx)', start: W.state.source.folder || '', want: 'any' });
    if (!f) return;
    try { await api('/api/shaders/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: f }) }); }
    catch (e) { alert(e.message.replace(/^[^:]*: \d+ /, '')); return; }
    W.file = null; $('sbEditor').value = ''; refresh();
  };

  // ---- the sources ----
  function renderFiles() {
    const ul = $('sbFiles'); ul.innerHTML = '';
    for (const f of W.state.source.files) {
      const li = document.createElement('li'); li.textContent = f.path; li.title = `${f.size} bytes`;
      if (f.path === W.file) li.classList.add('on');
      li.onclick = () => openFile(f.path); ul.append(li);
    }
  }
  async function openFile(path) {
    if (W.file && W.text !== W.saved && !confirm(`${W.file} has unsaved changes. Discard them?`)) return;
    W.file = path; W.text = W.saved = await (await api('/api/shaders/file?path=' + encodeURIComponent(path))).text();
    $('sbEditor').value = W.text; $('sbFileName').textContent = path; $('sbSave').disabled = true; renderFiles();
  }
  $('sbEditor').oninput = () => { W.text = $('sbEditor').value; $('sbSave').disabled = W.text === W.saved; };
  $('sbEditor').onkeydown = (e) => {   // a tab inserts a tab
    if (e.key === 'Tab') { e.preventDefault(); const t = $('sbEditor'), s = t.selectionStart; t.setRangeText('\t', s, t.selectionEnd, 'end'); t.oninput(); }
  };
  async function saveFile() {
    if (!W.file || W.text === W.saved) return;
    await api('/api/shaders/file?path=' + encodeURIComponent(W.file), { method: 'POST', body: W.text });
    W.saved = W.text; $('sbSave').disabled = true;
  }
  $('sbSave').onclick = saveFile;
  function gotoLine(file, line) {
    const go = () => { const t = $('sbEditor'), lines = t.value.split('\n'); let pos = 0; for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1; t.focus(); t.setSelectionRange(pos, pos + (lines[line - 1]?.length ?? 0)); t.blur(); t.focus(); };
    if (W.file !== file) openFile(file).then(go); else go();
  }

  // ---- the variants ----
  const families = () => [...new Set(W.state.variants.map(v => v.family))].sort();
  function visible() {
    const f = W.filter.toLowerCase();
    return W.state.variants.filter(v => (!W.family || v.family === W.family) && (!W.onlyBuildable || v.buildable) && (!f || v.name.toLowerCase().includes(f)));
  }
  function renderVariants() {
    const sel = $('sbFamily'); const cur = sel.value; sel.innerHTML = '<option value="">all families</option>';
    for (const f of families()) sel.add(new Option(`${f} (${W.state.variants.filter(v => v.family === f).length})`, f));
    sel.value = cur; W.family = sel.value;
    const list = visible(), ul = $('sbVariants'); ul.innerHTML = '';
    const built = W.state.built || {};
    for (const v of list.slice(0, 600)) {
      const li = document.createElement('li'); const b = built[v.name];
      const cb = el('input', { type: 'checkbox' }); cb.checked = W.selected.has(v.name); cb.onclick = (e) => { e.stopPropagation(); cb.checked ? W.selected.add(v.name) : W.selected.delete(v.name); updateCounts(); };
      const status = b ? (b.ok ? `<span class="badge" title="${escapeHtml(b.digest || '')}">built ${(b.size / 1024).toFixed(1)} KB</span>` : '<span class="badge warn">failed</span>') : '';
      li.append(cb, el('span', { cls: 'name' + (v.buildable ? '' : ' dim') }, v.name));
      li.insertAdjacentHTML('beforeend', `<span class="small">${status}${v.buildable ? '' : '<span class="dim">no rule</span>'}</span>`);
      li.title = v.buildable ? `${v.source}\n${v.defines.join(' ')}` : 'No build rule: not one of the HemEnv/Non/Sfx families this workbench knows. A variants.json beside the sources can add one.';
      li.onclick = () => showVariant(v);
      ul.append(li);
    }
    $('sbVariantCount').textContent = `${list.length} shown${list.length > 600 ? ' (first 600 listed)' : ''} · ${W.state.variants.filter(v => v.buildable).length} buildable of ${W.state.variants.length}`;
    updateCounts();
  }
  function updateCounts() { $('sbBuild').textContent = W.selected.size ? `Build ${W.selected.size} selected` : 'Build (select variants)'; $('sbBuild').disabled = !W.selected.size || !W.state.fxc.found || !W.state.source.ok || !W.state.project || W.building; }
  $('sbFilter').oninput = () => { W.filter = $('sbFilter').value.trim(); renderVariants(); };
  $('sbFamily').onchange = () => { W.family = $('sbFamily').value; renderVariants(); };
  $('sbOnlyBuildable').onchange = () => { W.onlyBuildable = $('sbOnlyBuildable').checked; renderVariants(); };
  $('sbSelectShown').onclick = () => { for (const v of visible()) if (v.buildable) W.selected.add(v.name); renderVariants(); };
  $('sbSelectNone').onclick = () => { W.selected.clear(); renderVariants(); };
  function showVariant(v) {
    const b = (W.state.built || {})[v.name];
    $('sbDetail').innerHTML = `<b>${escapeHtml(v.name)}</b><div class="small">${v.buildable ? `${escapeHtml(v.source)} with ${v.defines.map(d => `<code>${escapeHtml(d)}</code>`).join(' ')}` : '<span class="dim">no build rule</span>'}</div>`
      + (b ? `<div class="small">${b.ok ? `<span class="ok">built</span> ${b.size} bytes, digest ${escapeHtml(b.digest)}, ${new Date(b.time).toLocaleString()}` : '<span class="err">last build failed</span>'}</div><pre class="log">${escapeHtml(b.log || '')}</pre>` : '');
    for (const a of $('sbDetail').querySelectorAll('pre')) linkErrors(a);
  }
  // fxc reports "<file>(<line>,<col>): error X1234: ..." — make those lines open the file.
  function linkErrors(pre) {
    pre.innerHTML = pre.innerHTML.replace(/^(.*?)\((\d+),(\d+)(?:-\d+)?\): (error|warning)/gm, (m, file, line, col, kind) => {
      const rel = file.replace(/\\/g, '/').split('/').pop();
      return `<a href="#" data-file="${escapeHtml(rel)}" data-line="${line}">${escapeHtml(rel)}(${line},${col})</a>: ${kind}`;
    });
    for (const a of pre.querySelectorAll('a')) a.onclick = (e) => { e.preventDefault(); const f = (W.state.source.files.find(x => x.path.split('/').pop() === a.dataset.file) || {}).path; if (f) gotoLine(f, +a.dataset.line); };
  }

  // ---- building and packing ----
  $('sbBuild').onclick = async () => {
    await saveFile();
    const names = [...W.selected]; if (!names.length) return;
    W.building = true; updateCounts();
    const out = $('sbResults'); out.innerHTML = `<div>Building ${names.length}…</div>`;
    const results = []; const t0 = performance.now();
    for (let i = 0; i < names.length; i += 24) {   // batches, so progress shows
      const r = await (await api('/api/shaders/build', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names: names.slice(i, i + 24) }) })).json();
      results.push(...r.results);
      out.innerHTML = `<div>${results.length} of ${names.length} built, ${results.filter(x => !x.ok).length} failed · ${((performance.now() - t0) / 1000).toFixed(0)} s</div>`;
    }
    const failed = results.filter(r => !r.ok);
    out.innerHTML = `<div><span class="${failed.length ? 'err' : 'ok'}">${results.length - failed.length} built, ${failed.length} failed</span> in ${((performance.now() - t0) / 1000).toFixed(1)} s</div>`
      + failed.map(r => `<details open><summary>${escapeHtml(r.name)}</summary><pre class="log">${escapeHtml(r.log)}</pre></details>`).join('');
    for (const pre of out.querySelectorAll('pre')) linkErrors(pre);
    W.building = false;
    W.state.built = (await (await api('/api/shaders/state')).json()).built; renderVariants();
  };
  $('sbDiscard').onclick = async () => {
    const names = [...W.selected]; if (!names.length || !confirm(`Discard the built shaders of the ${names.length} selected variants?`)) return;
    await api('/api/shaders/discard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names }) });
    W.state.built = (await (await api('/api/shaders/state')).json()).built; renderVariants();
  };
  $('sbPack').onclick = async () => {
    const target = await exportTargets('Pack the built shaders into the archive and write it to:');
    if (!target) return;
    const out = $('sbResults'); out.innerHTML = 'Packing…';
    try {
      const r = await (await api('/api/shaders/pack?target=' + encodeURIComponent(target), { method: 'POST' })).json();
      out.innerHTML = `<div><span class="ok">Packed</span> ${r.replaced.length} shader${r.replaced.length === 1 ? '' : 's'} into <span class="path">${escapeHtml(r.file)}</span> in ${(r.ms / 1000).toFixed(1)} s.</div>`
        + (r.unknown.length ? `<div class="err">Not in the archive (the game never asks for these names): ${r.unknown.map(escapeHtml).join(', ')}</div>` : '')
        + (r.digests ? `<div class="small dim">Digests of every shader now in the archive: ${escapeHtml(r.digests)}</div>` : '');
    } catch (e) { out.innerHTML = `<span class="err">${escapeHtml(e.message.replace(/^[^:]*: \d+ /, ''))}</span>`; }
  };

  return { open, close };
}
