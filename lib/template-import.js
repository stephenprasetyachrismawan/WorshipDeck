/*
 * Ambil template dari .pptx yang sudah disunting (di DeckCraft atau aplikasi lain).
 *
 * Untuk tiap jenis slide (lagu, bacaan, dll.) diambil slide pertama jenis itu, lalu dibaca:
 * posisi & ukuran kotak judul/isi/subjudul/footer, huruf, ukuran, warna, perataan, dan latar
 * (warna atau gambar). Hasilnya template WorshipDeck biasa dengan `layouts` per jenis,
 * sehingga project berikutnya langsung memakai tampilan hasil suntingan itu.
 *
 * Jenis slide dikenali dari catatan "wd:kind=..." yang ditulis mesin. Bila catatan hilang,
 * dipakai manifest (urutan slide saat dibuat). Kotak dikenali dari nama "wd:<peran>";
 * bila nama hilang, ditebak dari posisi dan ukuran.
 */
'use strict';

const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
const { ITEM_KINDS } = require('./defaults');

const EMU = 914400;
const ROLES = ['title', 'subtitle', 'body', 'footer'];

const attr = (xml, name) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(xml || '');
  return m ? m[1] : null;
};

function relsOf(xml) {
  const map = {};
  const re = /<Relationship\b[^>]*>/g;
  let m;
  while ((m = re.exec(xml || ''))) map[attr(m[0], 'Id')] = { target: attr(m[0], 'Target'), type: attr(m[0], 'Type') };
  return map;
}

function resolveTarget(fromPart, target) {
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromPart), target));
}

function colorIn(xml) {
  const m = /<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/.exec(xml || '');
  return m ? '#' + m[1].toUpperCase() : null;
}

/** Baca satu bentuk teks (<p:sp>) menjadi ringkasan gaya & posisi. */
function readShape(sp) {
  const name = attr(/<p:cNvPr\b[^>]*>/.exec(sp)?.[0], 'name') || '';
  const off = /<a:off\b[^>]*>/.exec(sp)?.[0];
  const ext = /<a:ext\b[^>]*cx=[^>]*>/.exec(sp)?.[0];
  const text = (sp.match(/<a:t>([^<]*)<\/a:t>/g) || []).map((t) => t.replace(/<\/?a:t>/g, '')).join(' ').trim();
  if (!off || !ext) return null;
  // gaya diambil dari run dengan teks terpanjang, supaya label "P :" atau nomor ayat
  // (berwarna aksen) tidak dianggap warna teks utama
  let rPr = '';
  let longest = -1;
  for (const run of sp.match(/<a:r>[\s\S]*?<\/a:r>/g) || []) {
    const len = (/<a:t>([^<]*)<\/a:t>/.exec(run)?.[1] || '').length;
    if (len > longest) {
      longest = len;
      rPr = /<a:rPr\b[^>]*\/>|<a:rPr\b[^>]*>[\s\S]*?<\/a:rPr>/.exec(run)?.[0] || '';
    }
  }
  if (!rPr) rPr = /<a:defRPr\b[^>]*\/?>/.exec(sp)?.[0] || '';
  const sz = attr(rPr, 'sz');
  const b = attr(rPr, 'b');
  const algn = attr(/<a:pPr\b[^>]*>/.exec(sp)?.[0], 'algn');
  const font = /<a:latin\b[^>]*typeface="([^"]+)"/.exec(rPr)?.[1];
  const round = (v) => Math.round(v * 1000) / 1000;
  return {
    name,
    text,
    x: round(Number(attr(off, 'x')) / EMU),
    y: round(Number(attr(off, 'y')) / EMU),
    w: round(Number(attr(ext, 'cx')) / EMU),
    h: round(Number(attr(ext, 'cy')) / EMU),
    fontSize: sz ? Number(sz) / 100 : undefined,
    bold: b === null ? undefined : b === '1' || b === 'true',
    color: colorIn(rPr) || undefined,
    fontFace: font && !font.startsWith('+') ? font : undefined,
    align: { l: 'left', ctr: 'center', r: 'right', just: 'justify' }[algn] || undefined,
  };
}

/** Tebak peran kotak tanpa nama: yang paling atas = judul, terbesar = isi, terbawah & kecil = footer. */
function guessRoles(shapes) {
  const out = {};
  const named = shapes.filter((s) => /^wd:/.test(s.name));
  for (const s of named) {
    const role = s.name.slice(3);
    if (ROLES.includes(role) && !out[role]) out[role] = s;
  }
  if (out.title || out.body) return out;
  const texts = shapes.filter((s) => s.text);
  if (!texts.length) return out;
  const byArea = [...texts].sort((a, b) => b.w * b.h - a.w * a.h);
  out.body = byArea[0];
  const rest = texts.filter((s) => s !== out.body).sort((a, b) => a.y - b.y);
  if (rest[0] && rest[0].y < out.body.y) out.title = rest[0];
  return out;
}

function cleanBox(s) {
  if (!s) return undefined;
  const { name, text, ...box } = s;
  for (const k of Object.keys(box)) if (box[k] === undefined) delete box[k];
  return box;
}

async function readBackground(zip, slidePart, slideXml, rels, saveImage) {
  const bg = /<p:bg>([\s\S]*?)<\/p:bg>/.exec(slideXml)?.[1];
  if (!bg) return null;
  const embed = /<a:blip\b[^>]*r:embed="([^"]+)"/.exec(bg)?.[1];
  if (embed && rels[embed]) {
    const part = resolveTarget(slidePart, rels[embed].target);
    const file = zip.file(part);
    if (file && saveImage) {
      const data = await file.async('nodebuffer');
      const ref = await saveImage(path.posix.basename(part), data);
      if (ref) return { type: 'image', image: ref, color: colorIn(bg) || undefined };
    }
  }
  const color = colorIn(bg);
  return color ? { type: 'color', color } : null;
}

async function notesKind(zip, rels, slidePart) {
  const notesRel = Object.values(rels).find((r) => /notesSlide$/.test(r.type || ''));
  if (!notesRel) return null;
  const xml = await zip.file(resolveTarget(slidePart, notesRel.target))?.async('string');
  const m = /wd:kind=([a-z]+)/.exec(xml || '');
  return m && ITEM_KINDS.includes(m[1]) ? m[1] : null;
}

function slideOrder(presXml, presRels) {
  const ids = [...(presXml.match(/<p:sldId\b[^>]*>/g) || [])].map((t) => attr(t, 'r:id'));
  return ids.map((id) => presRels[id] && resolveTarget('ppt/presentation.xml', presRels[id].target)).filter(Boolean);
}

/**
 * @param {Buffer} buffer isi .pptx
 * @param {object} opts { name, manifest, baseTemplate, saveImage(name, buffer) -> ref }
 */
async function templateFromPptx(buffer, opts) {
  const o = opts || {};
  const zip = await JSZip.loadAsync(buffer);
  const presXml = await zip.file('ppt/presentation.xml').async('string');
  const presRels = relsOf(await zip.file('ppt/_rels/presentation.xml.rels').async('string'));
  const sldSz = /<p:sldSz\b[^>]*>/.exec(presXml)?.[0];
  const w = sldSz ? Number(attr(sldSz, 'cx')) / EMU : 13.333;
  const h = sldSz ? Number(attr(sldSz, 'cy')) / EMU : 7.5;
  const slideSize = Math.abs(w / h - 4 / 3) < 0.05 ? '4:3' : '16:9';

  const parts = slideOrder(presXml, presRels);
  const layouts = {};
  const counts = {};
  const imageCache = new Map();
  const saveOnce = async (name, data) => {
    const key = crypto.createHash('sha1').update(data).digest('hex');
    if (!imageCache.has(key)) imageCache.set(key, o.saveImage ? await o.saveImage(name, data) : null);
    return imageCache.get(key);
  };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const xml = await zip.file(part)?.async('string');
    if (!xml) continue;
    const relsPart = path.posix.join(path.posix.dirname(part), '_rels', path.posix.basename(part) + '.rels');
    const rels = relsOf(await zip.file(relsPart)?.async('string'));
    const fromManifest = o.manifest && o.manifest.slides && o.manifest.slides[i] && o.manifest.slides[i].kind;
    const kind = (await notesKind(zip, rels, part)) || fromManifest;
    if (!kind) continue;
    counts[kind] = (counts[kind] || 0) + 1;
    if (layouts[kind]) continue; // slide pertama tiap jenis menjadi acuannya

    const shapes = (xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || []).map(readShape).filter(Boolean);
    const roles = guessRoles(shapes);
    const boxes = {};
    for (const r of ROLES) if (roles[r]) boxes[r] = cleanBox(roles[r]);
    layouts[kind] = { boxes };
    const bg = await readBackground(zip, part, xml, rels, saveOnce);
    if (bg) layouts[kind].background = bg;
  }

  const base = o.baseTemplate || {};
  const pickFrom = (kinds, role) => kinds.map((k) => layouts[k]?.boxes?.[role]).find(Boolean) || {};
  const title = pickFrom(['song', 'text', 'responsive', 'scripture', 'announcement', 'heading'], 'title');
  const body = pickFrom(['text', 'responsive', 'scripture', 'announcement', 'song'], 'body');
  const lyrics = layouts.song?.boxes?.body || {};
  const firstBg = ['song', 'text', 'responsive', 'scripture', 'heading', 'announcement'].map((k) => layouts[k]?.background).find(Boolean);

  const template = {
    id: o.id || 'tpl-' + Date.now().toString(36),
    name: o.name || 'Template dari DeckCraft',
    builtin: false,
    source: 'deckcraft',
    createdAt: new Date().toISOString(),
    slideSize,
    background: firstBg || base.background || { type: 'color', color: '#000000' },
    fonts: {
      heading: title.fontFace || base.fonts?.heading || 'Segoe UI',
      body: body.fontFace || base.fonts?.body || 'Segoe UI',
    },
    colors: {
      heading: title.color || base.colors?.heading || '#FFFFFF',
      body: body.color || base.colors?.body || '#FFFFFF',
      accent: base.colors?.accent || '#F5C451',
      muted: layouts.song?.boxes?.footer?.color || base.colors?.muted || '#AAAAAA',
    },
    sizes: {
      heading: title.fontSize || base.sizes?.heading || 40,
      body: body.fontSize || base.sizes?.body || 32,
      lyrics: lyrics.fontSize || base.sizes?.lyrics || 38,
      small: layouts.song?.boxes?.footer?.fontSize || base.sizes?.small || 16,
    },
    align: {
      heading: title.align || base.align?.heading || 'center',
      body: body.align || base.align?.body || 'center',
    },
    uppercaseHeadings: base.uppercaseHeadings || false,
    layouts,
    stats: counts,
  };
  return template;
}

module.exports = { templateFromPptx, readShape, guessRoles };
