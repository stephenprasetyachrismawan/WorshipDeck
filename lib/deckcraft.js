/*
 * DeckCraft sebagai "anak" WorshipDeck.
 *
 * DeckCraft (https://github.com/storytold/deckcraft) dijalankan sebagai proses anak dengan
 * `--control <port>`, sehingga WorshipDeck bisa menyuruhnya membuka & menyimpan berkas lewat
 * control protocol (JSON per baris di 127.0.0.1). Saat WorshipDeck ditutup, DeckCraft yang
 * dibukanya ikut ditutup.
 *
 * Bila DeckCraft belum terpasang, WorshipDeck bisa mengunduh versi portable dari rilis GitHub
 * ke folder datanya sendiri.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const RELEASES_API = 'https://api.github.com/repos/storytold/deckcraft/releases/latest';
const EXE = process.platform === 'win32' ? 'deckcraft.exe' : 'deckcraft';

function archTag() {
  const a = process.arch;
  if (process.platform === 'win32') return a === 'arm64' ? 'windows-arm64' : a === 'ia32' ? 'windows-x86' : 'windows-x64';
  if (process.platform === 'darwin') return 'macos-universal';
  return a === 'arm64' ? 'linux-aarch64' : 'linux-x86_64';
}

/** Pilih aset rilis yang cocok untuk sistem ini (versi portable/tanpa instal). */
function pickAsset(assets, tag) {
  const t = tag || archTag();
  const list = assets || [];
  const patterns = t.startsWith('windows')
    ? [new RegExp(`${t}-portable\\.zip$`)]
    : t.startsWith('linux')
      ? [new RegExp(`${t}\\.tar\\.gz$`)]
      : [new RegExp(`${t}\\.dmg$`)];
  for (const re of patterns) {
    const hit = list.find((a) => re.test(a.name) && !/^deckcraft-cli/.test(a.name));
    if (hit) return hit;
  }
  return null;
}

function findInDir(dir, depth) {
  if (!dir || !fs.existsSync(dir)) return null;
  const direct = path.join(dir, EXE);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  if (depth <= 0) return null;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const hit = findInDir(path.join(dir, d.name), depth - 1);
    if (hit) return hit;
  }
  return null;
}

function onPath() {
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    const p = path.join(d, EXE);
    if (d && fs.existsSync(p)) return p;
  }
  return null;
}

/** Cari deckcraft: pengaturan pengguna, unduhan WorshipDeck, lokasi instal umum, lalu PATH. */
function findExecutable(configuredPath, managedDir) {
  if (configuredPath && fs.existsSync(configuredPath)) return configuredPath;
  const candidates = [findInDir(managedDir, 3)];
  if (process.platform === 'win32') {
    const la = process.env.LOCALAPPDATA;
    const pf = process.env.ProgramFiles;
    candidates.push(
      la && findInDir(path.join(la, 'Programs', 'DeckCraft'), 1),
      pf && findInDir(path.join(pf, 'DeckCraft'), 1),
    );
  } else if (process.platform === 'darwin') {
    candidates.push(fs.existsSync('/Applications/DeckCraft.app/Contents/MacOS/deckcraft') ? '/Applications/DeckCraft.app/Contents/MacOS/deckcraft' : null);
  }
  candidates.push(onPath());
  return candidates.find(Boolean) || null;
}

async function download(managedDir, onProgress) {
  const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'WorshipDeck' } });
  if (!res.ok) throw new Error(`Gagal membaca rilis DeckCraft (HTTP ${res.status}).`);
  const release = await res.json();
  const asset = pickAsset(release.assets);
  if (!asset) throw new Error(`Tidak ada unduhan DeckCraft untuk sistem ini (${archTag()}). Pasang manual lalu pilih lokasinya di Pengaturan.`);
  if (!asset.name.endsWith('.zip')) {
    throw new Error(`Unduhan otomatis hanya untuk Windows. Pasang DeckCraft (${asset.name}) secara manual lalu pilih lokasinya di Pengaturan.`);
  }

  const bin = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'WorshipDeck' } });
  if (!bin.ok || !bin.body) throw new Error(`Gagal mengunduh ${asset.name} (HTTP ${bin.status}).`);
  const total = Number(bin.headers.get('content-length')) || asset.size || 0;
  const chunks = [];
  let got = 0;
  for await (const chunk of bin.body) {
    chunks.push(chunk);
    got += chunk.length;
    if (onProgress) onProgress({ phase: 'unduh', got, total });
  }

  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(Buffer.concat(chunks));
  const target = path.join(managedDir, release.tag_name || 'latest');
  fs.rmSync(target, { recursive: true, force: true });
  const entries = Object.values(zip.files);
  let done = 0;
  for (const entry of entries) {
    const dest = path.join(target, entry.name);
    if (!dest.startsWith(target + path.sep)) continue; // tolak path keluar folder (zip slip)
    if (entry.dir) fs.mkdirSync(dest, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, await entry.async('nodebuffer'));
    }
    done++;
    if (onProgress) onProgress({ phase: 'ekstrak', got: done, total: entries.length });
  }
  const exe = findInDir(target, 3);
  if (!exe) throw new Error('DeckCraft terunduh tetapi deckcraft.exe tidak ditemukan di dalamnya.');
  return { exe, version: release.tag_name };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Kirim satu perintah control protocol dan tunggu balasan satu baris. */
function control(port, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('DeckCraft tidak menjawab.')); }, timeoutMs || 65000);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ id: 1, method, params: params || {} }) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      sock.end();
      try {
        const reply = JSON.parse(buf.slice(0, nl));
        if (reply.ok) resolve(reply.result);
        else reject(new Error(`DeckCraft: ${reply.error}`));
      } catch (e) {
        reject(new Error('Balasan DeckCraft tidak bisa dibaca.'));
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function waitForControl(port, child, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error('DeckCraft tertutup sebelum siap.');
    try { await control(port, 'ui.inspect', {}, 3000); return true; } catch { /* belum siap */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * Sesi DeckCraft yang sedang terbuka. Event:
 *  - 'exit' ({file, changed}) saat jendela DeckCraft ditutup.
 */
class DeckCraftSession extends EventEmitter {
  constructor(exe, file) {
    super();
    this.exe = exe;
    this.file = file;
    this.port = null;
    this.child = null;
    this.ready = false;
    this.startMtime = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
  }

  async start() {
    this.port = await freePort();
    this.child = spawn(this.exe, ['--control', String(this.port), this.file], {
      cwd: path.dirname(this.exe),
      stdio: 'ignore',
      windowsHide: false,
    });
    this.child.on('error', (e) => this.emit('error', e));
    this.child.on('exit', () => {
      this.ready = false;
      this.emit('exit', { file: this.file, changed: this.changed() });
    });
    this.ready = await waitForControl(this.port, this.child, 30000);
    return this;
  }

  changed() {
    return fs.existsSync(this.file) && fs.statSync(this.file).mtimeMs > this.startMtime + 1;
  }

  get running() {
    return !!this.child && this.child.exitCode === null;
  }

  /** Suruh DeckCraft menyimpan ke berkas .pptx (default: berkas yang sedang dibuka). */
  async save(targetPath) {
    if (!this.running) throw new Error('DeckCraft tidak sedang terbuka.');
    if (!this.ready) throw new Error('DeckCraft belum siap dikendalikan. Simpan manual dengan Ctrl+S.');
    return control(this.port, 'app.save', { path: targetPath || this.file });
  }

  async inspect() {
    return control(this.port, 'document.inspect', {});
  }

  async focus() {
    if (this.ready) await control(this.port, 'ui.focus', {}).catch(() => {});
  }

  stop() {
    if (!this.running) return;
    const ask = this.ready ? control(this.port, 'app.quit', {}, 3000).catch(() => {}) : Promise.resolve();
    ask.finally(() => setTimeout(() => { if (this.running) this.child.kill(); }, 3000));
  }
}

function defaultManagedDir(userData) {
  return path.join(userData || os.tmpdir(), 'deckcraft');
}

module.exports = { findExecutable, download, pickAsset, archTag, control, DeckCraftSession, defaultManagedDir };
