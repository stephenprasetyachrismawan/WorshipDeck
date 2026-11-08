'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');

const { defaultSections, defaultProjectSettings, BUILTIN_TEMPLATES } = require('../lib/defaults');
const { normalizeDeck, sampleDeck, deckJsonSchema } = require('../lib/schema');
const { layoutDeck, splitLongText } = require('../lib/layout');
const { writePptx } = require('../lib/engine');
const { templateFromPptx } = require('../lib/template-import');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-test-'));

function opts(extra) {
  return { settings: defaultProjectSettings(), sections: defaultSections(), ...(extra || {}) };
}

test('normalizeDeck memindahkan bagian tak dikenal dan membuang item kosong', () => {
  const deck = normalizeDeck({ items: [
    { section: 'tidak-ada', kind: 'text', title: 'Doa', lines: 'baris 1\nbaris 2' },
    { section: 'pembukaan', kind: 'aneh', title: '' },
    { section: 'firman', kind: 'song', title: 'Lagu', stanzas: [{ label: '1', lines: [] }] },
  ] }, defaultSections());
  assert.strictEqual(deck.items.length, 2);
  assert.strictEqual(deck.items[0].section, 'persiapan');
  assert.deepStrictEqual(deck.items[0].lines, ['baris 1', 'baris 2']);
  assert.strictEqual(deck.items[1].stanzas.length, 0, 'bait tanpa baris dibuang');
});

test('schema mewajibkan semua kolom dan memakai enum bagian', () => {
  const s = deckJsonSchema(['a', 'b']);
  const item = s.properties.items.items;
  assert.deepStrictEqual(item.properties.section.enum, ['a', 'b']);
  assert.deepStrictEqual(item.required.sort(), Object.keys(item.properties).sort());
  assert.strictEqual(item.additionalProperties, false);
});

test('slide mengikuti urutan bagian, bagian nonaktif dilewati', () => {
  const secs = defaultSections();
  const deck = normalizeDeck(sampleDeck(), secs);
  // tukar urutan: warta di depan, nonaktifkan firman
  const warta = secs.find((s) => s.id === 'warta');
  const ordered = [warta, ...secs.filter((s) => s !== warta)];
  ordered.find((s) => s.id === 'firman').enabled = false;
  const r = layoutDeck(deck, opts({ sections: ordered }));
  assert.strictEqual(r.slides[0].sectionId, 'warta');
  assert.ok(!r.slides.some((s) => s.sectionId === 'firman'));
});

test('lirik dipecah sesuai maks. baris per slide', () => {
  const deck = normalizeDeck({ items: [{ section: 'pembukaan', kind: 'song', title: 'Lagu', reference: 'KJ 1', stanzas: [
    { label: '1', lines: ['a', 'b', 'c', 'd', 'e', 'f'] },
    { label: '2', lines: ['g', 'h'] },
  ] }] }, defaultSections());
  const settings = { ...defaultProjectSettings(), maxLines: { lyrics: 4, text: 6 } };
  const r = layoutDeck(deck, opts({ settings }));
  assert.strictEqual(r.slides.length, 3); // bait 1 dibagi rata 3 + 3, lalu bait 2
  const body = r.slides[0].boxes.find((b) => b.role === 'body');
  assert.strictEqual(body.paragraphs.length, 3);
});

test('lagu tanpa lirik tetap jadi satu slide judul', () => {
  const deck = normalizeDeck({ items: [{ section: 'pembukaan', kind: 'song', title: 'Lagu', reference: 'KJ 2' }] }, defaultSections());
  const r = layoutDeck(deck, opts());
  assert.strictEqual(r.slides.length, 1);
  assert.ok(!r.slides[0].boxes.some((b) => b.role === 'body'));
  assert.match(r.slides[0].notes, /belum tersedia/);
});

test('ayat panjang dipecah ke beberapa slide', () => {
  const long = 'Kalimat yang cukup panjang untuk mengisi layar. '.repeat(30);
  const deck = normalizeDeck({ items: [{ section: 'firman', kind: 'scripture', reference: 'Mzm 1', verses: [{ number: '1', text: long }] }] }, defaultSections());
  const r = layoutDeck(deck, opts());
  assert.ok(r.slides.length > 1);
  assert.ok(splitLongText(long, 200).every((p) => p.length <= 200));
});

test('pengaturan project menimpa ukuran huruf template', () => {
  const deck = normalizeDeck(sampleDeck(), defaultSections());
  const settings = { ...defaultProjectSettings(), style: { sizes: { lyrics: 50 }, colors: { heading: '#123456' } } };
  const r = layoutDeck(deck, opts({ settings }));
  const song = r.slides.find((s) => s.kind === 'song');
  assert.strictEqual(song.boxes.find((b) => b.role === 'body').fontSize, 50);
  assert.strictEqual(song.boxes.find((b) => b.role === 'title').color, '#123456');
});

test('latar bagian mengalahkan latar project', () => {
  const secs = defaultSections();
  secs.find((s) => s.id === 'warta').background = { type: 'color', color: '#FF0000' };
  const settings = { ...defaultProjectSettings(), style: { background: { type: 'color', color: '#00FF00' } } };
  const r = layoutDeck(normalizeDeck(sampleDeck(), secs), opts({ settings, sections: secs }));
  assert.strictEqual(r.slides.find((s) => s.sectionId === 'warta').background.color, '#FF0000');
  assert.strictEqual(r.slides.find((s) => s.sectionId === 'firman').background.color, '#00FF00');
});

async function buildSample(file) {
  const secs = defaultSections();
  const deck = normalizeDeck(sampleDeck(), secs);
  return writePptx(deck, opts({ sections: secs }), file);
}

test('mesin menulis pptx berpenanda wd: dan catatan jenis slide', async () => {
  const file = path.join(tmp, 'a.pptx');
  const manifest = await buildSample(file);
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  assert.strictEqual(slides.length, manifest.slides.length);
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  assert.match(xml, /name="wd:title"/);
  const notes = await zip.file('ppt/notesSlides/notesSlide1.xml').async('string');
  assert.match(notes, /wd:kind=heading/);
});

test('template diambil dari pptx yang disunting (simulasi DeckCraft)', async () => {
  const file = path.join(tmp, 'b.pptx');
  const manifest = await buildSample(file);
  const songIndex = manifest.slides.findIndex((s) => s.kind === 'song');
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const part = `ppt/slides/slide${songIndex + 1}.xml`;
  let xml = await zip.file(part).async('string');

  // "sunting": pindahkan judul ke bawah, besarkan huruf lirik, ganti latar jadi merah tua
  xml = xml.replace(/(<p:cNvPr[^>]*name="wd:title"[\s\S]*?<a:off )x="\d+" y="\d+"/, '$1x="457200" y="5486400"');
  xml = xml.replace(/(name="wd:body"[\s\S]*?)sz="\d+"/, '$1sz="5400"');
  xml = xml.replace(/<p:bg>[\s\S]*?<\/p:bg>/, '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="550000"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>');
  zip.file(part, xml);
  const edited = await zip.generateAsync({ type: 'nodebuffer' });

  const tpl = await templateFromPptx(edited, { name: 'Uji', manifest, baseTemplate: BUILTIN_TEMPLATES[0] });
  assert.ok(tpl.layouts.song, 'tata letak lagu terbaca');
  assert.strictEqual(tpl.layouts.song.boxes.title.y, 6);
  assert.strictEqual(tpl.layouts.song.boxes.body.fontSize, 54);
  assert.strictEqual(tpl.layouts.song.background.color, '#550000');
  assert.strictEqual(tpl.slideSize, '16:9');

  // template baru langsung dipakai mesin tata letak
  const deck = normalizeDeck(sampleDeck(), defaultSections());
  const r = layoutDeck(deck, opts({ template: tpl }));
  const song = r.slides.find((s) => s.kind === 'song');
  assert.strictEqual(song.background.color, '#550000');
  assert.strictEqual(song.boxes.find((b) => b.role === 'title').y, 6);
  assert.strictEqual(song.boxes.find((b) => b.role === 'body').fontSize, 54);
});

test('template tetap terbaca walau catatan & nama kotak hilang (pakai manifest & tebakan)', async () => {
  const file = path.join(tmp, 'c.pptx');
  const manifest = await buildSample(file);
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  for (const n of Object.keys(zip.files)) {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(n)) {
      const x = (await zip.file(n).async('string')).replace(/name="wd:[a-z]+"/g, 'name="Kotak Teks"');
      zip.file(n, x);
    }
    if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)) {
      zip.file(n, (await zip.file(n).async('string')).replace(/wd:kind=[a-z]+/g, ''));
    }
  }
  const tpl = await templateFromPptx(await zip.generateAsync({ type: 'nodebuffer' }), { manifest });
  assert.ok(tpl.layouts.song && tpl.layouts.song.boxes.body, 'kotak isi ditebak');
  assert.ok(tpl.layouts.song.boxes.title, 'kotak judul ditebak');
});

test('latar gambar ikut tersimpan saat impor template', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const img = path.join(tmp, 'latar.png');
  fs.writeFileSync(img, png);
  const secs = defaultSections();
  const settings = { ...defaultProjectSettings(), style: { background: { type: 'image', image: { scope: 'project', id: 'x' } } } };
  const file = path.join(tmp, 'd.pptx');
  const manifest = await writePptx(normalizeDeck(sampleDeck(), secs), { settings, sections: secs, resolveImage: () => img }, file);
  const saved = [];
  const tpl = await templateFromPptx(fs.readFileSync(file), {
    manifest,
    saveImage: (name, data) => { saved.push({ name, size: data.length }); return { scope: 'project', id: 'img1' }; },
  });
  assert.strictEqual(saved.length, 1, 'gambar yang sama hanya disimpan sekali');
  assert.deepStrictEqual(tpl.layouts.song.background.image, { scope: 'project', id: 'img1' });
});

test('warna teks template diambil dari teks utama, bukan label P/J', async () => {
  const file = path.join(tmp, 'e.pptx');
  const secs = defaultSections();
  const deck = normalizeDeck({ items: [{ section: 'pembukaan', kind: 'responsive', title: 'Votum', parts: [{ role: 'P', text: 'Pertolongan kita adalah dalam nama TUHAN' }] }] }, secs);
  const manifest = await writePptx(deck, opts({ sections: secs }), file);
  const tpl = await templateFromPptx(fs.readFileSync(file), { manifest, baseTemplate: BUILTIN_TEMPLATES[0] });
  assert.strictEqual(tpl.colors.body, BUILTIN_TEMPLATES[0].colors.body.toUpperCase());
});
