/*
 * Mesin pembuat .pptx. AI tidak menyentuh berkas PPT sama sekali: ia hanya menyusun JSON,
 * lalu mesin ini mengubah hasil tata letak (layout.js) menjadi PowerPoint.
 *
 * Setiap kotak diberi nama "wd:<peran>" dan setiap slide diberi catatan "wd:kind=...".
 * Penanda ini dipakai lagi saat hasil suntingan DeckCraft diambil sebagai template.
 */
'use strict';

const fs = require('fs');
const PptxGenJS = require('pptxgenjs');
const { layoutDeck } = require('./layout');

const hex = (c) => String(c || '#000000').replace('#', '').toUpperCase();

function runsToText(paragraph, box) {
  const runs = paragraph.runs || [];
  return runs.map((r, i) => ({
    text: r.text,
    options: {
      bold: r.bold !== undefined ? r.bold : box.bold,
      italic: !!r.italic,
      color: hex(r.color || box.color),
      superscript: !!r.superscript,
      fontFace: box.fontFace,
      fontSize: box.fontSize,
      // pptxgenjs memulai paragraf baru bila perataan berubah atau ada bullet, jadi perataan
      // dipasang di semua run, bullet hanya di run pertama, dan ganti baris di run terakhir.
      align: paragraph.align || box.align,
      paraSpaceAfter: Math.round(box.fontSize * 0.25),
      ...(i === 0 && paragraph.bullet ? { bullet: { indent: Math.round(box.fontSize * 0.9) } } : {}),
      ...(i === runs.length - 1 ? { breakLine: true } : {}),
    },
  }));
}

function addBox(slide, box) {
  const parts = [];
  box.paragraphs.forEach((p) => parts.push(...runsToText(p, box)));
  if (!parts.length) return;
  // run terakhir tidak perlu ganti baris
  parts[parts.length - 1].options.breakLine = false;
  slide.addText(parts, {
    x: box.x, y: box.y, w: box.w, h: box.h,
    objectName: `wd:${box.role}`,
    fontFace: box.fontFace,
    fontSize: box.fontSize,
    color: hex(box.color),
    bold: box.bold,
    align: box.align,
    valign: box.valign,
    fit: 'shrink',
    margin: 4,
  });
}

/** Buat objek PptxGenJS dari deck. */
function buildPresentation(deck, options) {
  const result = layoutDeck(deck, options);
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'WD', width: result.size.w, height: result.size.h });
  pptx.layout = 'WD';
  pptx.title = (deck.meta && deck.meta.title) || 'WorshipDeck';
  pptx.company = (deck.meta && deck.meta.church) || '';
  pptx.author = 'WorshipDeck';

  for (const s of result.slides) {
    const slide = pptx.addSlide();
    if (s.background.image && fs.existsSync(s.background.image)) {
      slide.background = { path: s.background.image };
    } else {
      slide.background = { color: hex(s.background.color) };
    }
    for (const box of s.boxes) addBox(slide, box);
    slide.addNotes(s.notes);
  }
  return { pptx, layout: result };
}

/** Tulis .pptx ke `outPath`. Kembalikan manifest (jenis & bagian tiap slide). */
async function writePptx(deck, options, outPath) {
  const { pptx, layout } = buildPresentation(deck, options);
  const buf = await pptx.write({ outputType: 'nodebuffer' });
  fs.writeFileSync(outPath, buf);
  return {
    file: outPath,
    templateId: layout.templateId,
    size: layout.size,
    slides: layout.slides.map((s) => ({ index: s.index, kind: s.kind, section: s.sectionId })),
  };
}

module.exports = { buildPresentation, writePptx };
