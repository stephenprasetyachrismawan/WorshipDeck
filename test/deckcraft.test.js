'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DeckCraftSession, findExecutable } = require('../lib/deckcraft');

const fake = path.join(__dirname, 'fixtures', 'fake-deckcraft.js');

test('sesi DeckCraft: buka, simpan lewat control protocol, tutup', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-dc-'));
  const file = path.join(dir, 'deck.pptx');
  fs.writeFileSync(file, 'x');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(file, old, old);
  const log = path.join(dir, 'log.jsonl');
  process.env.FAKE_DC_LOG = log;

  const s = new DeckCraftSession(fake, file);
  await s.start();
  assert.ok(s.ready, 'kontrol siap');
  assert.ok(s.running);
  assert.ok(!s.changed());
  await s.save();
  assert.ok(s.changed(), 'berkas ditandai berubah setelah simpan');

  const exited = new Promise((r) => s.on('exit', r));
  s.stop();
  const info = await exited;
  assert.strictEqual(info.file, file);
  assert.strictEqual(info.changed, true);

  const methods = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).method);
  assert.ok(methods.includes('ui.inspect'));
  assert.ok(methods.includes('app.save'));
  assert.ok(methods.includes('app.quit'));
});

test('findExecutable memakai path dari pengaturan bila ada', () => {
  assert.strictEqual(findExecutable(fake, null), fake);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-dc2-'));
  const nested = path.join(dir, 'v0.15.0', 'deckcraft');
  fs.mkdirSync(nested, { recursive: true });
  const exe = path.join(nested, process.platform === 'win32' ? 'deckcraft.exe' : 'deckcraft');
  fs.writeFileSync(exe, '');
  assert.strictEqual(findExecutable('', dir), exe);
});
