import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../lib/merge.js');
const { upsertSegment, replaceAudioSegments, formatTranscript, formatMarkdown, fillTemplate,
  DEFAULT_MOM_TEMPLATE } = globalThis.MeetMerge;

const audio = (t, text) => ({ t, text, speaker: '' });

test('upsertSegment appends segmen dengan id baru', () => {
  const segs = [];
  upsertSegment(segs, { id: 1, speaker: 'Ani', text: 'halo', t: 0 });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].text, 'halo');
});

test('upsertSegment update in-place untuk id yang sama, tidak duplikat', () => {
  const segs = [];
  upsertSegment(segs, { id: 1, speaker: 'Ani', text: 'halo', t: 0 });
  upsertSegment(segs, { id: 1, speaker: 'Ani', text: 'halo semua', t: 0 });
  upsertSegment(segs, { id: 2, speaker: 'Budi', text: 'hai', t: 1000 });
  upsertSegment(segs, { id: 1, speaker: 'Ani', text: 'halo semuanya', t: 0 });
  assert.equal(segs.length, 2);
  assert.equal(segs[0].text, 'halo semuanya');
  assert.equal(segs[1].text, 'hai');
});

test('replaceAudioSegments mengisi meeting kosong dan memberi id bercap baseTime', () => {
  const out = replaceAudioSegments([], [audio(0, 'halo'), audio(1000, 'hai')], { baseTime: 100 });
  assert.deepEqual(out.map((s) => s.id), ['audio:100:0', 'audio:100:1']);
  assert.deepEqual(out.map((s) => s.text), ['halo', 'hai']);
});

test('transkrip ulang (replace) MENGGANTI grup rekaman yang sama, bukan menumpuk', () => {
  const opt = { baseTime: 100, replace: true };
  const first = replaceAudioSegments([], [audio(0, '[transkrip gagal]'), audio(1000, '[transkrip gagal]')], opt);
  const second = replaceAudioSegments(first, [audio(0, 'halo'), audio(1000, 'hai')], opt);
  assert.equal(second.length, 2);
  assert.deepEqual(second.map((s) => s.text), ['halo', 'hai']);
});

test('rekaman BARU di ruang yang sama menambah, tidak menghapus rekaman sebelumnya', () => {
  const first = replaceAudioSegments([], [audio(0, 'sesi satu')], { baseTime: 100 });
  const second = replaceAudioSegments(first, [audio(9000, 'sesi dua')], { baseTime: 9000 });
  assert.deepEqual(second.map((s) => s.text), ['sesi satu', 'sesi dua']);
  assert.deepEqual(second.map((s) => s.id), ['audio:100:0', 'audio:9000:0']);
});

test('id lama tanpa cap dibuang hanya saat transkrip ulang rekaman legacy', () => {
  const lama = [{ id: 'audio:0', speaker: '', text: 'lama', t: 0 }];
  const tambah = replaceAudioSegments(lama, [audio(1000, 'baru')], { baseTime: 500 });
  assert.deepEqual(tambah.map((s) => s.text), ['lama', 'baru'], 'rekaman baru menambah');
  const ulangLegacy = replaceAudioSegments(lama, [audio(1000, 'baru')],
    { baseTime: 500, replace: true, legacy: true });
  assert.deepEqual(ulangLegacy.map((s) => s.text), ['baru'], 'transkrip ulang legacy mengganti');
});

test('transkrip ulang rekaman bercap TIDAK menghapus rekaman legacy milik lain', () => {
  const lama = [{ id: 'audio:0', speaker: '', text: 'rekaman lama', t: 0 }];
  const dua = replaceAudioSegments(lama, [audio(9000, 'rekaman baru')], { baseTime: 9000 });
  const ulang = replaceAudioSegments(dua, [audio(9000, 'baru diperbaiki')],
    { baseTime: 9000, replace: true, legacy: false });
  assert.deepEqual(ulang.map((s) => s.text), ['rekaman lama', 'baru diperbaiki']);
});

test('replaceAudioSegments mempertahankan segmen dari caption', () => {
  const withCaption = [{ id: 'cap-1', speaker: 'Ani', text: 'halo', t: 0 }];
  const opt = { baseTime: 1, replace: true };
  const out = replaceAudioSegments(replaceAudioSegments(withCaption, [audio(5, 'a')], opt), [audio(5, 'b')], opt);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'cap-1');
  assert.equal(out[1].text, 'b');
});

test('replaceAudioSegments mengurutkan gabungan caption+audio per waktu', () => {
  const caption = [
    { id: 'cap-1', speaker: 'Ani', text: 'pembuka', t: 1000 },
    { id: 'cap-2', speaker: 'Budi', text: 'penutup', t: 9000 },
  ];
  const out = replaceAudioSegments(caption, [audio(3000, 'tengah'), audio(12000, 'setelah')], { baseTime: 7 });
  assert.deepEqual(out.map((s) => s.text), ['pembuka', 'tengah', 'penutup', 'setelah']);
  assert.deepEqual(out.map((s) => s.t), [1000, 3000, 9000, 12000]);
  assert.deepEqual(out.filter((s) => s.id.startsWith('audio:')).map((s) => s.id), ['audio:7:0', 'audio:7:1']);
});

test('baris audio yang mengulang caption terdekat tidak ditambahkan', () => {
  const caption = [{ id: 'cap-1', speaker: 'Ani', text: 'Halo semuanya, mari kita mulai', t: 10000 }];
  const out = replaceAudioSegments(caption, [audio(12000, 'halo semuanya mari kita mulai')], { baseTime: 7 });
  assert.deepEqual(out.map((s) => s.id), ['cap-1']);
  assert.equal(out[0].speaker, 'Ani');
});

test('baris audio yang isinya berbeda tetap ditambahkan', () => {
  const caption = [{ id: 'cap-1', speaker: 'Ani', text: 'Halo semuanya, mari kita mulai', t: 10000 }];
  const out = replaceAudioSegments(caption, [audio(12000, 'anggaran bulan depan naik sepuluh persen')], { baseTime: 7 });
  assert.deepEqual(out.map((s) => s.id), ['cap-1', 'audio:7:0']);
});

test('kata yang sama jauh dari caption bukan duplikat', () => {
  const caption = [{ id: 'cap-1', speaker: 'Ani', text: 'kita lanjut besok', t: 1000 }];
  const out = replaceAudioSegments(caption, [audio(120000, 'kita lanjut besok')], { baseTime: 7 });
  assert.equal(out.length, 2);
});

test('rekaman lain tidak dihitung sebagai caption', () => {
  const first = replaceAudioSegments([], [audio(1000, 'kita lanjut besok')], { baseTime: 7 });
  const out = replaceAudioSegments(first, [audio(2000, 'kita lanjut besok')], { baseTime: 8 });
  assert.equal(out.length, 2);
});

test('giliran bicara panjang: baris audio di akhir caption tetap dianggap duplikat', () => {
  const opening = Array.from({ length: 130 }, (_, i) => `kata${i}`).join(' ');
  const caption = [{ id: 'cap-1', speaker: 'Ani', text: `${opening} kita tutup rapat hari ini`, t: 1000 }];
  const out = replaceAudioSegments(caption, [audio(61000, 'kita tutup rapat hari ini')], { baseTime: 7 });
  assert.deepEqual(out.map((s) => s.id), ['cap-1']);
});

test('balasan pendek dari potongan beberapa caption bukan duplikat', () => {
  const caption = [
    { id: 'cap-1', speaker: 'Ani', text: 'ya nanti kita lihat dulu', t: 1000 },
    { id: 'cap-2', speaker: 'Budi', text: 'oke bisa, saya cek', t: 3000 },
  ];
  const out = replaceAudioSegments(caption, [audio(4000, 'ya bisa, nanti saya cek')], { baseTime: 7 });
  assert.equal(out.length, 3);
});

test('salah eja kecil dari STT tetap dianggap duplikat', () => {
  const caption = [{ id: 'cap-1', speaker: 'Ani', text: 'semuanya bersiap untuk memulai rapat', t: 1000 }];
  const out = replaceAudioSegments(caption, [audio(2000, 'semuanya bersiap untk memulai rapatt')], { baseTime: 7 });
  assert.deepEqual(out.map((s) => s.id), ['cap-1']);
});

test('replaceAudioSegments dengan hasil kosong TIDAK menghapus transkrip lama', () => {
  const opt = { baseTime: 100, replace: true };
  const first = replaceAudioSegments([{ id: 'cap-1', text: 'x', speaker: 'Ani', t: 0 }],
    [audio(0, 'halo'), audio(1000, 'hai')], opt);
  const out = replaceAudioSegments(first, [], opt);
  assert.deepEqual(out.map((s) => s.id), ['cap-1', 'audio:100:0', 'audio:100:1']);
  assert.deepEqual(out.map((s) => s.text), ['x', 'halo', 'hai']);
});

test('formatTranscript satu baris per segmen', () => {
  const t = new Date(2026, 0, 1, 9, 5, 7).getTime();
  const out = formatTranscript([{ id: 1, speaker: 'Ani', text: 'halo', t }]);
  assert.equal(out, '[09:05:07] Ani: halo');
});

test('formatMarkdown berisi judul, segmen, dan MoM bila ada', () => {
  const t = new Date(2026, 0, 1, 9, 5, 7).getTime();
  const md = formatMarkdown({
    title: 'abc-defg-hij', startedAt: t, mom: 'ringkasan',
    segments: [{ id: 1, speaker: 'Ani', text: 'halo', t }],
  });
  assert.ok(md.startsWith('# abc-defg-hij'));
  assert.ok(md.includes('- **Ani** (09:05:07): halo'));
  assert.ok(md.includes('## MoM'));
  assert.ok(md.includes('ringkasan'));
});

test('formatTranscript tanpa speaker (mode audio)', () => {
  const t = new Date(2026, 0, 1, 9, 5, 7).getTime();
  assert.equal(formatTranscript([{ id: 1, speaker: '', text: 'halo', t }]), '[09:05:07] halo');
});

test('formatMarkdown tanpa speaker tidak menulis ****', () => {
  const t = new Date(2026, 0, 1, 9, 5, 7).getTime();
  const md = formatMarkdown({ title: 'x', startedAt: t, mom: null, segments: [{ id: 1, speaker: '', text: 'halo', t }] });
  assert.ok(md.includes('- (09:05:07): halo'));
  assert.ok(!md.includes('****'));
});

test('formatMarkdown tanpa MoM tidak menulis heading MoM', () => {
  const md = formatMarkdown({ title: 'x', startedAt: 0, segments: [], mom: null });
  assert.ok(!md.includes('## MoM'));
});

test('fillTemplate mengganti semua placeholder', () => {
  assert.equal(fillTemplate('A {{transcript}} B {{transcript}}', 'X'), 'A X B X');
});

test('fillTemplate tidak menafsirkan pola $ di transkrip', () => {
  assert.equal(fillTemplate('X {{transcript}} Y', 'a$&b'), 'X a$&b Y');
});

test('DEFAULT_MOM_TEMPLATE mengandung placeholder', () => {
  assert.ok(DEFAULT_MOM_TEMPLATE.includes('{{transcript}}'));
});

const { lastActivityAt, isStaleMeeting, SESSION_GAP_MS, CRASH_GAP_MS } = globalThis.MeetMerge;
const MIN = 60000;
const mk = (over = {}) => ({ id: 'abc-defg-hij', title: 't', startedAt: 0, endedAt: null, segments: [], mom: null, ...over });

test('lastActivityAt pakai endedAt kalau tercatat', () => {
  assert.equal(lastActivityAt(mk({ endedAt: 5000, segments: [{ t: 9000 }] })), 5000);
});

test('lastActivityAt jatuh ke segmen terakhir kalau endedAt null (crash)', () => {
  assert.equal(lastActivityAt(mk({ segments: [{ t: 3000 }, { t: 8000 }, { t: 4000 }] })), 8000);
});

test('lastActivityAt jatuh ke startedAt untuk record tanpa segmen', () => {
  assert.equal(lastActivityAt(mk({ startedAt: 1234 })), 1234);
});

test('isStaleMeeting: meeting berakhir < gap = sesi sama, tidak stale', () => {
  const m = mk({ endedAt: 1000000 });
  assert.equal(isStaleMeeting(m, 1000000 + SESSION_GAP_MS - MIN), false);
});

test('isStaleMeeting: meeting berakhir > gap = occurrence baru, stale', () => {
  const m = mk({ endedAt: 1000000 });
  assert.equal(isStaleMeeting(m, 1000000 + SESSION_GAP_MS + MIN), true);
});

test('isStaleMeeting: meeting LIVE yang hening 40 menit TIDAK stale (endedAt null pakai ambang crash)', () => {
  const m = mk({ segments: [{ t: 1000000 }] });
  assert.equal(isStaleMeeting(m, 1000000 + 40 * MIN), false);
});

test('isStaleMeeting: crash tanpa endedAt, aktivitas terakhir > ambang crash = stale', () => {
  const m = mk({ segments: [{ t: 1000000 }] });
  assert.equal(isStaleMeeting(m, 1000000 + CRASH_GAP_MS + MIN), true);
});

test('ownerOfRecording pilih record termuda yang mulai <= baseTime rekaman', () => {
  const { ownerOfRecording } = globalThis.MeetMerge;
  const a = mk({ id: 'x@1', startedAt: 1000 });
  const b = mk({ id: 'x@2', startedAt: 5000 });
  const c = mk({ id: 'x', startedAt: 9000 });
  assert.equal(ownerOfRecording([a, b, c], 7000), b);
  assert.equal(ownerOfRecording([a, b, c], 500), null);
  assert.equal(ownerOfRecording([null, a], 2000), a);
});

test('transkrip panjang dengan caption selesai dalam waktu wajar', () => {
  const segment = 'kita membahas rencana peluncuran produk baru minggu depan bersama seluruh tim';
  const captions = Array.from({ length: 1440 }, (_, i) => ({ id: `cap-${i}`, speaker: 'Ani', text: `${segment} ${i}`, t: i * 5000 }));
  const lines = Array.from({ length: 1200 }, (_, i) => audio(i * 6000, `pembahasan anggaran bagian ${i} sudah selesai`));
  const started = Date.now();
  const out = replaceAudioSegments(captions, lines, { baseTime: 7 });
  const took = Date.now() - started;
  assert.equal(out.length, 2640);
  assert.ok(took < 1000, `took ${took} ms`);
});

const OLD_DEFAULT = `Buat Minutes of Meeting (MoM) dari transkrip meeting berikut.

Format:
## Date:
## Related Project:
## Participants
## Context
## Discussion
## Action Items (siapa, apa)

Transkrip:
{{transcript}}`;

test('the default MoM template asks for the language of the meeting', () => {
  assert.match(DEFAULT_MOM_TEMPLATE, /main language spoken in the transcript/);
  assert.match(DEFAULT_MOM_TEMPLATE, /including the section headings/);
  assert.ok(DEFAULT_MOM_TEMPLATE.includes('{{transcript}}'));
});

test('an empty or unedited old template uses the new default', () => {
  const { momTemplateOf } = globalThis.MeetMerge;
  assert.equal(momTemplateOf(undefined), DEFAULT_MOM_TEMPLATE);
  assert.equal(momTemplateOf(''), DEFAULT_MOM_TEMPLATE);
  assert.equal(momTemplateOf(OLD_DEFAULT), DEFAULT_MOM_TEMPLATE);
});

test('a template you edited is never changed', () => {
  const { momTemplateOf } = globalThis.MeetMerge;
  const custom = `${OLD_DEFAULT}\nTulis dalam Bahasa Inggris.`;
  assert.equal(momTemplateOf(custom), custom);
});

test('recorded audio fills only what the captions missed', () => {
  const captions = [
    { id: 'c0', speaker: 'Ani', text: 'kita mulai rapat anggaran hari ini', t: 1000 },
    { id: 'c1', speaker: 'Budi', text: 'setuju, kita lanjut ke marketing', t: 8000 },
  ];
  const audio = [
    { speaker: '', text: 'kita mulai rapat anggaran hari ini', t: 1200 },
    { speaker: '', text: 'peluncuran produk pindah ke bulan maret', t: 90000 },
  ];
  const merged = replaceAudioSegments(captions, audio, { baseTime: 500 });
  assert.deepEqual(merged.map((s) => s.text), [captions[0].text, captions[1].text, audio[1].text]);
  assert.deepEqual(merged.map((s) => s.speaker), ['Ani', 'Budi', '']);
  assert.equal(merged[2].id, 'audio:500:0');
});

test('recorded audio becomes the transcript when captions gave nothing', () => {
  const audio = [{ speaker: '', text: 'halo semua', t: 1000 }];
  assert.deepEqual(replaceAudioSegments([], audio, { baseTime: 1 }).map((s) => s.text), ['halo semua']);
});

test('MoM needs a key only for the default OpenAI address', () => {
  const { canMakeMom } = globalThis.MeetMerge;
  assert.equal(canMakeMom({}), false);
  assert.equal(canMakeMom({ baseUrl: 'https://api.openai.com/v1' }), false);
  assert.equal(canMakeMom({ apiKey: 'k' }), true);
  assert.equal(canMakeMom({ apiKey: 'k', baseUrl: 'https://api.openai.com/v1' }), true);
  assert.equal(canMakeMom({ baseUrl: 'http://localhost:11434/v1' }), true);
});

const lines = () => [
  { id: 'a', speaker: 'Others', text: 'halo', t: 1 },
  { id: 'b', speaker: 'You', text: 'hai', t: 2 },
  { id: 'c', speaker: 'Others', text: 'mulai', t: 3 },
];

test('renaming a speaker changes every line with that name', () => {
  const { applyTranscriptEdit } = globalThis.MeetMerge;
  const out = applyTranscriptEdit(lines(), { from: 'Others', to: ' Budi ' });
  assert.deepEqual(out.map((s) => s.speaker), ['Budi', 'You', 'Budi']);
});

test('a line can be given no speaker name', () => {
  const { applyTranscriptEdit } = globalThis.MeetMerge;
  assert.equal(applyTranscriptEdit(lines(), { from: 'You', to: '  ' })[1].speaker, '');
});

test('editing a line changes only that line', () => {
  const { applyTranscriptEdit } = globalThis.MeetMerge;
  const out = applyTranscriptEdit(lines(), { segmentId: 'b', text: ' hai semua ' });
  assert.deepEqual(out.map((s) => s.text), ['halo', 'hai semua', 'mulai']);
  assert.deepEqual(out.map((s) => !!s.edited), [false, true, false]);
});

test('emptying a line removes it', () => {
  const { applyTranscriptEdit } = globalThis.MeetMerge;
  assert.deepEqual(applyTranscriptEdit(lines(), { segmentId: 'b', text: '  ' }).map((s) => s.id), ['a', 'c']);
});

test('an unchanged line is not marked as edited', () => {
  const { applyTranscriptEdit } = globalThis.MeetMerge;
  const out = applyTranscriptEdit(lines(), { segmentId: 'a', text: 'halo' });
  assert.equal(out[0].edited, undefined);
});

test('an unknown line changes nothing', () => {
  const { applyTranscriptEdit } = globalThis.MeetMerge;
  assert.deepEqual(applyTranscriptEdit(lines(), { segmentId: 'zzz', text: 'x' }), lines());
});

const tagged = (i, text, t, extra = {}) => ({ id: `audio:7:${i}`, speaker: 'Others', text, t, ...extra });
const failedPart = (t, until) => ({ t, speaker: 'Others', text: '[transcript failed]', failedUntil: until });

test('a failed part keeps its old lines when retranscribing', () => {
  const old = [tagged(0, 'bagian satu', 1000), tagged(1, 'bagian dua', 130000)];
  const fresh = [{ t: 1500, speaker: 'Others', text: 'bagian satu baru' }, failedPart(120000, 240000)];
  const out = replaceAudioSegments(old, fresh, { baseTime: 7, replace: true });
  assert.deepEqual(out.map((s) => s.text), ['bagian satu baru', 'bagian dua']);
  assert.equal(new Set(out.map((s) => s.id)).size, 2);
});

test('other tracks in a failed part keep their old lines too', () => {
  const old = [tagged(0, 'lama', 130000)];
  const fresh = [{ t: 131000, speaker: 'You', text: 'baru mikrofon' }, failedPart(120000, 240000)];
  const out = replaceAudioSegments(old, fresh, { baseTime: 7, replace: true });
  assert.deepEqual(out.map((s) => s.text), ['lama']);
});

test('a failed part with nothing to keep shows the marker', () => {
  const out = replaceAudioSegments([], [failedPart(0, 120000)], { baseTime: 7 });
  assert.deepEqual(out.map((s) => s.text), ['[transcript failed]']);
  assert.equal(out[0].failed, true);
  assert.equal(out[0].failedUntil, undefined);
});

test('an old failure marker is replaced, not kept', () => {
  const old = replaceAudioSegments([], [failedPart(0, 120000)], { baseTime: 7 });
  const again = replaceAudioSegments(old, [failedPart(0, 120000)], { baseTime: 7, replace: true });
  assert.equal(again.length, 1);
  const fixed = replaceAudioSegments(old, [{ t: 10, speaker: 'Others', text: 'berhasil' }], { baseTime: 7, replace: true });
  assert.deepEqual(fixed.map((s) => s.text), ['berhasil']);
});

test('new audio lines use the names you chose', () => {
  const out = replaceAudioSegments([], [{ t: 1, speaker: 'Others', text: 'a' }, { t: 2, speaker: 'You', text: 'b' }], { baseTime: 7, names: { Others: 'Budi' } });
  assert.deepEqual(out.map((s) => s.speaker), ['Budi', 'You']);
});

test('editMeeting remembers renames, including a second rename', () => {
  const { editMeeting } = globalThis.MeetMerge;
  const meeting = { segments: [{ id: 'a', speaker: 'Others', text: 'x', t: 1 }] };
  editMeeting(meeting, { from: 'Others', to: ' Budi ' });
  assert.deepEqual(meeting.speakerNames, { Others: 'Budi' });
  assert.equal(meeting.segments[0].speaker, 'Budi');
  editMeeting(meeting, { from: 'Budi', to: 'Ani' });
  assert.equal(meeting.speakerNames.Others, 'Ani');
  editMeeting(meeting, { segmentId: 'a', text: 'y' });
  assert.equal(meeting.segments[0].text, 'y');
});

test('meetings are grouped by how long ago they were', () => {
  const { dateGroup } = globalThis.MeetMerge;
  const now = new Date(2026, 10, 6, 15, 0).getTime();
  const at = (day, hour = 9) => new Date(2026, 10, day, hour).getTime();
  assert.equal(dateGroup(at(6), now), 'Today');
  assert.equal(dateGroup(at(5, 23), now), 'Yesterday');
  assert.equal(dateGroup(at(1), now), 'This week');
  assert.equal(dateGroup(at(30 - 25), now), 'Yesterday');
  assert.equal(dateGroup(new Date(2026, 9, 20).getTime(), now), 'Earlier');
});

test('time left follows the speed so far', () => {
  const { minutesLeft } = globalThis.MeetMerge;
  assert.equal(minutesLeft(0, 10, 5000), null);
  assert.equal(minutesLeft(5, 10, 300000), 5);
  assert.equal(minutesLeft(9, 10, 9000), 1);
  assert.equal(minutesLeft(10, 10, 9000), null);
});

const subtitleLines = [
  { id: 'a', speaker: 'Ani', text: 'halo semua', t: 100000 },
  { id: 'b', speaker: '', text: 'kita mulai sekarang', t: 103500 },
];

test('SRT numbers each line and uses commas in times', () => {
  const { formatSubtitles } = globalThis.MeetMerge;
  assert.equal(formatSubtitles(subtitleLines, 'srt'),
    '1\n00:00:00,000 --> 00:00:01,000\nAni: halo semua\n\n2\n00:00:03,500 --> 00:00:04,700\nkita mulai sekarang\n');
});

test('VTT has its header and uses dots in times', () => {
  const { formatSubtitles } = globalThis.MeetMerge;
  assert.equal(formatSubtitles(subtitleLines, 'vtt'),
    'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nAni: halo semua\n\n00:00:03.500 --> 00:00:04.700\nkita mulai sekarang\n');
});

test('a subtitle ends before the next line starts', () => {
  const { formatSubtitles } = globalThis.MeetMerge;
  const out = formatSubtitles([{ speaker: '', text: 'satu dua tiga empat lima enam tujuh', t: 0 }, { speaker: '', text: 'x', t: 1000 }], 'vtt');
  assert.ok(out.includes('00:00:00.000 --> 00:00:01.000'));
});

test('subtitles of long meetings count hours', () => {
  const { formatSubtitles } = globalThis.MeetMerge;
  const out = formatSubtitles([{ speaker: '', text: 'a', t: 0 }, { speaker: '', text: 'b', t: 3723004 }], 'srt');
  assert.ok(out.includes('01:02:03,004 --> '));
});

test('every MoM type has the transcript and the language rule', () => {
  const { MOM_PRESETS } = globalThis.MeetMerge;
  assert.equal(MOM_PRESETS[0].template, DEFAULT_MOM_TEMPLATE);
  assert.ok(MOM_PRESETS.length >= 4);
  for (const { name, template } of MOM_PRESETS) {
    assert.ok(template.includes('{{transcript}}'), name);
    assert.ok(template.includes('main language spoken'), name);
  }
});

test('the MoM prompt lists marked moments', () => {
  const { momPrompt } = globalThis.MeetMerge;
  const at = new Date(2026, 0, 1, 10, 5, 12).getTime();
  const plain = momPrompt({ segments: [{ speaker: 'Ani', text: 'halo', t: at }] }, {});
  assert.ok(plain.includes('Ani: halo'));
  assert.ok(!plain.includes('marked'));
  const marked = momPrompt({ segments: [{ speaker: 'Ani', text: 'halo', t: at }], marks: [at] }, {});
  assert.ok(marked.includes('marked during the meeting'));
  assert.ok(marked.includes('10:05:12'));
});

test('the question prompt holds the question and transcript', () => {
  const { askPrompt } = globalThis.MeetMerge;
  const prompt = askPrompt({ segments: [{ speaker: 'Ani', text: 'anggaran naik', t: 0 }] }, 'Berapa anggaran?');
  assert.ok(prompt.includes('Berapa anggaran?'));
  assert.ok(prompt.includes('anggaran naik'));
  assert.match(prompt, /only/);
});

test('a line is found inside its recording part', () => {
  const { locateLine } = globalThis.MeetMerge;
  assert.deepEqual(locateLine(1000 + 125000, 1000, 120000), { index: 1, offset: 4.7 });
  assert.deepEqual(locateLine(1100, 1000, 120000), { index: 0, offset: 0 });
});

test('only meetings past the limit are expired', () => {
  const { expiredMeetingIds } = globalThis.MeetMerge;
  const day = 86400000;
  const now = 100 * day;
  const list = [{ id: 'old', endedAt: 89 * day }, { id: 'new', endedAt: 95 * day }, { id: 'running', endedAt: null }];
  assert.deepEqual(expiredMeetingIds(list, 10, now), ['old']);
  assert.deepEqual(expiredMeetingIds(list, 0, now), []);
  assert.deepEqual(expiredMeetingIds(list, 'x', now), []);
  assert.deepEqual(expiredMeetingIds(list, undefined, now), []);
});
