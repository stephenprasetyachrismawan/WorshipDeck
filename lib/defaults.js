/* Nilai bawaan: bagian liturgi, template bawaan, dan pengaturan project. */
'use strict';

/** Jenis isi slide yang dikenal mesin. AI hanya boleh memakai jenis-jenis ini. */
const ITEM_KINDS = ['heading', 'text', 'responsive', 'song', 'scripture', 'announcement'];

const KIND_LABELS = {
  heading: 'Judul bagian',
  text: 'Teks / doa',
  responsive: 'Bacaan berbalasan',
  song: 'Nyanyian',
  scripture: 'Pembacaan Alkitab',
  announcement: 'Warta / pengumuman',
};

/** Bagian liturgi bawaan. Pengguna bisa menambah, menghapus, mengurutkan, dan menonaktifkan. */
function defaultSections() {
  return [
    { id: 'persiapan', name: 'Persiapan Ibadah', enabled: true, divider: false, instructions: 'Saat teduh, pengumuman sebelum ibadah, ucapan selamat datang.' },
    { id: 'pembukaan', name: 'Pembukaan', enabled: true, divider: false, instructions: 'Nyanyian pembuka, votum, salam.' },
    { id: 'pengakuan', name: 'Pengakuan Dosa & Berita Anugerah', enabled: true, divider: false, instructions: 'Doa pengakuan dosa, berita anugerah, petunjuk hidup baru, nyanyian respons.' },
    { id: 'firman', name: 'Pelayanan Firman', enabled: true, divider: false, instructions: 'Doa epiklese, pembacaan Alkitab, khotbah (cukup judul tema khotbah).' },
    { id: 'respons', name: 'Respons Jemaat', enabled: true, divider: false, instructions: 'Pengakuan iman, doa syafaat, persembahan dan nyanyian persembahan.' },
    { id: 'warta', name: 'Warta Jemaat', enabled: true, divider: false, instructions: 'Ringkas pokok-pokok warta jemaat menjadi poin singkat.' },
    { id: 'pengutusan', name: 'Pengutusan & Berkat', enabled: true, divider: false, instructions: 'Nyanyian pengutusan, berkat, saat teduh penutup.' },
  ];
}

/**
 * Template = gaya dasar slide. `layouts` (opsional) menyimpan posisi kotak & latar per jenis
 * slide; diisi saat template diambil dari hasil suntingan DeckCraft.
 */
const BUILTIN_TEMPLATES = [
  {
    id: 'malam-biru',
    name: 'Malam Biru',
    builtin: true,
    background: { type: 'color', color: '#0B1D3A' },
    fonts: { heading: 'Segoe UI Semibold', body: 'Segoe UI' },
    colors: { heading: '#FFFFFF', body: '#F2F5FA', accent: '#F5C451', muted: '#9FB3D1' },
    sizes: { heading: 40, body: 32, lyrics: 38, small: 16 },
    align: { heading: 'center', body: 'center' },
    uppercaseHeadings: true,
  },
  {
    id: 'kertas-terang',
    name: 'Kertas Terang',
    builtin: true,
    background: { type: 'color', color: '#FBF8F1' },
    fonts: { heading: 'Georgia', body: 'Georgia' },
    colors: { heading: '#5A2E0E', body: '#2B2118', accent: '#A4561F', muted: '#8C7B6B' },
    sizes: { heading: 40, body: 30, lyrics: 36, small: 16 },
    align: { heading: 'center', body: 'center' },
    uppercaseHeadings: false,
  },
  {
    id: 'hitam-proyektor',
    name: 'Hitam Proyektor',
    builtin: true,
    background: { type: 'color', color: '#000000' },
    fonts: { heading: 'Arial', body: 'Arial' },
    colors: { heading: '#FFFF66', body: '#FFFFFF', accent: '#FFFF66', muted: '#AAAAAA' },
    sizes: { heading: 40, body: 36, lyrics: 44, small: 16 },
    align: { heading: 'center', body: 'center' },
    uppercaseHeadings: true,
  },
  {
    id: 'hijau-liturgi',
    name: 'Hijau Liturgi (Minggu Biasa)',
    builtin: true,
    background: { type: 'color', color: '#16382A' },
    fonts: { heading: 'Cambria', body: 'Calibri' },
    colors: { heading: '#FFFFFF', body: '#EEF5EF', accent: '#C9E4A6', muted: '#9CC0A8' },
    sizes: { heading: 40, body: 32, lyrics: 38, small: 16 },
    align: { heading: 'center', body: 'center' },
    uppercaseHeadings: false,
  },
  {
    id: 'ungu-adven',
    name: 'Ungu (Adven / Pra-Paskah)',
    builtin: true,
    background: { type: 'color', color: '#2E1846' },
    fonts: { heading: 'Cambria', body: 'Calibri' },
    colors: { heading: '#FFFFFF', body: '#F3EDF9', accent: '#E3C3FF', muted: '#B69BD1' },
    sizes: { heading: 40, body: 32, lyrics: 38, small: 16 },
    align: { heading: 'center', body: 'center' },
    uppercaseHeadings: false,
  },
];

/** Pengaturan project. Bagian `style` menimpa template (hanya kunci yang diisi). */
function defaultProjectSettings() {
  return {
    templateId: 'malam-biru',
    slideSize: '16:9',
    style: {},
    maxLines: { lyrics: 4, text: 6 },
    sectionFooter: true,
    roleLabels: { P: 'P', J: 'J', S: 'S' },
    aiInstructions: '',
  };
}

function defaultMeta() {
  return { title: '', date: '', church: '', theme: '', preacher: '', liturgist: '' };
}

/** Jenis berkas yang bisa diunggah, untuk memberi tahu AI peran tiap berkas. */
const FILE_KINDS = {
  liturgi: 'Liturgi / tata ibadah',
  warta: 'Warta jemaat',
  lagu: 'Lirik lagu',
  alkitab: 'Bacaan Alkitab',
  gambar: 'Gambar / latar',
  lain: 'Lainnya',
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Gabung dalam (deep merge). Nilai `undefined`, `null`, dan string kosong di `over` diabaikan. */
function deepMerge(base, over) {
  if (!isPlainObject(over)) return base;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = isPlainObject(v) ? deepMerge(out[k], v) : v;
  }
  return out;
}

module.exports = {
  ITEM_KINDS,
  KIND_LABELS,
  BUILTIN_TEMPLATES,
  FILE_KINDS,
  defaultSections,
  defaultProjectSettings,
  defaultMeta,
  deepMerge,
  isPlainObject,
};
