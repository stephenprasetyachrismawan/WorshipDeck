/* Bentuk JSON liturgi yang disusun AI, plus pembersih (normalisasi) agar mesin selalu menerima data rapi. */
'use strict';

const { ITEM_KINDS, defaultMeta } = require('./defaults');

/**
 * JSON Schema untuk structured output. Semua kolom wajib (kosongkan bila tidak dipakai)
 * supaya cocok dengan mode ketat dan mudah diproses mesin.
 */
function deckJsonSchema(sectionIds) {
  const str = { type: 'string' };
  const strList = { type: 'array', items: str };
  const obj = (properties) => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  });
  return obj({
    meta: obj({
      title: str, date: str, church: str, theme: str, preacher: str, liturgist: str,
    }),
    items: {
      type: 'array',
      items: obj({
        section: sectionIds && sectionIds.length ? { type: 'string', enum: sectionIds } : str,
        kind: { type: 'string', enum: ITEM_KINDS },
        title: str,
        subtitle: str,
        reference: str,
        lines: strList,
        parts: { type: 'array', items: obj({ role: str, text: str }) },
        stanzas: { type: 'array', items: obj({ label: str, lines: strList }) },
        verses: { type: 'array', items: obj({ number: str, text: str }) },
      }),
    },
  });
}

const s = (v) => (v === undefined || v === null ? '' : String(v)).trim();
const list = (v) => (Array.isArray(v) ? v : []);
const lines = (v) => {
  if (typeof v === 'string') return v.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  return list(v).map(s).filter(Boolean);
};

/**
 * Rapikan deck dari AI atau suntingan tangan. Bagian yang tidak dikenal dipindah ke bagian
 * pertama yang aktif supaya tidak ada isi yang hilang.
 */
function normalizeDeck(raw, sections) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const meta = { ...defaultMeta() };
  for (const k of Object.keys(meta)) meta[k] = s(src.meta && src.meta[k]);

  const known = new Set(list(sections).map((x) => x.id));
  const fallbackSection = (list(sections).find((x) => x.enabled !== false) || list(sections)[0] || {}).id || 'umum';

  const items = list(src.items).map((it) => {
    const kind = ITEM_KINDS.includes(it && it.kind) ? it.kind : 'text';
    let section = s(it && it.section);
    if (known.size && !known.has(section)) section = fallbackSection;
    return {
      section: section || fallbackSection,
      kind,
      title: s(it.title),
      subtitle: s(it.subtitle),
      reference: s(it.reference),
      lines: lines(it.lines),
      parts: list(it.parts).map((p) => ({ role: s(p && p.role), text: s(p && p.text) })).filter((p) => p.text),
      stanzas: list(it.stanzas)
        .map((st) => ({ label: s(st && st.label), lines: lines(st && st.lines) }))
        .filter((st) => st.lines.length),
      verses: list(it.verses).map((v) => ({ number: s(v && v.number), text: s(v && v.text) })).filter((v) => v.text),
    };
  }).filter((it) => it.title || it.lines.length || it.parts.length || it.stanzas.length || it.verses.length);

  return { meta, items };
}

/** Contoh deck kecil untuk pratinjau template sebelum ada hasil AI. */
function sampleDeck() {
  return {
    meta: { title: 'Ibadah Minggu', date: '', church: 'Jemaat', theme: 'Kasih yang Memulihkan', preacher: '', liturgist: '' },
    items: [
      { section: 'pembukaan', kind: 'heading', title: 'Votum dan Salam', subtitle: '' },
      { section: 'pembukaan', kind: 'responsive', title: 'Votum', parts: [
        { role: 'P', text: 'Pertolongan kita adalah dalam nama TUHAN, yang menjadikan langit dan bumi.' },
        { role: 'J', text: 'Amin.' },
      ] },
      { section: 'pembukaan', kind: 'song', title: 'Haleluya, Pujilah', reference: 'KJ 3 : 1', stanzas: [
        { label: '1', lines: ['Baris lagu pertama', 'Baris lagu kedua', 'Baris lagu ketiga', 'Baris lagu keempat'] },
      ] },
      { section: 'firman', kind: 'scripture', title: 'Bacaan Injil', reference: 'Yohanes 3 : 16', verses: [
        { number: '16', text: 'Karena begitu besar kasih Allah akan dunia ini, sehingga Ia telah mengaruniakan Anak-Nya yang tunggal, supaya setiap orang yang percaya kepada-Nya tidak binasa, melainkan beroleh hidup yang kekal.' },
      ] },
      { section: 'warta', kind: 'announcement', title: 'Warta Jemaat', lines: ['Persekutuan doa Rabu pukul 18.00', 'Latihan paduan suara Sabtu pukul 16.00'] },
    ],
  };
}

module.exports = { deckJsonSchema, normalizeDeck, sampleDeck };
