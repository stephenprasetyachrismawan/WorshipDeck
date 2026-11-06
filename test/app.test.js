'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Storage, guessKind } = require('../lib/storage');
const { buildRequest, instructionText, pptxText } = require('../lib/ai');
const { pickAsset } = require('../lib/deckcraft');
const { writePptx } = require('../lib/engine');
const { normalizeDeck, sampleDeck } = require('../lib/schema');
const { defaultSections, defaultProjectSettings } = require('../lib/defaults');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-store-'));

test('storage: project, berkas, pustaka, template', () => {
  const store = new Storage(root);
  const p = store.createProject({ name: 'Minggu 1' });
  assert.strictEqual(store.listProjects()[0].id, p.id);

  const src = path.join(root, 'Liturgi Minggu.txt');
  fs.writeFileSync(src, 'Votum\nP: Pertolongan kita...');
  const f = store.addFile('project', p.id, { sourcePath: src });
  assert.strictEqual(f.kind, 'liturgi');
  assert.ok(f.useForAi);
  const again = store.addFile('project', p.id, { sourcePath: src });
  assert.notStrictEqual(again.stored, f.stored, 'nama berkas kembar diberi nomor');

  const lib = store.addFile('library', null, { buffer: Buffer.from('lirik'), name: 'KJ lengkap.txt' });
  assert.strictEqual(lib.kind, 'lagu');
  store.updateProject(p.id, { libraryFiles: [lib.id] });
  assert.strictEqual(store.aiFiles(p.id).length, 3);

  store.updateFile('project', p.id, again.id, { useForAi: false });
  assert.strictEqual(store.aiFiles(p.id).length, 2);

  store.saveProjectTemplate(p.id, { id: 'tpl-1', name: 'A' });
  store.saveLibraryTemplate({ id: 'tpl-2', name: 'B' });
  assert.strictEqual(store.listProjectTemplates(p.id)[0].scope, 'project');
  assert.strictEqual(store.listLibraryTemplates()[0].scope, 'library');

  const dup = store.duplicateProject(p.id);
  assert.strictEqual(store.getProject(dup.id).files.length, 0, 'duplikat tanpa berkas');
  assert.strictEqual(store.listProjectTemplates(dup.id).length, 1, 'duplikat membawa template');
  assert.deepStrictEqual(store.getProject(dup.id).libraryFiles, [lib.id]);

  assert.throws(() => store.projectDir('../luar'), /tidak sah/);
  store.removeFile('project', p.id, f.id);
  assert.strictEqual(store.getProject(p.id).files.length, 1);
});

test('guessKind dari nama berkas', () => {
  assert.strictEqual(guessKind('Warta Jemaat 9 Nov.pdf'), 'warta');
  assert.strictEqual(guessKind('latar.jpg'), 'gambar');
  assert.strictEqual(guessKind('Tata Ibadah.docx'), 'liturgi');
});

test('permintaan AI: PDF jadi dokumen, teks dibungkus, bagian & instruksi ikut', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-ai-'));
  const pdf = path.join(dir, 'liturgi.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4 palsu');
  const txt = path.join(dir, 'warta.txt');
  fs.writeFileSync(txt, 'Persekutuan doa Rabu');
  const project = {
    meta: { title: '', date: '2026-11-08', church: 'GKJ', theme: '', preacher: '', liturgist: '' },
    sections: defaultSections().map((s) => (s.id === 'warta' ? { ...s, enabled: false } : s)),
    settings: { aiInstructions: 'Lagu cukup bait 1' },
  };
  const files = [
    { name: 'liturgi.pdf', path: pdf, kind: 'liturgi', scope: 'project' },
    { name: 'warta.txt', path: txt, kind: 'warta', scope: 'library' },
  ];
  const body = await buildRequest(project, files, { model: 'claude-opus-5-5', effort: 'low' });
  assert.strictEqual(body.model, 'claude-opus-5-5');
  assert.strictEqual(body.output_config.effort, 'low');
  assert.strictEqual(body.output_config.format.type, 'json_schema');
  assert.ok(!body.output_config.format.schema.properties.items.items.properties.section.enum.includes('warta'));
  assert.strictEqual(body.fallbacks, 'default');
  const content = body.messages[0].content;
  assert.ok(content.some((b) => b.type === 'document' && b.source.media_type === 'application/pdf'));
  assert.ok(content.some((b) => b.type === 'text' && b.text.includes('Persekutuan doa Rabu')));
  const last = content[content.length - 1].text;
  assert.match(last, /Lagu cukup bait 1/);
  assert.match(last, /date: 2026-11-08/);
  assert.ok(!/id "warta"/.test(instructionText(project)));

  const haiku = await buildRequest(project, files, { model: 'claude-haiku-5-5' });
  assert.strictEqual(haiku.fallbacks, undefined);
  await assert.rejects(buildRequest(project, [], {}), /Belum ada berkas/);
});

test('teks PPTX lama bisa dibaca untuk AI', async () => {
  const file = path.join(root, 'lama.pptx');
  await writePptx(normalizeDeck(sampleDeck(), defaultSections()), { settings: defaultProjectSettings(), sections: defaultSections() }, file);
  const text = await pptxText(fs.readFileSync(file));
  assert.match(text, /\[Slide 1\]/);
  assert.match(text, /Pertolongan kita/);
});

test('pickAsset memilih versi portable yang cocok', () => {
  const assets = [
    { name: 'deckcraft-0.15.0-windows-x64.msi' },
    { name: 'deckcraft-0.15.0-windows-x64-portable.zip' },
    { name: 'deckcraft-0.15.0-windows-arm64-portable.zip' },
    { name: 'deckcraft-cli-0.15.0-windows-x64-portable.zip' },
    { name: 'deckcraft-0.15.0-linux-x86_64.tar.gz' },
  ];
  assert.strictEqual(pickAsset(assets, 'windows-x64').name, 'deckcraft-0.15.0-windows-x64-portable.zip');
  assert.strictEqual(pickAsset(assets, 'windows-arm64').name, 'deckcraft-0.15.0-windows-arm64-portable.zip');
  assert.strictEqual(pickAsset(assets, 'linux-x86_64').name, 'deckcraft-0.15.0-linux-x86_64.tar.gz');
  assert.strictEqual(pickAsset(assets, 'windows-x86'), null);
});
