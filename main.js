/* Proses utama Electron untuk WorshipDeck. */
'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const { Storage } = require('./lib/storage');
const { BUILTIN_TEMPLATES, FILE_KINDS, KIND_LABELS, ITEM_KINDS, defaultSections, isPlainObject } = require('./lib/defaults');
const { normalizeDeck, sampleDeck } = require('./lib/schema');
const { layoutDeck, findTemplate } = require('./lib/layout');
const { writePptx } = require('./lib/engine');
const { templateFromPptx } = require('./lib/template-import');
const ai = require('./lib/ai');
const deckcraft = require('./lib/deckcraft');

let win = null;
let store = null;
let dcSession = null; // DeckCraft yang sedang terbuka
let aiAbort = null;

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

/* ---------- kunci API (dienkripsi dengan safeStorage bila tersedia) ---------- */

function encryptKey(key) {
  if (!key) return '';
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(key).toString('base64');
  return 'b64:' + Buffer.from(key).toString('base64');
}

function decryptKey(stored) {
  if (!stored) return process.env.ANTHROPIC_API_KEY || '';
  try {
    if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    if (stored.startsWith('b64:')) return Buffer.from(stored.slice(4), 'base64').toString('utf8');
  } catch { /* kunci rusak */ }
  return '';
}

/* ---------- bantuan ---------- */

function managedDeckcraftDir() {
  return deckcraft.defaultManagedDir(app.getPath('userData'));
}

function deckcraftExe() {
  return deckcraft.findExecutable(store.getSettings().deckcraftPath, managedDeckcraftDir());
}

function allTemplates(projectId) {
  return [
    ...(projectId ? store.listProjectTemplates(projectId) : []),
    ...store.listLibraryTemplates(),
    ...BUILTIN_TEMPLATES.map((t) => ({ ...t, scope: 'builtin' })),
  ];
}

function layoutOptions(project) {
  const templates = allTemplates(project.id);
  return {
    settings: project.settings,
    sections: project.sections,
    template: findTemplate(project.settings.templateId, templates),
    resolveImage: (ref) => store.filePath(ref, project.id),
  };
}

const dataUrlCache = new Map();
function imageDataUrl(p) {
  const st = fs.statSync(p);
  const key = `${p}:${st.mtimeMs}`;
  if (!dataUrlCache.has(key)) {
    const ext = path.extname(p).slice(1).toLowerCase().replace('jpg', 'jpeg');
    dataUrlCache.set(key, `data:image/${ext || 'png'};base64,${fs.readFileSync(p).toString('base64')}`);
  }
  return dataUrlCache.get(key);
}

function stampName(project) {
  const base = (project.name || 'ibadah').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 60);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${base} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.pptx`;
}

/** Ganti referensi gambar project di template dengan salinan di pustaka (saat template dibagikan). */
function copyImagesToLibrary(value, projectId) {
  if (Array.isArray(value)) return value.map((v) => copyImagesToLibrary(v, projectId));
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'image' && isPlainObject(v) && v.scope !== 'library') {
      const src = store.filePath(v, projectId);
      if (src) {
        const entry = store.addFile('library', null, { sourcePath: src, kind: 'gambar' });
        out[k] = { scope: 'library', id: entry.id };
        continue;
      }
    }
    out[k] = copyImagesToLibrary(v, projectId);
  }
  return out;
}

/* ---------- jendela ---------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 600,
    title: 'WorshipDeck',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#f3f4f7',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => { win = null; });
}

function buildMenu() {
  const template = [
    { label: '&Berkas', submenu: [
      { label: 'Project baru', accelerator: 'CmdOrCtrl+N', click: () => send('menu', 'new-project') },
      { label: 'Buka folder data', click: () => shell.openPath(store.root) },
      { type: 'separator' },
      { role: 'quit', label: 'Keluar' },
    ] },
    { label: '&Sunting', submenu: [
      { role: 'undo', label: 'Urungkan' }, { role: 'redo', label: 'Ulangi' }, { type: 'separator' },
      { role: 'cut', label: 'Potong' }, { role: 'copy', label: 'Salin' }, { role: 'paste', label: 'Tempel' },
      { role: 'selectAll', label: 'Pilih semua' },
    ] },
    { label: '&Tampilan', submenu: [
      { role: 'reload', label: 'Muat ulang' }, { role: 'toggleDevTools', label: 'Alat pengembang' },
      { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen', label: 'Layar penuh' },
    ] },
    { label: 'Ba&ntuan', submenu: [
      { label: 'Tentang DeckCraft', click: () => shell.openExternal('https://github.com/storytold/deckcraft') },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------- IPC ---------- */

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, args) => {
    try {
      return { ok: true, data: await fn(args || {}) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

function registerIpc() {
  handle('app:info', () => ({
    version: app.getVersion(),
    builtinTemplates: BUILTIN_TEMPLATES,
    fileKinds: FILE_KINDS,
    kindLabels: KIND_LABELS,
    itemKinds: ITEM_KINDS,
    models: ai.MODELS,
    defaultSections: defaultSections(),
    dataDir: store.root,
  }));

  /* pengaturan */
  handle('settings:get', () => {
    const s = store.getSettings();
    const exe = deckcraftExe();
    return {
      model: s.ai.model, effort: s.ai.effort,
      hasKey: !!decryptKey(s.ai.apiKeyEnc),
      keyFromEnv: !s.ai.apiKeyEnc && !!process.env.ANTHROPIC_API_KEY,
      deckcraftPath: s.deckcraftPath, deckcraftFound: exe,
    };
  });
  handle('settings:save', (a) => {
    const s = store.getSettings();
    if (a.model) s.ai.model = a.model;
    if (a.effort) s.ai.effort = a.effort;
    if (a.apiKey !== undefined) s.ai.apiKeyEnc = encryptKey(String(a.apiKey).trim());
    if (a.deckcraftPath !== undefined) s.deckcraftPath = a.deckcraftPath;
    store.saveSettings(s);
    return true;
  });
  handle('settings:pickDeckcraft', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Pilih program DeckCraft',
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Program', extensions: ['exe'] }] : [],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const s = store.getSettings();
    s.deckcraftPath = r.filePaths[0];
    store.saveSettings(s);
    return s.deckcraftPath;
  });

  /* project */
  handle('projects:list', () => store.listProjects());
  handle('project:create', (a) => store.createProject(a));
  handle('project:get', (a) => store.getProject(a.id));
  handle('project:update', (a) => store.updateProject(a.id, a.patch));
  handle('project:delete', (a) => { store.deleteProject(a.id); return true; });
  handle('project:duplicate', (a) => store.duplicateProject(a.id, a.name));
  handle('project:openFolder', (a) => shell.openPath(store.projectDir(a.id)));

  /* berkas */
  handle('files:pick', async (a) => {
    const r = await dialog.showOpenDialog(win, {
      title: a.scope === 'library' ? 'Tambah berkas ke pustaka' : 'Tambah berkas ke project',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Dokumen & gambar', extensions: ['pdf', 'docx', 'txt', 'md', 'pptx', 'png', 'jpg', 'jpeg', 'webp', 'gif'] },
        { name: 'Semua berkas', extensions: ['*'] },
      ],
    });
    if (r.canceled) return [];
    return r.filePaths.map((p) => store.addFile(a.scope, a.projectId, { sourcePath: p, kind: a.kind }));
  });
  handle('files:addPaths', (a) => (a.paths || [])
    .filter((p) => fs.existsSync(p) && fs.statSync(p).isFile())
    .map((p) => store.addFile(a.scope, a.projectId, { sourcePath: p, kind: a.kind })));
  handle('files:update', (a) => store.updateFile(a.scope, a.projectId, a.fileId, a.patch || {}));
  handle('files:remove', (a) => { store.removeFile(a.scope, a.projectId, a.fileId); return true; });
  handle('files:open', (a) => {
    const p = store.filePath({ scope: a.scope, id: a.fileId }, a.projectId);
    if (p) shell.openPath(p);
    return !!p;
  });
  handle('files:dataUrl', (a) => {
    const p = store.filePath(a.ref, a.projectId);
    return p ? imageDataUrl(p) : null;
  });

  /* pustaka & template */
  handle('library:get', () => ({ files: store.getLibrary().files, templates: store.listLibraryTemplates() }));
  handle('templates:list', (a) => allTemplates(a.projectId));
  handle('templates:delete', (a) => { store.deleteTemplate(a.scope, a.projectId, a.templateId); return true; });
  handle('templates:rename', (a) => {
    const list = a.scope === 'library' ? store.listLibraryTemplates() : store.listProjectTemplates(a.projectId);
    const t = list.find((x) => x.id === a.templateId);
    if (!t) throw new Error('Template tidak ditemukan');
    t.name = a.name;
    return a.scope === 'library' ? store.saveLibraryTemplate(t) : store.saveProjectTemplate(a.projectId, t);
  });
  handle('templates:promote', (a) => {
    const t = store.listProjectTemplates(a.projectId).find((x) => x.id === a.templateId);
    if (!t) throw new Error('Template tidak ditemukan');
    const copy = copyImagesToLibrary({ ...t, id: `lib-${t.id}` }, a.projectId);
    return store.saveLibraryTemplate(copy);
  });
  handle('templates:importPptx', async (a) => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Ambil template dari berkas PowerPoint',
      properties: ['openFile'],
      filters: [{ name: 'PowerPoint', extensions: ['pptx'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return importTemplate(a.projectId, r.filePaths[0], a.name || path.basename(r.filePaths[0], '.pptx'), a);
  });

  /* AI */
  handle('ai:generate', async (a) => {
    const project = store.getProject(a.projectId);
    const s = store.getSettings();
    aiAbort = new AbortController();
    try {
      const result = await ai.generateDeck({
        project,
        files: store.aiFiles(project.id),
        apiKey: decryptKey(s.ai.apiKeyEnc),
        settings: s.ai,
        signal: aiAbort.signal,
        onProgress: (chars) => send('ai:progress', { chars }),
      });
      // isi meta yang kosong dengan hasil AI, tanpa menimpa isian pengguna
      const meta = { ...result.deck.meta };
      for (const [k, v] of Object.entries(project.meta || {})) if (v) meta[k] = v;
      const deck = { ...result.deck, meta };
      store.updateProject(project.id, { deck, meta });
      return { deck, usage: result.usage, model: result.model };
    } finally {
      aiAbort = null;
    }
  });
  handle('ai:cancel', () => { if (aiAbort) aiAbort.abort(); return true; });

  /* deck */
  handle('deck:normalize', (a) => normalizeDeck(a.deck, store.getProject(a.projectId).sections));
  handle('deck:layout', (a) => {
    const project = store.getProject(a.projectId);
    if (a.settings) project.settings = a.settings;
    if (a.sections) project.sections = a.sections;
    const deck = a.deck || project.deck || normalizeDeck(sampleDeck(), project.sections);
    const result = layoutDeck(deck, layoutOptions(project));
    for (const s of result.slides) {
      if (s.background.image) {
        try { s.background.imageUrl = imageDataUrl(s.background.image); } catch { /* gambar hilang */ }
        delete s.background.image;
      }
    }
    return { ...result, isSample: !a.deck && !project.deck };
  });
  handle('deck:build', async (a) => {
    const project = store.getProject(a.projectId);
    if (!project.deck || !project.deck.items.length) throw new Error('Isi slide masih kosong. Susun dengan AI atau isi JSON dulu.');
    const out = path.join(store.outputDir(project.id), stampName(project));
    const manifest = await writePptx(project.deck, layoutOptions(project), out);
    fs.writeFileSync(out + '.manifest.json', JSON.stringify(manifest, null, 2));
    store.recordOutput(project.id, { file: out, createdAt: new Date().toISOString(), slides: manifest.slides.length, templateId: manifest.templateId, edited: false });
    return { file: out, slides: manifest.slides.length };
  });
  handle('deck:saveAs', async (a) => {
    const project = store.getProject(a.projectId);
    const src = a.file || project.activeOutput;
    if (!src || !fs.existsSync(src)) throw new Error('Belum ada hasil PPT.');
    const r = await dialog.showSaveDialog(win, {
      title: 'Simpan PPT',
      defaultPath: path.basename(src),
      filters: [{ name: 'PowerPoint', extensions: ['pptx'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.copyFileSync(src, r.filePath);
    return r.filePath;
  });
  handle('deck:openFile', (a) => shell.openPath(a.file));
  handle('deck:showInFolder', (a) => { shell.showItemInFolder(a.file); return true; });

  /* DeckCraft */
  handle('deckcraft:status', () => ({
    exe: deckcraftExe(),
    running: !!(dcSession && dcSession.running),
    ready: !!(dcSession && dcSession.ready),
    file: dcSession && dcSession.running ? dcSession.file : null,
  }));
  handle('deckcraft:download', async () => {
    const r = await deckcraft.download(managedDeckcraftDir(), (p) => send('deckcraft:progress', p));
    const s = store.getSettings();
    s.deckcraftPath = r.exe;
    store.saveSettings(s);
    return r;
  });
  handle('deckcraft:open', async (a) => {
    const project = store.getProject(a.projectId);
    const file = a.file || project.activeOutput;
    if (!file || !fs.existsSync(file)) throw new Error('Buat PPT dulu sebelum membukanya di DeckCraft.');
    const exe = deckcraftExe();
    if (!exe) throw new Error('DeckCraft belum terpasang. Unduh lewat tombol "Pasang DeckCraft" atau pilih lokasinya di Pengaturan.');
    if (dcSession && dcSession.running) {
      if (dcSession.file === file) { await dcSession.focus(); return { file, reused: true }; }
      throw new Error('DeckCraft masih membuka berkas lain. Simpan & tutup dulu jendela DeckCraft.');
    }
    dcSession = new deckcraft.DeckCraftSession(exe, file);
    dcSession.projectId = project.id;
    dcSession.on('exit', (info) => {
      if (info.changed) markEdited(dcSession.projectId, info.file);
      send('deckcraft:exit', { ...info, projectId: dcSession.projectId });
    });
    dcSession.on('error', (e) => send('deckcraft:error', { message: e.message }));
    await dcSession.start();
    return { file, ready: dcSession.ready };
  });
  handle('deckcraft:save', async () => {
    if (!dcSession || !dcSession.running) throw new Error('DeckCraft tidak sedang terbuka.');
    await dcSession.save();
    markEdited(dcSession.projectId, dcSession.file);
    return { file: dcSession.file };
  });
  handle('deckcraft:saveTemplate', async (a) => {
    const project = store.getProject(a.projectId);
    const file = a.file || project.activeOutput;
    if (!file || !fs.existsSync(file)) throw new Error('Belum ada PPT untuk dijadikan template.');
    // bila masih terbuka di DeckCraft, simpan dulu supaya suntingan terakhir ikut
    if (dcSession && dcSession.running && dcSession.ready && dcSession.file === file) {
      await dcSession.save();
      markEdited(project.id, file);
    }
    return importTemplate(project.id, file, a.name, a);
  });
}

function markEdited(projectId, file) {
  try {
    const p = store.getProject(projectId);
    const o = (p.outputs || []).find((x) => x.file === file);
    if (o) { o.edited = true; o.editedAt = new Date().toISOString(); store.saveProject(p); }
  } catch { /* project terhapus */ }
}

async function importTemplate(projectId, file, name, opts) {
  const project = store.getProject(projectId);
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(file + '.manifest.json', 'utf8')); } catch { /* bukan buatan WorshipDeck */ }
  const base = findTemplate(project.settings.templateId, allTemplates(projectId));
  const template = await templateFromPptx(fs.readFileSync(file), {
    name: name || `Template ${project.name}`,
    manifest,
    baseTemplate: base,
    saveImage: (imgName, buffer) => {
      const entry = store.addFile('project', projectId, { buffer, name: `latar-${imgName}`, kind: 'gambar' });
      return { scope: 'project', id: entry.id, projectId };
    },
  });
  if (!Object.keys(template.layouts).length) {
    throw new Error('Tidak ada slide yang dikenali di berkas ini. Pakai PPT yang dibuat WorshipDeck (boleh sudah disunting).');
  }
  store.saveProjectTemplate(projectId, template);
  if (opts && opts.alsoLibrary) {
    store.saveLibraryTemplate(copyImagesToLibrary({ ...template, id: `lib-${template.id}` }, projectId));
  }
  if (!opts || opts.setActive !== false) {
    const p = store.getProject(projectId);
    p.settings.templateId = template.id;
    // gaya yang diatur manual sebelumnya akan menimpa template baru; kosongkan agar hasil DeckCraft terlihat
    if (opts && opts.resetStyle) p.settings.style = {};
    store.saveProject(p);
  }
  return template;
}

/* ---------- mulai ---------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    store = new Storage(path.join(app.getPath('userData'), 'data'));
    registerIpc();
    buildMenu();
    createWindow();
  });
  app.on('before-quit', () => { if (dcSession) dcSession.stop(); });
  app.on('window-all-closed', () => app.quit());
}
