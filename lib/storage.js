/*
 * Penyimpanan di disk. Struktur folder:
 *
 *   <root>/settings.json                 pengaturan aplikasi (AI, DeckCraft)
 *   <root>/library/library.json          daftar berkas & template untuk semua project
 *   <root>/library/files/                berkas pustaka
 *   <root>/library/templates/<id>.json   template pustaka
 *   <root>/projects/<id>/project.json    pengaturan, bagian, isi (JSON), daftar berkas
 *   <root>/projects/<id>/files/          berkas khusus project (liturgi, warta, gambar, ...)
 *   <root>/projects/<id>/templates/      template khusus project (mis. hasil DeckCraft)
 *   <root>/projects/<id>/output/         hasil .pptx
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { defaultSections, defaultProjectSettings, defaultMeta, FILE_KINDS } = require('./defaults');

const newId = (prefix) => `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** Tulis atomik: tulis ke berkas sementara lalu ganti nama, supaya tidak rusak bila listrik padam. */
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function safeName(name) {
  const base = path.basename(String(name || 'berkas')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
  return base || 'berkas';
}

function guessKind(name) {
  const n = name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp)$/.test(n)) return 'gambar';
  if (/warta|pengumuman|berita/.test(n)) return 'warta';
  if (/liturgi|tata.?ibadah|tata.?cara/.test(n)) return 'liturgi';
  if (/lagu|kj|pkj|nkb|lirik/.test(n)) return 'lagu';
  if (/alkitab|bacaan|leksionari/.test(n)) return 'alkitab';
  return 'lain';
}

class Storage {
  constructor(root) {
    this.root = root;
    fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(root, 'library', 'files'), { recursive: true });
    fs.mkdirSync(path.join(root, 'library', 'templates'), { recursive: true });
  }

  /* ---------- pengaturan aplikasi ---------- */

  getSettings() {
    return {
      ai: { model: 'claude-opus-5-5', effort: 'medium', apiKeyEnc: '' },
      deckcraftPath: '',
      ...readJson(path.join(this.root, 'settings.json'), {}),
    };
  }

  saveSettings(settings) {
    writeJson(path.join(this.root, 'settings.json'), settings);
    return settings;
  }

  /* ---------- project ---------- */

  projectDir(id) {
    if (!/^[\w-]+$/.test(String(id))) throw new Error('ID project tidak sah');
    return path.join(this.root, 'projects', id);
  }

  listProjects() {
    const dir = path.join(this.root, 'projects');
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => readJson(path.join(dir, d.name, 'project.json'), null))
      .filter(Boolean)
      .map((p) => ({ id: p.id, name: p.name, date: p.meta && p.meta.date, updatedAt: p.updatedAt }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  createProject(fields) {
    const f = fields || {};
    const id = newId('p');
    const now = new Date().toISOString();
    const project = {
      id,
      name: f.name || 'Project baru',
      createdAt: now,
      updatedAt: now,
      meta: { ...defaultMeta(), ...(f.meta || {}) },
      settings: { ...defaultProjectSettings(), ...(f.settings || {}) },
      sections: f.sections || defaultSections(),
      files: [],
      libraryFiles: [], // id berkas pustaka yang dipakai project ini
      deck: null,
      outputs: [],
      activeOutput: null,
    };
    for (const sub of ['files', 'templates', 'output']) fs.mkdirSync(path.join(this.projectDir(id), sub), { recursive: true });
    writeJson(path.join(this.projectDir(id), 'project.json'), project);
    return project;
  }

  /** Salin project tanpa berkas & hasil: cocok untuk ibadah minggu berikutnya. */
  duplicateProject(id, name) {
    const src = this.getProject(id);
    const copy = this.createProject({
      name: name || `${src.name} (salinan)`,
      meta: { ...src.meta, date: '', theme: '' },
      settings: src.settings,
      sections: src.sections,
    });
    for (const t of this.listProjectTemplates(id)) this.saveProjectTemplate(copy.id, t);
    copy.libraryFiles = [...(src.libraryFiles || [])];
    return this.saveProject(copy);
  }

  getProject(id) {
    const p = readJson(path.join(this.projectDir(id), 'project.json'), null);
    if (!p) throw new Error('Project tidak ditemukan');
    return p;
  }

  saveProject(project) {
    project.updatedAt = new Date().toISOString();
    writeJson(path.join(this.projectDir(project.id), 'project.json'), project);
    return project;
  }

  updateProject(id, patch) {
    const p = this.getProject(id);
    const allowed = ['name', 'meta', 'settings', 'sections', 'deck', 'libraryFiles', 'activeOutput'];
    for (const k of allowed) if (patch && patch[k] !== undefined) p[k] = patch[k];
    return this.saveProject(p);
  }

  deleteProject(id) {
    fs.rmSync(this.projectDir(id), { recursive: true, force: true });
  }

  /* ---------- berkas ---------- */

  _filesDir(scope, projectId) {
    return scope === 'library' ? path.join(this.root, 'library', 'files') : path.join(this.projectDir(projectId), 'files');
  }

  _uniqueStored(dir, name) {
    const ext = path.extname(name);
    const stem = path.basename(name, ext);
    let candidate = name;
    for (let i = 2; fs.existsSync(path.join(dir, candidate)); i++) candidate = `${stem} (${i})${ext}`;
    return candidate;
  }

  /** Simpan berkas dari path atau buffer ke project/pustaka. */
  addFile(scope, projectId, { sourcePath, buffer, name, kind }) {
    const dir = this._filesDir(scope, projectId);
    fs.mkdirSync(dir, { recursive: true });
    const display = safeName(name || (sourcePath && path.basename(sourcePath)));
    const stored = this._uniqueStored(dir, display);
    if (buffer) fs.writeFileSync(path.join(dir, stored), buffer);
    else fs.copyFileSync(sourcePath, path.join(dir, stored));
    const entry = {
      id: newId('f'),
      name: display,
      stored,
      kind: kind && FILE_KINDS[kind] ? kind : guessKind(display),
      size: fs.statSync(path.join(dir, stored)).size,
      addedAt: new Date().toISOString(),
      useForAi: !/\.(png|jpe?g|gif|webp|bmp)$/i.test(display),
    };
    if (scope === 'library') {
      const lib = this.getLibrary();
      lib.files.push(entry);
      this._saveLibrary(lib);
    } else {
      const p = this.getProject(projectId);
      p.files.push(entry);
      this.saveProject(p);
    }
    return entry;
  }

  updateFile(scope, projectId, fileId, patch) {
    const apply = (files) => {
      const f = files.find((x) => x.id === fileId);
      if (!f) throw new Error('Berkas tidak ditemukan');
      if (patch.kind && FILE_KINDS[patch.kind]) f.kind = patch.kind;
      if (patch.useForAi !== undefined) f.useForAi = !!patch.useForAi;
      if (patch.note !== undefined) f.note = String(patch.note);
      return f;
    };
    if (scope === 'library') {
      const lib = this.getLibrary();
      const f = apply(lib.files);
      this._saveLibrary(lib);
      return f;
    }
    const p = this.getProject(projectId);
    const f = apply(p.files);
    this.saveProject(p);
    return f;
  }

  removeFile(scope, projectId, fileId) {
    const dir = this._filesDir(scope, projectId);
    const drop = (files) => {
      const f = files.find((x) => x.id === fileId);
      if (f) fs.rmSync(path.join(dir, f.stored), { force: true });
      return files.filter((x) => x.id !== fileId);
    };
    if (scope === 'library') {
      const lib = this.getLibrary();
      lib.files = drop(lib.files);
      this._saveLibrary(lib);
    } else {
      const p = this.getProject(projectId);
      p.files = drop(p.files);
      this.saveProject(p);
    }
  }

  /** Path absolut berkas, dari referensi {scope, id} atau {scope, stored}. */
  filePath(ref, projectId) {
    if (!ref) return null;
    const scope = ref.scope === 'library' ? 'library' : 'project';
    const pid = ref.projectId || projectId;
    const list = scope === 'library' ? this.getLibrary().files : (pid ? this.getProject(pid).files : []);
    const entry = list.find((f) => f.id === ref.id) || list.find((f) => f.stored === ref.stored);
    if (!entry) return null;
    const p = path.join(this._filesDir(scope, pid), entry.stored);
    return fs.existsSync(p) ? p : null;
  }

  /** Semua berkas yang dikirim ke AI: berkas project + berkas pustaka yang dipilih project. */
  aiFiles(projectId) {
    const p = this.getProject(projectId);
    const lib = this.getLibrary();
    const own = p.files.filter((f) => f.useForAi).map((f) => ({ ...f, scope: 'project', path: path.join(this._filesDir('project', projectId), f.stored) }));
    const shared = lib.files
      .filter((f) => (p.libraryFiles || []).includes(f.id))
      .map((f) => ({ ...f, scope: 'library', path: path.join(this._filesDir('library'), f.stored) }));
    return [...own, ...shared].filter((f) => fs.existsSync(f.path));
  }

  /* ---------- pustaka ---------- */

  getLibrary() {
    return { files: [], ...readJson(path.join(this.root, 'library', 'library.json'), {}) };
  }

  _saveLibrary(lib) {
    writeJson(path.join(this.root, 'library', 'library.json'), lib);
  }

  /* ---------- template ---------- */

  _listTemplates(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f), null)).filter(Boolean);
  }

  listProjectTemplates(projectId) {
    return this._listTemplates(path.join(this.projectDir(projectId), 'templates')).map((t) => ({ ...t, scope: 'project' }));
  }

  listLibraryTemplates() {
    return this._listTemplates(path.join(this.root, 'library', 'templates')).map((t) => ({ ...t, scope: 'library' }));
  }

  saveProjectTemplate(projectId, template) {
    const t = { ...template, scope: undefined };
    writeJson(path.join(this.projectDir(projectId), 'templates', `${safeId(t.id)}.json`), t);
    return t;
  }

  saveLibraryTemplate(template) {
    const t = { ...template, scope: undefined };
    writeJson(path.join(this.root, 'library', 'templates', `${safeId(t.id)}.json`), t);
    return t;
  }

  deleteTemplate(scope, projectId, templateId) {
    const dir = scope === 'library' ? path.join(this.root, 'library', 'templates') : path.join(this.projectDir(projectId), 'templates');
    fs.rmSync(path.join(dir, `${safeId(templateId)}.json`), { force: true });
  }

  /* ---------- hasil ---------- */

  outputDir(projectId) {
    const d = path.join(this.projectDir(projectId), 'output');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  recordOutput(projectId, entry) {
    const p = this.getProject(projectId);
    p.outputs = [entry, ...(p.outputs || []).filter((o) => o.file !== entry.file)].slice(0, 30);
    p.activeOutput = entry.file;
    return this.saveProject(p);
  }
}

function safeId(id) {
  return String(id).replace(/[^\w-]/g, '_');
}

module.exports = { Storage, guessKind, safeName };
