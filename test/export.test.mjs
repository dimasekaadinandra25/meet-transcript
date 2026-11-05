import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../lib/merge.js');
await import('../lib/backup.js');
await import('../lib/export.js');
const { makeDocx } = globalThis.MeetExport;
const { readZip } = globalThis.MeetBackup;
const { matchesSearch, searchSnippet } = globalThis.MeetMerge;

const meeting = (extra = {}) => ({
  title: 'Budget <review> & plan',
  startedAt: new Date(2026, 0, 2, 9, 0, 0).getTime(),
  mom: '## Decisions\nShip on Friday',
  segments: [
    { id: 1, speaker: 'Ani', text: 'We need 5 < 10 "units" & more', t: new Date(2026, 0, 2, 9, 0, 5).getTime() },
    { id: 2, speaker: '', text: 'no speaker line', t: new Date(2026, 0, 2, 9, 0, 9).getTime() },
  ],
  ...extra,
});

async function documentXml(data) {
  const zip = await readZip(await makeDocx(data));
  const file = zip.find((entry) => entry.name === 'word/document.xml');
  return { names: zip.map((entry) => entry.name), xml: await file.blob.text() };
}

test('docx memuat bagian wajib Word', async () => {
  const { names } = await documentXml(meeting());
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']) assert.ok(names.includes(name), name);
});

test('docx memuat judul, MoM, dan transkrip dengan teks yang di-escape', async () => {
  const { xml } = await documentXml(meeting());
  assert.match(xml, /Budget &lt;review&gt; &amp; plan/);
  assert.match(xml, /Ship on Friday/);
  assert.match(xml, /5 &lt; 10 "units" &amp; more/);
  assert.match(xml, /Ani/);
  assert.match(xml, /no speaker line/);
  assert.ok(xml.indexOf('Ship on Friday') < xml.indexOf('5 &lt; 10'));
});

test('docx membuang karakter yang tidak sah di XML', async () => {
  const { xml } = await documentXml(meeting({ title: 'a\u0001b\u000bc' }));
  assert.match(xml, /abc/);
});

test('docx tetap sah tanpa MoM dan transkrip', async () => {
  const { xml } = await documentXml(meeting({ mom: null, segments: [] }));
  assert.match(xml, /Budget/);
  assert.ok(!xml.includes('Minutes of Meeting'));
});

test('cari menemukan judul, transkrip, MoM, tanpa peduli huruf besar', () => {
  assert.ok(matchesSearch(meeting(), 'BUDGET'));
  assert.ok(matchesSearch(meeting(), 'units'));
  assert.ok(matchesSearch(meeting(), 'friday'));
  assert.ok(!matchesSearch(meeting(), 'kangaroo'));
});

test('cari beberapa kata harus menemukan semuanya', () => {
  assert.ok(matchesSearch(meeting(), 'friday units'));
  assert.ok(!matchesSearch(meeting(), 'friday kangaroo'));
});

test('kata kunci kosong menampilkan semua', () => {
  assert.ok(matchesSearch(meeting(), '   '));
});

test('cuplikan menunjukkan baris transkrip yang cocok', () => {
  assert.equal(searchSnippet(meeting(), 'speaker'), 'no speaker line');
  assert.equal(searchSnippet(meeting(), 'budget'), '');
  assert.equal(searchSnippet(meeting(), ''), '');
});

test('cuplikan panjang dipotong di sekitar kata', () => {
  const long = meeting({ segments: [{ id: 1, speaker: '', text: `${'kata '.repeat(60)}anggaran ${'lain '.repeat(60)}`, t: 0 }] });
  const snippet = searchSnippet(long, 'anggaran');
  assert.ok(snippet.includes('anggaran'));
  assert.ok(snippet.length <= 122);
});
