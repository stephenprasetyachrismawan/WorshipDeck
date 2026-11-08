/* Antarmuka WorshipDeck. */
'use strict';

(function () {
  const api = window.wd;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];

  const state = {
    info: null,
    settings: null,
    projects: [],
    project: null,
    templates: [],
    library: { files: [], templates: [] },
    tab: 'mulai',
    dc: { exe: null, running: false },
    aiBusy: false,
  };
  const live = { aiStatus: null, dcProgress: null }; // elemen yang diperbarui oleh event dari proses utama

  /* ---------- pembuat elemen ---------- */

  function h(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'value') e.value = v;
      else if (k === 'checked') e.checked = !!v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      e.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return e;
  }

  function field(label, input, hint) {
    return h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
  }

  function toast(msg, isError) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'show' + (isError ? ' error' : '');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.className = ''; }, isError ? 6000 : 2600);
  }

  async function run(fn, okMsg) {
    try {
      const r = await fn();
      if (okMsg) toast(okMsg);
      return r;
    } catch (e) {
      toast(e.message || String(e), true);
      return undefined;
    }
  }

  function modal(title, body, actions) {
    const m = $('#modal');
    const box = $('.modal-box', m);
    box.innerHTML = '';
    box.append(h('h2', {}, title), body, h('div', { class: 'row' }, ...actions));
    m.classList.remove('hidden');
    return () => m.classList.add('hidden');
  }

  function confirmDialog(title, text, okLabel) {
    return new Promise((resolve) => {
      const close = modal(title, h('p', {}, text), [
        h('button', { onclick: () => { close(); resolve(false); } }, 'Batal'),
        h('button', { class: 'primary', onclick: () => { close(); resolve(true); } }, okLabel || 'Ya'),
      ]);
    });
  }

  function promptDialog(title, label, value) {
    return new Promise((resolve) => {
      const input = h('input', { type: 'text', value: value || '' });
      const close = modal(title, field(label, input), [
        h('button', { onclick: () => { close(); resolve(null); } }, 'Batal'),
        h('button', { class: 'primary', onclick: () => { close(); resolve(input.value.trim()); } }, 'OK'),
      ]);
      setTimeout(() => input.focus(), 30);
    });
  }

  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const fmtDate = (iso) => { try { return new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso; } };
  const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const baseName = (p) => String(p).split(/[\\/]/).pop();

  /* ---------- simpan otomatis ---------- */

  const saveNow = async () => {
    if (!state.project) return;
    const p = state.project;
    $('#save-state').textContent = 'Menyimpan…';
    await run(() => api.call('project:update', { id: p.id, patch: {
      name: p.name, meta: p.meta, settings: p.settings, sections: p.sections, libraryFiles: p.libraryFiles,
    } }));
    $('#save-state').textContent = 'Tersimpan';
    renderProjectList();
  };
  const scheduleSave = debounce(saveNow, 500);

  function changed(opts) {
    $('#save-state').textContent = 'Belum tersimpan…';
    scheduleSave();
    if (!opts || opts.preview !== false) schedulePreview();
  }

  /* ---------- navigasi ---------- */

  function showView(name) {
    for (const v of ['welcome', 'project', 'library', 'settings']) $(`#view-${v}`).classList.toggle('hidden', v !== name);
    $('#nav-library').classList.toggle('active', name === 'library');
    $('#nav-settings').classList.toggle('active', name === 'settings');
  }

  async function loadProjects() {
    state.projects = await api.call('projects:list');
    renderProjectList();
  }

  function renderProjectList() {
    const ul = $('#project-list');
    ul.innerHTML = '';
    if (!state.projects.length) ul.append(h('li', { class: 'muted' }, 'Belum ada project'));
    for (const p of state.projects) {
      const current = state.project && state.project.id === p.id;
      const name = current ? state.project.name : p.name;
      ul.append(h('li', { class: current ? 'active' : '', onclick: () => openProject(p.id) },
        name || 'Tanpa nama', h('small', {}, (current ? state.project.meta.date : p.date) || fmtDate(p.updatedAt))));
    }
  }

  async function openProject(id, tab) {
    if (state.project) await saveNow();
    const p = await run(() => api.call('project:get', { id }));
    if (!p) return;
    state.project = p;
    await refreshTemplates();
    state.library = await api.call('library:get');
    showView('project');
    renderHeader();
    renderProjectList();
    selectTab(tab || state.tab || 'mulai');
  }

  async function refreshTemplates() {
    state.templates = await api.call('templates:list', { projectId: state.project && state.project.id });
  }

  async function newProject() {
    const name = await promptDialog('Project baru', 'Nama project (mis. "Ibadah Minggu 9 Nov")', '');
    if (name === null) return;
    const p = await run(() => api.call('project:create', { name: name || 'Project baru' }));
    if (!p) return;
    await loadProjects();
    await openProject(p.id, 'mulai');
  }

  function renderHeader() {
    const p = state.project;
    $('#p-title').textContent = p.name || 'Tanpa nama';
    const tpl = state.templates.find((t) => t.id === p.settings.templateId);
    $('#p-sub').textContent = [p.meta.date, p.meta.church, tpl && `Template: ${tpl.name}`].filter(Boolean).join(' · ');
    $('#save-state').textContent = '';
  }

  function selectTab(tab) {
    state.tab = tab;
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.tab-body').forEach((t) => t.classList.toggle('hidden', t.id !== `tab-${tab}`));
    const renderers = { mulai: renderMulai, berkas: renderBerkas, bagian: renderBagian, tampilan: renderTampilan, isi: renderIsi, hasil: renderHasil };
    renderers[tab]();
  }

  /* ---------- pratinjau ---------- */

  let previewTarget = null; // { el, mode: 'sample'|'all' }

  async function refreshPreview() {
    if (!previewTarget || !state.project || !document.body.contains(previewTarget.el)) return;
    const { el, mode } = previewTarget;
    const p = state.project;
    const layout = await run(() => api.call('deck:layout', { projectId: p.id, settings: p.settings, sections: p.sections }));
    if (!layout) return;
    el.innerHTML = '';
    let slides = layout.slides;
    if (mode === 'sample') {
      const seen = new Set();
      slides = slides.filter((s) => (seen.has(s.kind) ? false : seen.add(s.kind))).slice(0, 6);
    }
    if (!slides.length) { el.append(h('div', { class: 'empty' }, 'Belum ada slide. Semua bagian nonaktif atau isi kosong.')); return; }
    if (layout.isSample) el.append(h('div', { class: 'hint' }, 'Pratinjau memakai contoh isi. Isi asli muncul setelah langkah 5.'));
    const width = Math.max(200, (mode === 'sample' ? el.clientWidth : 240) - 4);
    const wrap = h('div', { class: mode === 'sample' ? 'preview-list' : 'slides-grid' });
    for (const s of slides) {
      wrap.append(h('div', { class: 'slide-wrap' },
        window.WDPreview.renderSlide(s, layout.size, mode === 'sample' ? width : 236),
        h('div', { class: 'cap' }, h('span', {}, `${s.index + 1}. ${state.info.kindLabels[s.kind] || s.kind}`), h('span', {}, s.sectionName))));
    }
    el.append(wrap);
    if (mode === 'all') {
      const ws = $$('.slides-grid .slide', el);
      // perbesar slide sesuai lebar kolom grid
      requestAnimationFrame(() => ws.forEach((node, i) => {
        const w = node.parentElement.clientWidth;
        if (Math.abs(w - 236) > 8) node.replaceWith(window.WDPreview.renderSlide(slides[i], layout.size, w));
      }));
    }
  }
  const schedulePreview = debounce(refreshPreview, 350);

  /* ---------- tab 1: Mulai ---------- */

  function templateThumb(t) {
    const fakeSlide = {
      background: { color: (t.background && t.background.color) || '#000' },
      boxes: [
        { x: 0.5, y: 1.4, w: 12.3, h: 1.4, fontFace: t.fonts.heading, fontSize: 60, color: t.colors.heading, bold: true, align: 'center', valign: 'middle', paragraphs: [{ runs: [{ text: t.uppercaseHeadings ? 'NYANYIAN' : 'Nyanyian' }] }] },
        { x: 0.5, y: 3.2, w: 12.3, h: 2.4, fontFace: t.fonts.body, fontSize: 40, color: t.colors.body, align: 'center', valign: 'top', paragraphs: [{ runs: [{ text: 'Baris lirik pertama' }] }, { runs: [{ text: 'baris lirik kedua', color: t.colors.accent }] }] },
      ],
    };
    return window.WDPreview.renderSlide(fakeSlide, { w: 13.333, h: 7.5 }, 186);
  }

  function renderMulai() {
    const p = state.project;
    const root = $('#tab-mulai');
    root.innerHTML = '';
    const metaInput = (key, label, type, ph) => field(label, h('input', {
      type: type || 'text', value: p.meta[key] || '', placeholder: ph || '',
      oninput: (e) => { p.meta[key] = e.target.value; renderHeader(); changed(); },
    }));

    root.append(h('div', { class: 'card' },
      h('h2', {}, 'Data ibadah'),
      h('div', { class: 'grid2' },
        field('Nama project', h('input', { type: 'text', value: p.name, oninput: (e) => { p.name = e.target.value; renderHeader(); changed({ preview: false }); } })),
        metaInput('date', 'Tanggal ibadah', 'date'),
        metaInput('church', 'Nama gereja / jemaat', 'text', 'mis. GKJ Salatiga'),
        metaInput('theme', 'Tema ibadah / khotbah'),
        metaInput('preacher', 'Pelayan firman'),
        metaInput('liturgist', 'Liturgos / pemandu'),
      ),
      h('div', { class: 'hint' }, 'Data yang diisi di sini dipakai AI bila dokumen tidak menyebutkannya.'),
    ));

    const sizeSel = h('select', { onchange: (e) => { p.settings.slideSize = e.target.value; changed(); } },
      h('option', { value: '16:9' }, 'Layar lebar 16:9'), h('option', { value: '4:3' }, 'Standar 4:3'));
    sizeSel.value = p.settings.slideSize || '16:9';

    const grid = h('div', { class: 'tpl-grid' });
    for (const t of state.templates) {
      const active = t.id === p.settings.templateId;
      const scopeLabel = { builtin: 'Bawaan', library: 'Pustaka', project: 'Project ini' }[t.scope];
      const actions = [];
      if (t.scope !== 'builtin') {
        actions.push(h('button', { class: 'small', onclick: async (e) => {
          e.stopPropagation();
          const name = await promptDialog('Ganti nama template', 'Nama', t.name);
          if (!name) return;
          await run(() => api.call('templates:rename', { scope: t.scope, projectId: p.id, templateId: t.id, name }), 'Nama template diganti');
          await refreshTemplates(); renderMulai();
        } }, 'Ganti nama'));
        if (t.scope === 'project') {
          actions.push(h('button', { class: 'small', title: 'Simpan juga ke pustaka agar bisa dipakai project lain', onclick: async (e) => {
            e.stopPropagation();
            await run(() => api.call('templates:promote', { projectId: p.id, templateId: t.id }), 'Template disalin ke pustaka');
            await refreshTemplates(); renderMulai();
          } }, '→ Pustaka'));
        }
        actions.push(h('button', { class: 'small danger', onclick: async (e) => {
          e.stopPropagation();
          if (!(await confirmDialog('Hapus template', `Hapus template "${t.name}"?`, 'Hapus'))) return;
          await run(() => api.call('templates:delete', { scope: t.scope, projectId: p.id, templateId: t.id }), 'Template dihapus');
          if (p.settings.templateId === t.id) { p.settings.templateId = 'malam-biru'; changed(); }
          await refreshTemplates(); renderMulai();
        } }, 'Hapus'));
      }
      grid.append(h('div', { class: 'tpl' + (active ? ' active' : ''), onclick: () => {
        p.settings.templateId = t.id;
        if (t.slideSize) p.settings.slideSize = t.slideSize;
        changed(); renderHeader(); renderMulai();
      } },
        templateThumb(t),
        h('div', { class: 'tpl-info' }, t.name, h('small', {}, scopeLabel, t.source === 'deckcraft' ? ' · dari DeckCraft' : '')),
        actions.length ? h('div', { class: 'tpl-actions' }, actions) : null));
    }

    root.append(h('div', { class: 'card' },
      h('div', { class: 'row' }, h('h2', {}, 'Template'), h('div', { class: 'spacer' }),
        h('button', { onclick: async () => {
          const t = await run(() => api.call('templates:importPptx', { projectId: p.id, resetStyle: true }));
          if (t) { toast(`Template "${t.name}" ditambahkan`); state.project = await api.call('project:get', { id: p.id }); await refreshTemplates(); renderMulai(); }
        } }, 'Ambil template dari PPTX…')),
      h('div', { class: 'hint' }, 'Template mengatur huruf, warna, latar, dan posisi teks. Template dari DeckCraft menyimpan tata letak per jenis slide. Ukuran huruf & warna masih bisa diubah di langkah 4.'),
      h('div', { style: 'max-width:260px' }, field('Ukuran slide', sizeSel)),
      grid,
    ));
  }

  /* ---------- tab 2: Berkas ---------- */

  function fileKindSelect(f, onChange) {
    const sel = h('select', { onchange: (e) => onChange(e.target.value) },
      Object.entries(state.info.fileKinds).map(([k, v]) => h('option', { value: k }, v)));
    sel.value = f.kind;
    return sel;
  }

  function fileTable(files, scope) {
    const p = state.project;
    if (!files.length) return h('div', { class: 'empty' }, 'Belum ada berkas.');
    return h('table', { class: 'list' },
      h('tr', {}, h('th', {}, 'Nama'), h('th', {}, 'Jenis'), h('th', {}, 'Baca AI'), h('th', {}, 'Catatan untuk AI'), h('th', {}, 'Ukuran'), h('th', {}, '')),
      files.map((f) => h('tr', {},
        h('td', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); api.call('files:open', { scope, projectId: p.id, fileId: f.id }); } }, f.name)),
        h('td', {}, fileKindSelect(f, (kind) => run(() => api.call('files:update', { scope, projectId: p.id, fileId: f.id, patch: { kind } })).then(() => { f.kind = kind; }))),
        h('td', {}, h('input', { type: 'checkbox', checked: f.useForAi, onchange: (e) => {
          f.useForAi = e.target.checked;
          run(() => api.call('files:update', { scope, projectId: p.id, fileId: f.id, patch: { useForAi: f.useForAi } }));
        } })),
        h('td', {}, h('input', { type: 'text', value: f.note || '', placeholder: 'opsional', onchange: (e) => {
          f.note = e.target.value;
          run(() => api.call('files:update', { scope, projectId: p.id, fileId: f.id, patch: { note: f.note } }));
        } })),
        h('td', { class: 'muted' }, fmtSize(f.size)),
        h('td', {}, h('button', { class: 'small danger', onclick: async () => {
          if (!(await confirmDialog('Hapus berkas', `Hapus "${f.name}"?`, 'Hapus'))) return;
          await run(() => api.call('files:remove', { scope, projectId: p.id, fileId: f.id }), 'Berkas dihapus');
          await reloadProjectAndLibrary(); renderBerkas();
        } }, 'Hapus')),
      )));
  }

  async function reloadProjectAndLibrary() {
    const p = await api.call('project:get', { id: state.project.id });
    state.project.files = p.files;
    state.library = await api.call('library:get');
  }

  function dropZone(scope) {
    const zone = h('div', { class: 'drop' }, 'Tarik berkas ke sini (PDF, DOCX, TXT, PPTX, gambar) atau ',
      h('button', { onclick: async () => {
        const added = await run(() => api.call('files:pick', { scope, projectId: state.project && state.project.id }));
        if (added && added.length) { toast(`${added.length} berkas ditambahkan`); await afterFilesAdded(scope); }
      } }, 'pilih berkas…'));
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
      const added = await run(() => api.call('files:addPaths', { scope, projectId: state.project && state.project.id, paths }));
      if (added && added.length) { toast(`${added.length} berkas ditambahkan`); await afterFilesAdded(scope); }
    });
    return zone;
  }

  async function afterFilesAdded(scope) {
    if (scope === 'library' && !state.project) { state.library = await api.call('library:get'); renderLibrary(); return; }
    await reloadProjectAndLibrary();
    if (scope === 'library' && $('#view-library').classList.contains('hidden') === false) renderLibrary();
    else renderBerkas();
  }

  function renderBerkas() {
    const p = state.project;
    const root = $('#tab-berkas');
    root.innerHTML = '';
    root.append(h('div', { class: 'card' },
      h('h2', {}, 'Berkas project ini'),
      h('div', { class: 'hint' }, 'Hanya untuk project ini: liturgi, warta jemaat, lirik lagu, gambar latar. Centang "Baca AI" untuk berkas yang perlu dibaca AI. Gambar bisa dipakai sebagai latar di langkah 3 dan 4.'),
      dropZone('project'),
      fileTable(p.files, 'project'),
    ));

    const libFiles = state.library.files;
    root.append(h('div', { class: 'card' },
      h('h2', {}, 'Berkas dari pustaka (dipakai bersama semua project)'),
      h('div', { class: 'hint' }, 'Mis. kumpulan lirik Kidung Jemaat, logo gereja, gambar latar. Centang untuk ikut dibaca AI di project ini. Kelola di menu Pustaka.'),
      libFiles.length ? h('table', { class: 'list' },
        h('tr', {}, h('th', {}, 'Pakai'), h('th', {}, 'Nama'), h('th', {}, 'Jenis'), h('th', {}, 'Ukuran')),
        libFiles.map((f) => h('tr', {},
          h('td', {}, h('input', { type: 'checkbox', checked: (p.libraryFiles || []).includes(f.id), onchange: (e) => {
            const set = new Set(p.libraryFiles || []);
            if (e.target.checked) set.add(f.id); else set.delete(f.id);
            p.libraryFiles = [...set];
            changed({ preview: false });
          } })),
          h('td', {}, f.name), h('td', {}, state.info.fileKinds[f.kind] || f.kind), h('td', { class: 'muted' }, fmtSize(f.size)))))
        : h('div', { class: 'empty' }, 'Pustaka masih kosong.'),
    ));
  }

  /* ---------- pilihan latar (dipakai di Bagian & Tampilan) ---------- */

  function imageOptions() {
    const p = state.project;
    const imgs = [];
    for (const f of p.files) if (f.kind === 'gambar') imgs.push({ ref: { scope: 'project', id: f.id }, name: f.name });
    for (const f of state.library.files) if (f.kind === 'gambar') imgs.push({ ref: { scope: 'library', id: f.id }, name: `${f.name} (pustaka)` });
    return imgs;
  }

  /** Editor latar: bawaan template / warna / gambar. Memanggil onChange(bg|undefined). */
  function backgroundEditor(current, onChange, inheritLabel) {
    const imgs = imageOptions();
    const typeSel = h('select', {},
      h('option', { value: '' }, inheritLabel || 'Ikuti template'),
      h('option', { value: 'color' }, 'Warna polos'),
      h('option', { value: 'image' }, 'Gambar'));
    typeSel.value = current ? current.type : '';
    const color = h('input', { type: 'color', value: (current && current.color) || '#0B1D3A' });
    const imgSel = h('select', {}, imgs.length ? imgs.map((im, i) => h('option', { value: String(i) }, im.name)) : h('option', { value: '' }, '— unggah gambar di tab Berkas —'));
    if (current && current.type === 'image' && current.image) {
      const i = imgs.findIndex((im) => im.ref.id === current.image.id);
      if (i >= 0) imgSel.value = String(i);
    }
    const sync = () => {
      color.classList.toggle('hidden', typeSel.value !== 'color');
      imgSel.classList.toggle('hidden', typeSel.value !== 'image');
      if (!typeSel.value) onChange(undefined);
      else if (typeSel.value === 'color') onChange({ type: 'color', color: color.value });
      else {
        const im = imgs[Number(imgSel.value)];
        onChange(im ? { type: 'image', image: im.ref, color: color.value } : undefined);
      }
    };
    typeSel.onchange = sync; color.oninput = sync; imgSel.onchange = sync;
    color.classList.toggle('hidden', typeSel.value !== 'color');
    imgSel.classList.toggle('hidden', typeSel.value !== 'image');
    imgSel.style.maxWidth = '220px';
    typeSel.style.width = 'auto';
    return h('div', { class: 'row' }, typeSel, color, imgSel);
  }

  /* ---------- tab 3: Bagian ---------- */

  function renderBagian() {
    const p = state.project;
    const root = $('#tab-bagian');
    root.innerHTML = '';
    const list = h('div');
    const move = (i, d) => {
      const j = i + d;
      if (j < 0 || j >= p.sections.length) return;
      [p.sections[i], p.sections[j]] = [p.sections[j], p.sections[i]];
      changed(); renderBagian();
    };
    p.sections.forEach((s, i) => {
      list.append(h('div', { class: 'section-item' + (s.enabled === false ? ' off' : '') },
        h('div', { class: 'num' }, i + 1),
        h('div', {},
          h('div', { class: 'row' },
            h('input', { type: 'text', value: s.name, style: 'flex:1;font-weight:600', oninput: (e) => { s.name = e.target.value; changed(); } }),
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.enabled !== false, onchange: (e) => { s.enabled = e.target.checked; changed(); renderBagian(); } }), 'Aktif'),
            h('label', { class: 'check', title: 'Tambahkan slide judul bagian sebelum isinya' }, h('input', { type: 'checkbox', checked: !!s.divider, onchange: (e) => { s.divider = e.target.checked; changed(); } }), 'Slide pembatas')),
          h('textarea', { rows: 2, style: 'margin-top:6px', placeholder: 'Petunjuk untuk AI: apa saja yang masuk bagian ini', oninput: (e) => { s.instructions = e.target.value; changed({ preview: false }); } }, s.instructions || ''),
          h('div', { class: 'row', style: 'margin-top:6px' }, h('span', { class: 'muted' }, 'Latar bagian ini:'),
            backgroundEditor(s.background, (bg) => { s.background = bg; changed(); }, 'Ikuti tampilan project'))),
        h('div', { class: 'moves' },
          h('button', { class: 'small', title: 'Naik', onclick: () => move(i, -1) }, '▲'),
          h('button', { class: 'small', title: 'Turun', onclick: () => move(i, 1) }, '▼'),
          h('button', { class: 'small danger', title: 'Hapus bagian', onclick: async () => {
            if (!(await confirmDialog('Hapus bagian', `Hapus bagian "${s.name}"? Isi slide di bagian ini tidak akan tampil.`, 'Hapus'))) return;
            p.sections.splice(i, 1); changed(); renderBagian();
          } }, '✕'))));
    });
    root.append(h('div', { class: 'split' },
      h('div', {},
        h('div', { class: 'card' },
          h('div', { class: 'row' }, h('h2', {}, 'Bagian liturgi'), h('div', { class: 'spacer' }),
            h('button', { onclick: async () => {
              const name = await promptDialog('Bagian baru', 'Nama bagian', '');
              if (!name) return;
              let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'bagian';
              while (p.sections.some((x) => x.id === id)) id += '-2';
              p.sections.push({ id, name, enabled: true, divider: false, instructions: '' });
              changed(); renderBagian();
            } }, '+ Tambah bagian'),
            h('button', { class: 'ghost', onclick: async () => {
              if (!(await confirmDialog('Kembalikan bawaan', 'Ganti semua bagian dengan susunan bawaan?', 'Ganti'))) return;
              p.sections = JSON.parse(JSON.stringify(state.info.defaultSections)); changed(); renderBagian();
            } }, 'Kembalikan bawaan')),
          h('div', { class: 'hint' }, 'Urutan di sini menjadi urutan slide. AI memasukkan tiap unsur liturgi ke bagian yang cocok. Bila bagian diubah setelah AI menyusun isi, jalankan ulang AI agar pembagiannya ikut berubah.'),
          list)),
      h('div', { class: 'card sticky' }, h('h2', {}, 'Pratinjau'), h('div', { id: 'pv-bagian' }))));
    previewTarget = { el: $('#pv-bagian'), mode: 'sample' };
    refreshPreview();
  }

  /* ---------- tab 4: Tampilan ---------- */

  const FONT_LIST = ['Segoe UI', 'Segoe UI Semibold', 'Arial', 'Calibri', 'Cambria', 'Georgia', 'Times New Roman', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Montserrat', 'Open Sans', 'Lato', 'Poppins'];

  function renderTampilan() {
    const p = state.project;
    const st = p.settings.style || (p.settings.style = {});
    const tpl = state.templates.find((t) => t.id === p.settings.templateId) || state.templates[0];
    const root = $('#tab-tampilan');
    root.innerHTML = '';

    const setDeep = (group, key, val) => {
      st[group] = st[group] || {};
      if (val === undefined || val === '' || Number.isNaN(val)) delete st[group][key];
      else st[group][key] = val;
      if (!Object.keys(st[group]).length) delete st[group];
      changed();
    };

    const sizeInput = (key, label) => field(label, h('input', {
      type: 'number', min: 8, max: 120, value: (st.sizes && st.sizes[key]) || '', placeholder: String(tpl.sizes[key]), title: `Template: ${tpl.sizes[key]} pt`,
      oninput: (e) => setDeep('sizes', key, e.target.value ? Number(e.target.value) : undefined),
    }));
    const fontInput = (key, label) => field(label, h('input', {
      type: 'text', list: 'font-list', value: (st.fonts && st.fonts[key]) || '', placeholder: tpl.fonts[key],
      oninput: (e) => setDeep('fonts', key, e.target.value.trim() || undefined),
    }));
    const colorInput = (key, label) => {
      const has = st.colors && st.colors[key];
      const inp = h('input', { type: 'color', value: has || tpl.colors[key] || '#ffffff', oninput: (e) => { setDeep('colors', key, e.target.value); reset.disabled = false; } });
      const reset = h('button', { class: 'small ghost', disabled: !has, onclick: () => { setDeep('colors', key, undefined); inp.value = tpl.colors[key]; reset.disabled = true; } }, 'ikuti template');
      return field(label, h('div', { class: 'row' }, inp, reset));
    };
    const alignSel = (key, label) => {
      const sel = h('select', { onchange: (e) => setDeep('align', key, e.target.value || undefined) },
        h('option', { value: '' }, `Template (${{ left: 'kiri', center: 'tengah', right: 'kanan' }[tpl.align[key]] || tpl.align[key]})`), h('option', { value: 'left' }, 'Kiri'), h('option', { value: 'center' }, 'Tengah'), h('option', { value: 'right' }, 'Kanan'));
      sel.value = (st.align && st.align[key]) || '';
      return field(label, sel);
    };

    const ml = p.settings.maxLines || (p.settings.maxLines = {});
    const rl = p.settings.roleLabels || (p.settings.roleLabels = { P: 'P', J: 'J', S: 'S' });
    const upperSel = h('select', { onchange: (e) => { if (e.target.value === '') delete st.uppercaseHeadings; else st.uppercaseHeadings = e.target.value === '1'; changed(); } },
      h('option', { value: '' }, `Template (${tpl.uppercaseHeadings ? 'KAPITAL' : 'biasa'})`), h('option', { value: '1' }, 'HURUF BESAR'), h('option', { value: '0' }, 'Biasa'));
    upperSel.value = st.uppercaseHeadings === undefined ? '' : st.uppercaseHeadings ? '1' : '0';

    root.append(h('datalist', { id: 'font-list' }, FONT_LIST.map((f) => h('option', { value: f }))));
    root.append(h('div', { class: 'split' },
      h('div', {},
        h('div', { class: 'card' },
          h('div', { class: 'row' }, h('h2', {}, 'Huruf'), h('div', { class: 'spacer' }), h('span', { class: 'muted' }, `Template: ${tpl.name}`)),
          h('div', { class: 'hint' }, 'Kosongkan untuk mengikuti template (angka abu-abu). Ukuran dalam poin (pt).'),
          h('div', { class: 'grid2' }, fontInput('heading', 'Huruf judul'), fontInput('body', 'Huruf isi')),
          h('div', { class: 'grid4' }, sizeInput('heading', 'Judul'), sizeInput('body', 'Teks biasa'), sizeInput('lyrics', 'Lirik lagu'), sizeInput('small', 'Kecil / footer')),
          h('div', { class: 'grid3' }, alignSel('heading', 'Perataan judul'), alignSel('body', 'Perataan isi'), field('Gaya judul', upperSel))),
        h('div', { class: 'card' },
          h('h2', {}, 'Warna'),
          h('div', { class: 'grid4' }, colorInput('heading', 'Judul'), colorInput('body', 'Teks'), colorInput('accent', 'Aksen (P/J, nomor ayat)'), colorInput('muted', 'Footer'))),
        h('div', { class: 'card' },
          h('h2', {}, 'Latar'),
          h('div', { class: 'hint' }, 'Latar untuk semua slide. Tiap bagian bisa punya latar sendiri di langkah 3.'),
          backgroundEditor(st.background, (bg) => { if (bg) st.background = bg; else delete st.background; changed(); })),
        h('div', { class: 'card' },
          h('h2', {}, 'Isi per slide'),
          h('div', { class: 'grid2' },
            field('Maks. baris lirik per slide', h('input', { type: 'number', min: 1, max: 12, value: ml.lyrics || 4, oninput: (e) => { ml.lyrics = Number(e.target.value) || 4; changed(); } })),
            field('Maks. baris teks per slide', h('input', { type: 'number', min: 2, max: 16, value: ml.text || 6, oninput: (e) => { ml.text = Number(e.target.value) || 6; changed(); } }))),
          h('div', { class: 'grid3' },
            field('Label pemimpin', h('input', { type: 'text', value: rl.P, oninput: (e) => { rl.P = e.target.value; changed(); } })),
            field('Label jemaat', h('input', { type: 'text', value: rl.J, oninput: (e) => { rl.J = e.target.value; changed(); } })),
            field('Label bersama', h('input', { type: 'text', value: rl.S, oninput: (e) => { rl.S = e.target.value; changed(); } }))),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: p.settings.sectionFooter !== false, onchange: (e) => { p.settings.sectionFooter = e.target.checked; changed(); } }), 'Tampilkan nama bagian di pojok bawah slide')),
        h('div', { class: 'row' }, h('button', { class: 'ghost danger', onclick: async () => {
          if (!(await confirmDialog('Kembalikan ke template', 'Hapus semua pengaturan huruf, warna, dan latar project ini?', 'Kembalikan'))) return;
          p.settings.style = {}; changed(); renderTampilan();
        } }, 'Kembalikan semua ke template'))),
      h('div', { class: 'card sticky' }, h('h2', {}, 'Pratinjau'), h('div', { id: 'pv-tampilan' }))));
    previewTarget = { el: $('#pv-tampilan'), mode: 'sample' };
    refreshPreview();
  }

  /* ---------- tab 5: Isi ---------- */

  function renderIsi() {
    const p = state.project;
    const root = $('#tab-isi');
    root.innerHTML = '';
    const aiFiles = p.files.filter((f) => f.useForAi).length + (p.libraryFiles || []).length;

    const progress = h('div', { class: 'progress indeterminate hidden' }, h('div'));
    const status = h('div', { class: 'muted' });
    const cancel = h('button', { class: 'hidden', onclick: () => api.call('ai:cancel') }, 'Batalkan');
    const goBtn = h('button', { class: 'primary', disabled: state.aiBusy, onclick: async () => {
      if (!state.settings.hasKey) { toast('Isi kunci API Claude di Pengaturan dulu.', true); return; }
      if (p.deck && p.deck.items.length && !(await confirmDialog('Susun ulang', 'Isi yang sudah ada akan diganti hasil AI yang baru. Lanjutkan?', 'Susun ulang'))) return;
      await saveNow();
      state.aiBusy = true; goBtn.disabled = true; progress.classList.remove('hidden'); cancel.classList.remove('hidden');
      status.textContent = 'AI sedang membaca berkas…';
      const r = await run(() => api.call('ai:generate', { projectId: p.id }));
      state.aiBusy = false; goBtn.disabled = false; progress.classList.add('hidden'); cancel.classList.add('hidden');
      if (r) {
        p.deck = r.deck; p.meta = { ...p.meta, ...r.deck.meta };
        status.textContent = `Selesai: ${r.deck.items.length} item disusun (${r.model}, ${r.usage.input_tokens + r.usage.output_tokens} token).`;
        toast('Isi slide selesai disusun');
        renderHeader();
        renderIsi();
      } else status.textContent = '';
    } }, state.aiBusy ? 'AI sedang bekerja…' : '✨ Susun isi dengan AI');
    live.aiStatus = status;

    root.append(h('div', { class: 'card' },
      h('h2', {}, 'Susun isi slide dengan AI'),
      h('div', { class: 'hint' }, `AI membaca ${aiFiles} berkas yang dicentang "Baca AI" lalu menyusun JSON sesuai bagian di langkah 3. AI tidak mengarang lirik atau ayat yang tidak ada di dokumen. PPT dibuat mesin, bukan AI.`),
      field('Instruksi tambahan untuk AI (opsional)', h('textarea', { rows: 2, placeholder: 'mis. "Nyanyian cukup bait 1 dan 3", "Warta jemaat maksimal 5 poin"', oninput: (e) => { p.settings.aiInstructions = e.target.value; changed({ preview: false }); } }, p.settings.aiInstructions || '')),
      h('div', { class: 'row' }, goBtn, cancel, status),
      progress));

    const deck = p.deck || { meta: p.meta, items: [] };
    const textarea = h('textarea', { class: 'json-editor', spellcheck: 'false' }, JSON.stringify(deck, null, 2));
    const summary = h('div', { class: 'item-summary' });
    const sectionName = (id) => (p.sections.find((s) => s.id === id) || {}).name || id;
    if (!deck.items.length) summary.append(h('div', { class: 'empty' }, 'Belum ada isi.'));
    deck.items.forEach((it, i) => {
      const detail = it.kind === 'song' ? `${it.stanzas.length} bait${it.stanzas.length ? '' : ' — lirik belum ada'}`
        : it.kind === 'scripture' ? `${it.verses.length} ayat` : it.kind === 'responsive' ? `${it.parts.length} bagian` : `${it.lines.length} baris`;
      summary.append(h('div', { class: 'it' }, h('span', { class: 'muted' }, i + 1),
        h('div', {}, h('b', {}, it.reference || it.title || '(tanpa judul)'), ' ',
          h('span', { class: 'badge' + (it.kind === 'song' && !it.stanzas.length ? ' warn' : '') }, state.info.kindLabels[it.kind]), ' ',
          h('span', { class: 'muted' }, `${sectionName(it.section)} · ${detail}`))));
    });

    root.append(h('div', { class: 'split' },
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('h2', {}, 'JSON isi slide'), h('div', { class: 'spacer' }),
          h('button', { onclick: async () => {
            let parsed;
            try { parsed = JSON.parse(textarea.value); } catch (e) { toast(`JSON tidak sah: ${e.message}`, true); return; }
            const norm = await run(() => api.call('deck:normalize', { projectId: p.id, deck: parsed }));
            if (!norm) return;
            await run(() => api.call('project:update', { id: p.id, patch: { deck: norm } }), 'Isi disimpan');
            p.deck = norm; renderIsi();
          } }, 'Terapkan perubahan'),
          h('button', { class: 'ghost', onclick: () => { textarea.value = JSON.stringify(p.deck || deck, null, 2); } }, 'Batalkan suntingan')),
        h('div', { class: 'hint' }, 'Bisa disunting langsung: perbaiki lirik, pindahkan item ke bagian lain (kolom "section"), atau tambah item. Jenis: heading, text, responsive, song, scripture, announcement.'),
        textarea),
      h('div', { class: 'card' }, h('h2', {}, `Ringkasan (${deck.items.length} item)`), summary,
        h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'primary', onclick: () => selectTab('hasil') }, 'Lanjut ke Hasil →')))));
  }

  /* ---------- tab 6: Hasil & DeckCraft ---------- */

  async function refreshDc() {
    state.dc = (await run(() => api.call('deckcraft:status'))) || state.dc;
  }

  async function renderHasil() {
    const p = state.project;
    const root = $('#tab-hasil');
    root.innerHTML = '';
    await refreshDc();
    const outputs = p.outputs || [];
    const active = outputs.find((o) => o.file === p.activeOutput) || outputs[0];

    const buildBtn = h('button', { class: 'primary', onclick: async () => {
      await saveNow();
      buildBtn.disabled = true; buildBtn.textContent = 'Membuat…';
      const r = await run(() => api.call('deck:build', { projectId: p.id }));
      buildBtn.disabled = false; buildBtn.textContent = '🛠 Buat PPT';
      if (r) {
        toast(`PPT dibuat: ${r.slides} slide`);
        state.project = await api.call('project:get', { id: p.id });
        renderHasil();
      }
    } }, '🛠 Buat PPT');

    const outList = outputs.length ? h('table', { class: 'list' },
      h('tr', {}, h('th', {}, 'Berkas'), h('th', {}, 'Dibuat'), h('th', {}, 'Slide'), h('th', {}, '')),
      outputs.map((o) => h('tr', {},
        h('td', {}, h('label', { class: 'check' },
          h('input', { type: 'radio', name: 'active-out', checked: o === active, onchange: async () => {
            p.activeOutput = o.file;
            await run(() => api.call('project:update', { id: p.id, patch: { activeOutput: o.file } }));
            renderHasil();
          } }), baseName(o.file)), ' ', o.edited ? h('span', { class: 'badge ok' }, 'disunting di DeckCraft') : null),
        h('td', { class: 'muted' }, fmtDate(o.editedAt || o.createdAt)),
        h('td', {}, o.slides),
        h('td', {}, h('div', { class: 'row' },
          h('button', { class: 'small', onclick: () => api.call('deck:openFile', { file: o.file }) }, 'Buka'),
          h('button', { class: 'small', onclick: () => api.call('deck:showInFolder', { file: o.file }) }, 'Folder'),
          h('button', { class: 'small', onclick: async () => { const f = await run(() => api.call('deck:saveAs', { projectId: p.id, file: o.file })); if (f) toast(`Disimpan ke ${f}`); } }, 'Simpan sebagai…')))))) : h('div', { class: 'empty' }, 'Belum ada PPT. Klik "Buat PPT".');

    root.append(h('div', { class: 'split' },
      h('div', {},
        h('div', { class: 'card' },
          h('div', { class: 'row' }, h('h2', {}, 'PowerPoint'), h('div', { class: 'spacer' }), buildBtn),
          h('div', { class: 'hint' }, 'Mesin membuat .pptx dari isi (langkah 5) dengan template & tampilan project. Setiap pembuatan menghasilkan berkas baru, jadi suntingan lama tidak tertimpa.'),
          outList),
        deckcraftPanel(active)),
      h('div', { class: 'card' }, h('h2', {}, 'Pratinjau semua slide'), h('div', { id: 'pv-hasil' }))));
    previewTarget = { el: $('#pv-hasil'), mode: 'all' };
    refreshPreview();
  }

  function deckcraftPanel(active) {
    const p = state.project;
    const dc = state.dc;
    const openHere = dc.running && active && dc.file === active.file;
    const status = !dc.exe ? h('span', {}, 'DeckCraft belum terpasang')
      : dc.running ? h('span', {}, `Terbuka: ${baseName(dc.file)}`, dc.ready ? '' : ' (kontrol jarak jauh tidak aktif)')
        : h('span', { class: 'muted' }, 'Siap. ', h('small', {}, dc.exe));

    const progress = h('div', { class: 'progress hidden' }, h('div'));
    live.dcProgress = progress;
    const installBtn = h('button', { onclick: async () => {
      installBtn.disabled = true; progress.classList.remove('hidden');
      const r = await run(() => api.call('deckcraft:download'));
      installBtn.disabled = false; progress.classList.add('hidden');
      if (r) { toast(`DeckCraft ${r.version} terpasang`); state.settings = await api.call('settings:get'); renderHasil(); }
    } }, '⬇ Pasang DeckCraft');

    const tplName = h('input', { type: 'text', value: `Template ${p.name}`, style: 'max-width:260px' });
    const alsoLib = h('input', { type: 'checkbox' });

    return h('div', { class: 'card dc-panel' },
      h('h2', {}, 'Sunting di DeckCraft'),
      h('div', { class: 'dc-status' }, h('span', { class: 'dot' + (dc.running ? ' on' : '') }), status),
      h('div', { class: 'hint' }, 'DeckCraft dibuka sebagai jendela anak WorshipDeck. Sunting slide sesuka hati (posisi teks, latar, huruf), lalu simpan. Hasil suntingan bisa dijadikan template project ini, jadi pembuatan PPT berikutnya langsung memakai tampilan yang sama.'),
      !dc.exe ? h('div', {}, h('div', { class: 'row' }, installBtn,
        h('button', { class: 'ghost', onclick: async () => { const f = await run(() => api.call('settings:pickDeckcraft')); if (f) renderHasil(); } }, 'Sudah terpasang? Pilih lokasinya…')), progress) : null,
      dc.exe ? h('div', { class: 'row' },
        h('button', { class: 'primary', disabled: !active, onclick: async () => {
          const r = await run(() => api.call('deckcraft:open', { projectId: p.id, file: active.file }));
          if (r) { toast(r.reused ? 'DeckCraft sudah terbuka' : 'DeckCraft dibuka'); renderHasil(); }
        } }, openHere ? 'Tampilkan DeckCraft' : '✏️ Buka di DeckCraft'),
        h('button', { disabled: !openHere || !dc.ready, title: 'Suruh DeckCraft menyimpan suntingan ke berkas ini', onclick: async () => {
          const r = await run(() => api.call('deckcraft:save'), 'Suntingan DeckCraft tersimpan');
          if (r) { state.project = await api.call('project:get', { id: p.id }); renderHasil(); }
        } }, '💾 Simpan dari DeckCraft')) : null,
      h('hr', { style: 'border:none;border-top:1px solid var(--line);margin:14px 0' }),
      h('h3', {}, 'Jadikan template'),
      h('div', { class: 'hint' }, 'Ambil gaya dari PPT terpilih (sebaiknya yang sudah disunting): posisi kotak, huruf, ukuran, warna, dan latar per jenis slide.'),
      h('div', { class: 'row' }, tplName,
        h('label', { class: 'check' }, alsoLib, 'Simpan juga ke pustaka (semua project)')),
      h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { disabled: !active, onclick: async () => {
        const t = await run(() => api.call('deckcraft:saveTemplate', { projectId: p.id, file: active.file, name: tplName.value.trim(), alsoLibrary: alsoLib.checked, setActive: true, resetStyle: true }));
        if (t) {
          toast(`Template "${t.name}" disimpan dan dipakai project ini`);
          state.project = await api.call('project:get', { id: p.id });
          await refreshTemplates(); renderHeader(); renderHasil();
        }
      } }, '⭐ Simpan sebagai template project')));
  }

  /* ---------- Pustaka ---------- */

  async function renderLibrary() {
    state.library = await api.call('library:get');
    const root = $('#view-library');
    root.innerHTML = '';
    const lib = state.library;
    const prevProject = state.project;
    root.append(h('h1', {}, 'Pustaka'), h('p', { class: 'muted' }, 'Berkas dan template di sini bisa dipakai di semua project.'));
    root.append(h('div', { class: 'card' },
      h('h2', {}, 'Berkas pustaka'),
      h('div', { class: 'hint' }, 'Mis. kumpulan lirik lagu, logo gereja, gambar latar. Pilih berkas mana yang dipakai di tab Berkas tiap project.'),
      dropZone('library'),
      lib.files.length ? h('table', { class: 'list' },
        h('tr', {}, h('th', {}, 'Nama'), h('th', {}, 'Jenis'), h('th', {}, 'Ukuran'), h('th', {}, '')),
        lib.files.map((f) => h('tr', {},
          h('td', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); api.call('files:open', { scope: 'library', fileId: f.id }); } }, f.name)),
          h('td', {}, fileKindSelect(f, (kind) => run(() => api.call('files:update', { scope: 'library', fileId: f.id, patch: { kind } })))),
          h('td', { class: 'muted' }, fmtSize(f.size)),
          h('td', {}, h('button', { class: 'small danger', onclick: async () => {
            if (!(await confirmDialog('Hapus berkas pustaka', `Hapus "${f.name}" dari pustaka? Project yang memakainya tidak bisa lagi membacanya.`, 'Hapus'))) return;
            await run(() => api.call('files:remove', { scope: 'library', fileId: f.id }), 'Dihapus');
            renderLibrary();
          } }, 'Hapus')))))
        : h('div', { class: 'empty' }, 'Belum ada berkas.')));
    root.append(h('div', { class: 'card' },
      h('h2', {}, 'Template pustaka'),
      lib.templates.length ? h('div', { class: 'tpl-grid' }, lib.templates.map((t) => h('div', { class: 'tpl' },
        templateThumb(t),
        h('div', { class: 'tpl-info' }, t.name, h('small', {}, t.source === 'deckcraft' ? 'dari DeckCraft' : '')),
        h('div', { class: 'tpl-actions' }, h('button', { class: 'small danger', onclick: async () => {
          if (!(await confirmDialog('Hapus template', `Hapus "${t.name}" dari pustaka?`, 'Hapus'))) return;
          await run(() => api.call('templates:delete', { scope: 'library', templateId: t.id }), 'Dihapus');
          renderLibrary();
        } }, 'Hapus')))))
        : h('div', { class: 'empty' }, 'Belum ada. Simpan template dari tab Hasil dengan centang "Simpan juga ke pustaka".')));
    state.project = prevProject;
  }

  /* ---------- Pengaturan ---------- */

  async function renderSettings() {
    state.settings = await api.call('settings:get');
    const s = state.settings;
    const root = $('#view-settings');
    root.innerHTML = '';
    const keyInput = h('input', { type: 'password', placeholder: s.hasKey ? '•••••••• (tersimpan — isi untuk mengganti)' : 'sk-ant-…', style: 'max-width:420px' });
    const modelSel = h('select', { style: 'max-width:420px' }, state.info.models.map((m) => h('option', { value: m.id }, m.label)));
    modelSel.value = s.model;
    const effortSel = h('select', { style: 'max-width:420px' },
      h('option', { value: 'low' }, 'Rendah — cepat'), h('option', { value: 'medium' }, 'Sedang (disarankan)'), h('option', { value: 'high' }, 'Tinggi — teliti, lebih lama'));
    effortSel.value = s.effort || 'medium';

    root.append(h('h1', {}, 'Pengaturan'), h('p', { class: 'muted' }, `Data tersimpan di ${state.info.dataDir}`));
    root.append(h('div', { class: 'card' },
      h('h2', {}, 'AI (Claude)'),
      field('Kunci API Anthropic', keyInput, s.keyFromEnv ? 'Saat ini memakai ANTHROPIC_API_KEY dari lingkungan.' : 'Dibuat di console.anthropic.com. Disimpan terenkripsi di komputer ini.'),
      field('Model', modelSel),
      field('Ketelitian', effortSel, 'Makin teliti makin lama dan makin mahal.'),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: async () => {
          const args = { model: modelSel.value, effort: effortSel.value };
          if (keyInput.value.trim()) args.apiKey = keyInput.value.trim();
          await run(() => api.call('settings:save', args), 'Pengaturan disimpan');
          renderSettings();
        } }, 'Simpan'),
        s.hasKey && !s.keyFromEnv ? h('button', { class: 'ghost danger', onclick: async () => {
          await run(() => api.call('settings:save', { apiKey: '' }), 'Kunci API dihapus'); renderSettings();
        } }, 'Hapus kunci') : null)));

    root.append(h('div', { class: 'card' },
      h('h2', {}, 'DeckCraft'),
      h('p', {}, s.deckcraftFound ? h('span', {}, h('span', { class: 'badge ok' }, 'Ditemukan'), ' ', s.deckcraftFound) : h('span', { class: 'badge warn' }, 'Belum ditemukan')),
      h('div', { class: 'hint' }, 'WorshipDeck mencari DeckCraft di folder unduhannya sendiri, lokasi instal biasa, dan PATH. Bisa juga dipilih manual.'),
      h('div', { class: 'row' },
        h('button', { onclick: async () => { const f = await run(() => api.call('settings:pickDeckcraft')); if (f) renderSettings(); } }, 'Pilih deckcraft.exe…'),
        s.deckcraftPath ? h('button', { class: 'ghost', onclick: async () => { await run(() => api.call('settings:save', { deckcraftPath: '' })); renderSettings(); } }, 'Cari otomatis') : null,
        h('button', { class: 'ghost', onclick: async () => {
          const r = await run(() => api.call('deckcraft:download'));
          if (r) { toast(`DeckCraft ${r.version} terpasang`); renderSettings(); }
        } }, 'Unduh / perbarui DeckCraft'))));
  }

  /* ---------- awal ---------- */

  async function init() {
    state.info = await api.call('app:info');
    state.settings = await api.call('settings:get');
    await loadProjects();

    $('#btn-new').onclick = newProject;
    $('#btn-new-2').onclick = newProject;
    $('#nav-library').onclick = async () => { if (state.project) await saveNow(); showView('library'); renderLibrary(); };
    $('#nav-settings').onclick = async () => { if (state.project) await saveNow(); showView('settings'); renderSettings(); };
    $$('#tabs button').forEach((b) => { b.onclick = () => selectTab(b.dataset.tab); });
    $('#btn-folder').onclick = () => api.call('project:openFolder', { id: state.project.id });
    $('#btn-duplicate').onclick = async () => {
      const name = await promptDialog('Duplikat project', 'Nama project baru', `${state.project.name} (salinan)`);
      if (name === null) return;
      await saveNow();
      const p = await run(() => api.call('project:duplicate', { id: state.project.id, name }), 'Project diduplikat');
      if (p) { await loadProjects(); openProject(p.id, 'mulai'); }
    };
    $('#btn-delete').onclick = async () => {
      if (!(await confirmDialog('Hapus project', `Hapus project "${state.project.name}" beserta semua berkas dan hasilnya? Tindakan ini tidak bisa dibatalkan.`, 'Hapus permanen'))) return;
      await run(() => api.call('project:delete', { id: state.project.id }), 'Project dihapus');
      state.project = null;
      await loadProjects();
      showView('welcome');
    };

    api.on('menu', (cmd) => { if (cmd === 'new-project') newProject(); });
    api.on('ai:progress', ({ chars }) => { if (live.aiStatus) live.aiStatus.textContent = `AI sedang menyusun… (${chars.toLocaleString('id-ID')} karakter)`; });
    api.on('deckcraft:progress', (pr) => {
      const bar = live.dcProgress;
      if (!bar) return;
      bar.classList.remove('hidden');
      bar.firstChild.style.width = pr.total ? `${Math.round((pr.got / pr.total) * 100)}%` : '50%';
    });
    api.on('deckcraft:exit', async (info) => {
      if (state.project && state.project.id === info.projectId) {
        state.project = await api.call('project:get', { id: info.projectId });
        if (state.tab === 'hasil') renderHasil();
      }
      if (info.changed) {
        const ok = await confirmDialog('DeckCraft ditutup', 'Berkas sudah disunting. Jadikan suntingan ini template project?', 'Jadikan template');
        if (ok && state.project) {
          const t = await run(() => api.call('deckcraft:saveTemplate', { projectId: info.projectId, file: info.file, name: `Template ${state.project.name}`, setActive: true, resetStyle: true }));
          if (t) { toast(`Template "${t.name}" disimpan`); state.project = await api.call('project:get', { id: info.projectId }); await refreshTemplates(); renderHeader(); if (state.tab === 'hasil') renderHasil(); }
        }
      } else toast('DeckCraft ditutup');
    });
    api.on('deckcraft:error', (e) => toast(`DeckCraft: ${e.message}`, true));
    window.addEventListener('resize', schedulePreview);

    if (state.projects.length) openProject(state.projects[0].id);
    else showView('welcome');
  }

  init().catch((e) => toast(e.message, true));
})();
