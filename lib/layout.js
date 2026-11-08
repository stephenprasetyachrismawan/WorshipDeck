/*
 * Mesin tata letak: deck JSON + template + pengaturan -> daftar slide berisi kotak teks.
 * Hasilnya dipakai dua tempat: pembuat .pptx (engine.js) dan pratinjau di layar,
 * jadi apa yang terlihat di pratinjau sama dengan isi PPT.
 * Satuan posisi: inci. Ukuran huruf: poin.
 */
'use strict';

const { BUILTIN_TEMPLATES, deepMerge } = require('./defaults');

const SLIDE_SIZES = {
  '16:9': { w: 13.333, h: 7.5 },
  '4:3': { w: 10, h: 7.5 },
};

const CHAR_WIDTH = 0.5; // lebar rata-rata satu huruf, relatif terhadap ukuran huruf
const LINE_HEIGHT = 1.2;

function findTemplate(id, extraTemplates) {
  const all = [...(extraTemplates || []), ...BUILTIN_TEMPLATES];
  return all.find((t) => t.id === id) || BUILTIN_TEMPLATES[0];
}

/** Gaya akhir = template dasar ditimpa pengaturan project (hanya kunci yang diisi pengguna). */
function resolveStyle(template, settings) {
  const base = deepMerge(BUILTIN_TEMPLATES[0], {});
  delete base.layouts;
  const fromTemplate = deepMerge(base, { ...template, layouts: undefined });
  return deepMerge(fromTemplate, (settings && settings.style) || {});
}

function slideSize(settings, template) {
  return SLIDE_SIZES[(settings && settings.slideSize) || (template && template.slideSize)] || SLIDE_SIZES['16:9'];
}

/* ---------- perkiraan muat teks ---------- */

function charsPerLine(boxW, fontSize) {
  return Math.max(8, Math.floor((boxW * 72) / (fontSize * CHAR_WIDTH)));
}

function linesCapacity(boxH, fontSize) {
  return Math.max(1, Math.floor((boxH * 72) / (fontSize * LINE_HEIGHT)));
}

function wrappedLines(text, boxW, fontSize) {
  const cpl = charsPerLine(boxW, fontSize);
  return String(text).split('\n').reduce((n, part) => n + Math.max(1, Math.ceil(part.length / cpl)), 0);
}

/** Pecah paragraf yang terlalu panjang menjadi potongan yang muat (per kalimat, lalu per kata). */
function splitLongText(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const sentences = text.match(/[^.!?;:]+[.!?;:]*\s*/g) || [text];
  const out = [];
  let cur = '';
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (const sen of sentences) {
    if ((cur + sen).length <= maxChars) { cur += sen; continue; }
    push();
    if (sen.length <= maxChars) { cur = sen; continue; }
    for (const word of sen.split(/\s+/)) {
      if ((cur + ' ' + word).trim().length > maxChars) push();
      cur = (cur + ' ' + word).trim() + ' ';
    }
  }
  push();
  return out;
}

/**
 * Kemas paragraf ke beberapa slide. `units` = [{paragraph, text}] dengan `text` untuk menaksir
 * panjang. Kembalikan array halaman, tiap halaman array paragraf.
 */
function packParagraphs(units, box, fontSize, maxLines) {
  const cap = Math.min(linesCapacity(box.h, fontSize), maxLines || Infinity);
  const maxChars = Math.max(20, charsPerLine(box.w, fontSize) * cap);
  const pieces = [];
  for (const u of units) {
    const parts = u.split ? splitLongText(u.text, maxChars) : [u.text];
    parts.forEach((t, i) => pieces.push(u.make(t, i)));
  }
  const pages = [];
  let page = [];
  let used = 0;
  for (const p of pieces) {
    const n = wrappedLines(p.measure, box.w, fontSize);
    if (page.length && used + n > cap) { pages.push(page); page = []; used = 0; }
    page.push(p.paragraph);
    used += n;
  }
  if (page.length) pages.push(page);
  return pages.length ? pages : [[]];
}

/* ---------- kotak & latar ---------- */

function defaultBoxes(size) {
  const { w, h } = size;
  return {
    title: { x: 0.5, y: 0.3, w: w - 1, h: 1.0 },
    subtitle: { x: 0.5, y: 1.2, w: w - 1, h: 0.5 },
    body: { x: 0.7, y: 1.75, w: w - 1.4, h: h - 2.55 },
    footer: { x: 0.5, y: h - 0.6, w: w - 1, h: 0.4 },
    headingTitle: { x: 0.75, y: h / 2 - 1.1, w: w - 1.5, h: 1.6 },
    headingSubtitle: { x: 0.75, y: h / 2 + 0.55, w: w - 1.5, h: 0.8 },
  };
}

/** Kotak untuk satu peran, memperhitungkan tata letak per jenis dari template (hasil DeckCraft). */
function boxFor(role, kind, ctx) {
  const defaults = ctx.boxes;
  const key = kind === 'heading' ? (role === 'title' ? 'headingTitle' : role === 'subtitle' ? 'headingSubtitle' : role) : role;
  const geom = { ...(defaults[key] || defaults.body) };
  const layout = ctx.template.layouts && ctx.template.layouts[kind];
  const fromLayout = (layout && layout.boxes && layout.boxes[role]) || {};
  return { ...geom, ...pick(fromLayout, ['x', 'y', 'w', 'h']), _layout: fromLayout };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k];
  return out;
}

/** Urutan prioritas latar: bagian > pengaturan project > tata letak template > template. */
function backgroundFor(kind, section, ctx) {
  const userBg = ctx.settings.style && ctx.settings.style.background;
  const layout = ctx.template.layouts && ctx.template.layouts[kind];
  const candidates = [section && section.background, userBg, layout && layout.background, ctx.template.background, { type: 'color', color: '#000000' }];
  const bg = candidates.find((b) => b && (b.type === 'image' ? b.image : b.color));
  const out = { color: bg.color || ctx.style.background.color || '#000000' };
  if (bg.type === 'image' && bg.image) {
    const p = ctx.resolveImage ? ctx.resolveImage(bg.image) : null;
    if (p) out.image = p;
  }
  return out;
}

/* ---------- pembentuk slide ---------- */

function textBox(role, kind, ctx, paragraphs, opts) {
  const box = opts.box || boxFor(role, kind, ctx);
  const l = box._layout || {};
  const userSizes = (ctx.settings.style && ctx.settings.style.sizes) || {};
  const userFonts = (ctx.settings.style && ctx.settings.style.fonts) || {};
  const userColors = (ctx.settings.style && ctx.settings.style.colors) || {};
  const sizeKey = opts.sizeKey;
  const fontKey = opts.fontKey || 'body';
  const colorKey = opts.colorKey || 'body';
  return {
    role,
    x: box.x, y: box.y, w: box.w, h: box.h,
    fontFace: userFonts[fontKey] || l.fontFace || ctx.style.fonts[fontKey],
    fontSize: opts.fontSize || userSizes[sizeKey] || l.fontSize || ctx.style.sizes[sizeKey] || 28,
    color: userColors[colorKey] || l.color || ctx.style.colors[colorKey],
    bold: l.bold !== undefined ? l.bold : !!opts.bold,
    align: opts.align || (ctx.settings.style && ctx.settings.style.align && ctx.settings.style.align[fontKey === 'heading' ? 'heading' : 'body']) || l.align || ctx.style.align[fontKey === 'heading' ? 'heading' : 'body'] || 'center',
    valign: opts.valign || 'middle',
    paragraphs,
  };
}

const para = (text, extra) => ({ runs: [{ text }], ...(extra || {}) });

function headingText(text, ctx) {
  return ctx.style.uppercaseHeadings ? String(text).toUpperCase() : String(text);
}

function makeSlide(kind, item, section, ctx, boxes, notes) {
  const all = boxes.filter(Boolean);
  if (ctx.settings.sectionFooter !== false && section && kind !== 'heading') {
    all.push(textBox('footer', kind, ctx, [para(section.name)], {
      sizeKey: 'small', colorKey: 'muted', align: 'left', valign: 'bottom',
    }));
  }
  return {
    kind,
    sectionId: section ? section.id : '',
    sectionName: section ? section.name : '',
    background: backgroundFor(kind, section, ctx),
    boxes: all,
    notes: `wd:kind=${kind};section=${section ? section.id : ''}${notes ? '\n' + notes : ''}`,
  };
}

function titleBoxes(kind, title, subtitle, ctx) {
  const out = [];
  if (title) {
    out.push(textBox('title', kind, ctx, [para(headingText(title, ctx))], {
      sizeKey: 'heading', fontKey: 'heading', colorKey: 'heading', bold: true,
    }));
  }
  if (subtitle) {
    out.push(textBox('subtitle', kind, ctx, [para(subtitle)], {
      sizeKey: 'small', colorKey: 'accent', fontSize: Math.round((ctx.style.sizes.small || 16) * 1.25),
    }));
  }
  return out;
}

function slidesForItem(item, section, ctx) {
  const maxLines = ctx.settings.maxLines || {};
  const roleLabels = ctx.settings.roleLabels || {};
  const kind = item.kind;

  if (kind === 'heading') {
    const big = Math.round(((ctx.settings.style.sizes && ctx.settings.style.sizes.heading) || ctx.style.sizes.heading) * 1.3);
    return [makeSlide('heading', item, section, ctx, [
      textBox('title', 'heading', ctx, [para(headingText(item.title, ctx))], {
        sizeKey: 'heading', fontKey: 'heading', colorKey: 'heading', bold: true, fontSize: big,
      }),
      item.subtitle && textBox('subtitle', 'heading', ctx, [para(item.subtitle)], {
        sizeKey: 'body', colorKey: 'accent',
      }),
    ])];
  }

  const bodyBox = boxFor('body', kind, ctx);
  const sizeKey = kind === 'song' ? 'lyrics' : 'body';
  const fontSize = (ctx.settings.style.sizes && ctx.settings.style.sizes[sizeKey]) || (bodyBox._layout.fontSize) || ctx.style.sizes[sizeKey];
  const body = (paras, k) => textBox('body', k || kind, ctx, paras, { sizeKey, box: bodyBox });

  if (kind === 'song') {
    const head = item.reference || item.title;
    const stanzas = item.stanzas.length ? item.stanzas : [{ label: '', lines: [] }];
    const slides = [];
    for (const st of stanzas) {
      const units = st.lines.map((line) => ({ text: line, make: (t) => ({ paragraph: para(t), measure: t }) }));
      // seimbangkan: 5 baris dengan maks. 4 menjadi 3 + 2, bukan 4 + 1
      const max = maxLines.lyrics || 4;
      const balanced = Math.ceil(st.lines.length / Math.max(1, Math.ceil(st.lines.length / max)));
      const pages = st.lines.length ? packParagraphs(units, bodyBox, fontSize, balanced) : [[]];
      pages.forEach((page, i) => {
        const subParts = [];
        if (item.reference && item.title) subParts.push(item.title);
        if (st.label) subParts.push(/^\d+$/.test(st.label) ? `bait ${st.label}` : st.label);
        if (pages.length > 1) subParts.push(`(${i + 1}/${pages.length})`);
        slides.push(makeSlide('song', item, section, ctx, [
          ...titleBoxes('song', head, subParts.join(' · '), ctx),
          page.length ? body(page) : null,
        ], st.lines.length ? '' : 'Lirik belum tersedia di dokumen.'));
      });
    }
    return slides;
  }

  if (kind === 'responsive') {
    const units = item.parts.map((p) => {
      const label = roleLabels[p.role] || p.role;
      return {
        text: p.text, split: true,
        make: (t, i) => ({
          measure: (label ? label + ' : ' : '') + t,
          paragraph: { runs: [
            ...(label && i === 0 ? [{ text: label + ' : ', bold: true, color: ctx.style.colors.accent }] : []),
            { text: t, bold: p.role === 'J' || p.role === 'S' },
          ], align: 'left' },
        }),
      };
    });
    const pages = packParagraphs(units, bodyBox, fontSize, maxLines.text || 6);
    return pages.map((page) => makeSlide('responsive', item, section, ctx, [
      ...titleBoxes('responsive', item.title, item.subtitle, ctx),
      textBox('body', 'responsive', ctx, page, { sizeKey, box: bodyBox, align: 'left' }),
    ]));
  }

  if (kind === 'scripture') {
    const units = item.verses.map((v) => ({
      text: v.text, split: true,
      make: (t, i) => ({
        measure: (v.number ? v.number + ' ' : '') + t,
        paragraph: { runs: [
          ...(v.number && i === 0 ? [{ text: v.number + ' ', superscript: true, color: ctx.style.colors.accent }] : []),
          { text: t },
        ], align: 'left' },
      }),
    }));
    if (!units.length && item.lines.length) {
      item.lines.forEach((l) => units.push({ text: l, split: true, make: (t) => ({ paragraph: para(t, { align: 'left' }), measure: t }) }));
    }
    const pages = packParagraphs(units, bodyBox, fontSize, maxLines.text || 6);
    const head = item.reference || item.title;
    return pages.map((page) => makeSlide('scripture', item, section, ctx, [
      ...titleBoxes('scripture', head, item.reference && item.title ? item.title : item.subtitle, ctx),
      page.length ? textBox('body', 'scripture', ctx, page, { sizeKey, box: bodyBox, align: 'left' }) : null,
    ]));
  }

  // text & announcement
  const bullet = kind === 'announcement';
  const units = item.lines.map((l) => ({
    text: l, split: !bullet,
    make: (t) => ({ measure: t, paragraph: para(t, bullet ? { bullet: true, align: 'left' } : {}) }),
  }));
  const pages = units.length ? packParagraphs(units, bodyBox, fontSize, maxLines.text || 6) : [[]];
  return pages.map((page) => makeSlide(kind, item, section, ctx, [
    ...titleBoxes(kind, item.title, item.subtitle, ctx),
    page.length ? textBox('body', kind, ctx, page, { sizeKey, box: bodyBox, align: bullet ? 'left' : undefined }) : null,
  ]));
}

/**
 * Susun seluruh deck. Urutan slide mengikuti urutan bagian yang diatur pengguna;
 * di dalam satu bagian, urutan item mengikuti dokumen. Bagian nonaktif dilewati.
 */
function layoutDeck(deck, options) {
  const opts = options || {};
  const settings = { maxLines: {}, style: {}, ...(opts.settings || {}) };
  settings.style = settings.style || {};
  const template = opts.template || findTemplate(settings.templateId, opts.templates);
  const style = resolveStyle(template, settings);
  const size = slideSize(settings, template);
  const ctx = { settings, template, style, size, boxes: defaultBoxes(size), resolveImage: opts.resolveImage };
  const sections = (opts.sections && opts.sections.length) ? opts.sections : [{ id: 'umum', name: 'Umum', enabled: true }];

  const slides = [];
  const items = (deck && deck.items) || [];
  for (const section of sections) {
    if (section.enabled === false) continue;
    const own = items.filter((it) => it.section === section.id);
    if (!own.length) continue;
    if (section.divider) {
      slides.push(...slidesForItem({ kind: 'heading', title: section.name, subtitle: '' }, section, ctx));
    }
    for (const item of own) slides.push(...slidesForItem(item, section, ctx));
  }
  slides.forEach((sl, i) => { sl.index = i; });
  return { size, style, templateId: template.id, slides };
}

module.exports = {
  SLIDE_SIZES,
  layoutDeck,
  resolveStyle,
  findTemplate,
  splitLongText,
  packParagraphs,
  wrappedLines,
  linesCapacity,
};
