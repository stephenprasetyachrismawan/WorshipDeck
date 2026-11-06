/*
 * Bagian AI: membaca berkas project (PDF, DOCX, TXT, PPTX, gambar) lalu meminta Claude
 * menyusun JSON liturgi. AI tidak membuat PPT; PPT dibuat mesin (engine.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const JSZip = require('jszip');
const { deckJsonSchema, normalizeDeck } = require('./schema');
const { FILE_KINDS, KIND_LABELS } = require('./defaults');

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (paling akurat)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (lebih cepat & murah)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (paling murah)' },
];
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);
const MAX_REQUEST_BYTES = 30 * 1024 * 1024;

const SYSTEM_PROMPT = `Anda adalah asisten multimedia gereja. Tugas Anda: membaca dokumen liturgi
(tata ibadah), warta jemaat, lirik lagu, dan bacaan Alkitab yang diberikan, lalu menyusunnya
menjadi JSON untuk slide presentasi ibadah. Slide dibuat oleh program lain dari JSON ini,
jadi Anda hanya menyusun isi, bukan desain.

Aturan isi:
- Ikuti urutan liturgi di dokumen. Masukkan setiap unsur ke bagian (section) yang paling cocok.
- Salin teks apa adanya: lirik lagu, bacaan berbalasan, doa, dan ayat Alkitab tidak boleh diubah,
  diringkas, atau diterjemahkan. Perbaiki hanya salah ketik yang jelas dan pemenggalan baris dari PDF.
- Jangan pernah mengarang lirik lagu atau ayat Alkitab. Bila lirik atau ayat tidak ada di dokumen,
  buat item dengan judul dan referensinya saja, dan biarkan stanzas/verses kosong.
- Bacaan berbalasan: pakai kind "responsive"; role "P" untuk pemimpin/pelayan, "J" untuk jemaat,
  "S" untuk semua/bersama-sama. Bagian rubrik (petunjuk seperti "jemaat berdiri") jangan dimasukkan
  ke teks, kecuali yang perlu dilihat jemaat.
- Nyanyian: kind "song"; reference berisi sumber dan bait, mis. "KJ 3 : 1-3" atau "PKJ 17";
  title berisi judul lagu; tiap bait satu stanza (label "1", "2", ... atau "Reff"), satu baris lirik
  per elemen lines.
- Pembacaan Alkitab: kind "scripture"; reference mis. "Yohanes 3 : 16-18"; title mis. "Bacaan Injil";
  satu ayat per elemen verses dengan nomornya.
- Warta jemaat: kind "announcement"; ringkas menjadi poin pendek yang mudah dibaca di layar.
- Doa, votum, salam, berita anugerah yang tidak berbalasan: kind "text".
- Pergantian unsur liturgi penting (mis. "Pengakuan Dosa", "Khotbah") boleh diberi kind "heading".
- Kolom yang tidak dipakai diisi string kosong atau array kosong.`;

function extOf(name) {
  return path.extname(name).toLowerCase();
}

async function pptxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  const out = [];
  for (const [i, n] of slides.entries()) {
    const xml = await zip.file(n).async('string');
    const paras = (xml.match(/<a:p>[\s\S]*?<\/a:p>/g) || [])
      .map((p) => (p.match(/<a:t>([^<]*)<\/a:t>/g) || []).map((t) => t.slice(5, -6)).join(''))
      .filter((t) => t.trim());
    if (paras.length) out.push(`[Slide ${i + 1}]\n${paras.join('\n')}`);
  }
  return out.join('\n\n');
}

/** Ubah satu berkas menjadi blok konten untuk Claude. */
async function fileToBlocks(file) {
  const label = `Berkas "${file.name}" (${FILE_KINDS[file.kind] || 'lainnya'}${file.scope === 'library' ? ', dari pustaka' : ''})${file.note ? ` — catatan: ${file.note}` : ''}`;
  const ext = extOf(file.name);
  const data = fs.readFileSync(file.path);

  if (ext === '.pdf') {
    return [
      { type: 'text', text: label + ':' },
      { type: 'document', title: file.name, source: { type: 'base64', media_type: 'application/pdf', data: data.toString('base64') } },
    ];
  }
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
    const media = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext];
    return [
      { type: 'text', text: label + ' (gambar):' },
      { type: 'image', source: { type: 'base64', media_type: media, data: data.toString('base64') } },
    ];
  }
  let text = '';
  if (ext === '.docx') {
    const mammoth = require('mammoth');
    text = (await mammoth.extractRawText({ buffer: data })).value;
  } else if (ext === '.pptx') {
    text = await pptxText(data);
  } else if (['.txt', '.md', '.csv', '.json', '.ptm', '.text'].includes(ext)) {
    text = data.toString('utf8');
  } else {
    return [{ type: 'text', text: `${label}: (format ${ext || 'tanpa ekstensi'} belum bisa dibaca, dilewati)` }];
  }
  return [{ type: 'text', text: `${label}:\n<<<\n${text.trim()}\n>>>` }];
}

function instructionText(project) {
  const sections = project.sections.filter((s) => s.enabled !== false);
  const meta = project.meta || {};
  const lines = [
    'Susun JSON slide ibadah dari berkas-berkas di atas.',
    '',
    'Bagian (section) yang tersedia, urut sesuai ibadah. Pakai id-nya pada kolom "section":',
    ...sections.map((s) => `- id "${s.id}": ${s.name}${s.instructions ? ` — ${s.instructions}` : ''}`),
    '',
    `Jenis item (kind) yang boleh dipakai: ${Object.entries(KIND_LABELS).map(([k, v]) => `"${k}" (${v})`).join(', ')}.`,
  ];
  const known = Object.entries(meta).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (known.length) lines.push('', 'Data ibadah yang sudah diketahui (pakai untuk meta bila dokumen tidak menyebut):', ...known);
  if (project.settings && project.settings.aiInstructions) {
    lines.push('', 'Instruksi tambahan dari pengguna:', project.settings.aiInstructions);
  }
  return lines.join('\n');
}

/** Bangun isi permintaan. Dipisah agar bisa dites tanpa memanggil API. */
async function buildRequest(project, files, settings) {
  const content = [];
  for (const f of files) content.push(...(await fileToBlocks(f)));
  if (!files.length) throw new Error('Belum ada berkas untuk dibaca AI. Unggah liturgi di tab Berkas dan centang "Baca AI".');
  content.push({ type: 'text', text: instructionText(project) });

  const sectionIds = project.sections.filter((s) => s.enabled !== false).map((s) => s.id);
  const model = (settings && settings.model) || 'claude-opus-5-5';
  const body = {
    model,
    max_tokens: 64000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
    output_config: {
      effort: (settings && settings.effort) || 'medium',
      format: { type: 'json_schema', schema: deckJsonSchema(sectionIds) },
    },
  };
  if (FALLBACK_MODELS.has(model)) {
    // bila permintaan ditolak oleh filter keamanan, API mencoba ulang dengan model cadangan
    body.betas = ['server-side-fallback-2026-07-01'];
    body.fallbacks = 'default';
  }
  const size = Buffer.byteLength(JSON.stringify(body));
  if (size > MAX_REQUEST_BYTES) {
    throw new Error(`Total berkas terlalu besar untuk sekali kirim (${(size / 1048576).toFixed(1)} MB, batas ±30 MB). Matikan "Baca AI" untuk berkas yang tidak perlu.`);
  }
  return body;
}

function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Kunci API ditolak. Periksa kunci API di Pengaturan.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'Kunci API tidak punya izin untuk model ini.';
  if (err instanceof Anthropic.RateLimitError) return 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.';
  if (err instanceof Anthropic.BadRequestError) return `Permintaan ditolak API: ${err.message}`;
  if (err instanceof Anthropic.InternalServerError) return 'Server AI sedang bermasalah. Coba lagi beberapa saat lagi.';
  if (err instanceof Anthropic.APIConnectionError) return 'Tidak bisa terhubung ke server AI. Periksa koneksi internet.';
  return err && err.message ? err.message : String(err);
}

/**
 * Minta Claude menyusun deck. `onProgress(chars)` dipanggil saat teks mengalir.
 * Mengembalikan { deck, usage, model }.
 */
async function generateDeck({ project, files, apiKey, settings, onProgress, signal }) {
  if (!apiKey) throw new Error('Kunci API Claude belum diisi. Buka Pengaturan.');
  const body = await buildRequest(project, files, settings);
  const client = new Anthropic({ apiKey });
  let chars = 0;
  let message;
  try {
    const { betas, ...rest } = body;
    const stream = betas
      ? client.beta.messages.stream({ ...rest, betas }, { signal })
      : client.messages.stream(rest, { signal });
    stream.on('text', (t) => { chars += t.length; if (onProgress) onProgress(chars); });
    message = await stream.finalMessage();
  } catch (err) {
    if (signal && signal.aborted) throw new Error('Dibatalkan.');
    throw new Error(friendlyError(err));
  }

  if (message.stop_reason === 'refusal') {
    throw new Error('AI menolak memproses dokumen ini. Coba periksa isi berkas, lalu ulangi.');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error('Hasil terlalu panjang dan terpotong. Kurangi berkas yang dibaca AI atau bagi menjadi dua project.');
  }
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Jawaban AI bukan JSON yang sah. Coba ulangi.');
  }
  return { deck: normalizeDeck(raw, project.sections), usage: message.usage, model: message.model };
}

module.exports = { MODELS, SYSTEM_PROMPT, buildRequest, generateDeck, fileToBlocks, instructionText, pptxText };
