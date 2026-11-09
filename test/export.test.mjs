import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../lib/merge.js');
await import('../lib/backup.js');
await import('../lib/export.js');
const { makeDocx } = globalThis.MeetExport;
const { readZip } = globalThis.MeetBackup;
const { matchesSearch, searchSnippet, formatTranscript, formatWithMarks, formatMarkdown, askPrompt } = globalThis.MeetMerge;

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

test('docx keeps emoji', async () => {
  const { xml } = await documentXml(meeting({ mom: 'Selesai \u{1F680} \u{0001}oke' }));
  assert.ok(xml.includes('Selesai \u{1F680} oke'));
});

const marked = (extra = {}) => meeting({ marks: [new Date(2026, 0, 2, 9, 0, 7).getTime()], ...extra });

test('text exports put a mark between the lines around it', () => {
  assert.equal(formatWithMarks(marked()), [
    '[09:00:05] Ani: We need 5 < 10 "units" & more',
    '[09:00:07] ★ Marked',
    '[09:00:09] no speaker line',
  ].join('\n'));
});

test('text exports without marks stay the same', () => {
  assert.equal(formatWithMarks(meeting()), formatTranscript(meeting().segments));
});

test('markdown puts a mark between the lines around it', () => {
  const lines = formatMarkdown(marked()).split('\n');
  const at = lines.indexOf('- **★ Marked** (09:00:07)');
  assert.ok(at > 0);
  assert.match(lines[at - 1], /Ani/);
  assert.match(lines[at + 1], /no speaker line/);
});

test('docx puts a mark between the lines around it', async () => {
  const { xml } = await documentXml(marked());
  const at = xml.indexOf('★ Marked');
  assert.ok(xml.indexOf('Ani') < at && at < xml.indexOf('no speaker line'));
  assert.match(xml, /09:00:07/);
});

test('a meeting with only marks still exports them', async () => {
  const { xml } = await documentXml(marked({ mom: null, segments: [] }));
  assert.match(xml, /★ Marked/);
  assert.match(formatMarkdown(marked({ mom: null, segments: [] })), /★ Marked/);
});

test('marks stay out of the AI prompt transcript', () => {
  assert.ok(!askPrompt(marked(), 'Apa?').includes('★'));
});

test('markdown keeps meeting text from turning into formatting', () => {
  const md = formatMarkdown(meeting({
    title: '# Plan *final*',
    mom: '## Decisions',
    segments: [{ id: 1, speaker: 'A_[x]', text: '<img src=x onerror=alert(1)> **bold** [link](javascript:x)\n# heading', t: 1 }],
  }));
  const lines = md.split('\n');
  assert.equal(lines[0], '# \\# Plan \\*final\\*');
  assert.ok(md.includes('\\<img'));
  assert.ok(md.includes('\\*\\*bold\\*\\*'));
  assert.ok(md.includes('\\[link\\](javascript'));
  assert.ok(!lines.includes('# heading'));
  assert.ok(md.includes('**A\\_\\[x\\]**'));
  assert.ok(lines.includes('## Decisions'));
});
