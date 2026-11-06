import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../lib/merge.js');
const { replaceAudioSegments, upsertSegment } = globalThis.MeetMerge;

const caption = (id, speaker, text, t) => ({ id, speaker, text, t });
const heard = (text, t, extra = {}) => ({ speaker: '', text, t, ...extra });
const BASE = 500;
const run = (segments, audio, options = {}) => replaceAudioSegments(segments, audio, { baseTime: BASE, ...options });

test('a misheard caption takes the words from the audio and keeps its speaker', () => {
  const out = run([caption('c1', 'Ani', 'kita mulai rapat anggaran hari ikan', 1000)], [heard('Kita mulai rapat anggaran hari ini.', 1500)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'c1');
  assert.equal(out[0].speaker, 'Ani');
  assert.equal(out[0].t, 1000);
  assert.equal(out[0].text, 'Kita mulai rapat anggaran hari ini.');
});

test('a corrected line keeps what the caption said', () => {
  const [line] = run([caption('c1', 'Ani', 'kita mulai rapat anggaran hari ikan', 1000)], [heard('kita mulai rapat anggaran hari ini', 1500)]);
  assert.equal(line.captionText, 'kita mulai rapat anggaran hari ikan');
  assert.equal(line.correctedFrom, BASE);
});

test('several audio lines can correct one long caption', () => {
  const out = run(
    [caption('c1', 'Ani', 'anggaran bulan depan naik sepuluh persen lalu marketing dapat tambahan dana besar', 1000)],
    [heard('Anggaran bulan depan naik sepuluh persen.', 1200), heard('Lalu marketing dapat tambahan dana lebih besar.', 5000)],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'Anggaran bulan depan naik sepuluh persen. Lalu marketing dapat tambahan dana lebih besar.');
});

test('the same words with different punctuation change nothing', () => {
  const out = run([caption('c1', 'Ani', 'Halo semuanya, mari kita mulai', 1000)], [heard('halo semuanya mari kita mulai', 1500)]);
  assert.deepEqual(out, [caption('c1', 'Ani', 'Halo semuanya, mari kita mulai', 1000)]);
});

test('a different sentence never replaces a caption', () => {
  const out = run([caption('c1', 'Ani', 'kita mulai rapat anggaran hari ini', 1000)], [heard('peluncuran produk pindah ke bulan maret', 1500)]);
  assert.equal(out.length, 2);
  assert.equal(out[0].text, 'kita mulai rapat anggaran hari ini');
  assert.equal(out[0].captionText, undefined);
});

test('the same words in another order do not count as the same sentence', () => {
  const out = run([caption('c1', 'Ani', 'budi tolong kirim laporan ke ani besok', 1000)], [heard('besok ani kirim laporan ke budi tolong', 1500)]);
  assert.equal(out[0].captionText, undefined);
});

test('audio covering only part of a long caption does not shorten it', () => {
  const text = 'kita bahas anggaran lalu marketing kemudian penjualan dan terakhir rencana peluncuran produk baru';
  const out = run([caption('c1', 'Ani', text, 1000)], [heard('kita bahas anggaran lalu marketing', 1500)]);
  assert.equal(out[0].text, text);
  assert.equal(out[0].captionText, undefined);
});

test('much longer audio does not replace a short caption', () => {
  const out = run([caption('c1', 'Ani', 'kita mulai rapat anggaran', 1000)], [heard('kita mulai rapat anggaran dan membahas semua rencana penjualan untuk tahun depan', 1500)]);
  assert.equal(out[0].text, 'kita mulai rapat anggaran');
});

test('very short captions are left alone', () => {
  const out = run([caption('c1', 'Ani', 'ya betul', 1000)], [heard('ya benar', 1500)]);
  assert.equal(out[0].text, 'ya betul');
});

test('a caption edited by hand is never corrected', () => {
  const edited = { ...caption('c1', 'Ani', 'kita mulai rapat anggaran hari ikan', 1000), edited: true };
  const out = run([edited], [heard('kita mulai rapat anggaran hari ini', 1500)]);
  assert.equal(out[0].text, 'kita mulai rapat anggaran hari ikan');
});

test('audio far from a caption does not correct it', () => {
  const out = run([caption('c1', 'Ani', 'kita mulai rapat anggaran hari ikan', 1000)], [heard('kita mulai rapat anggaran hari ini', 200000)]);
  assert.equal(out[0].text, 'kita mulai rapat anggaran hari ikan');
  assert.equal(out.length, 2);
});

test('a failed audio part does not correct anything', () => {
  const out = run([caption('c1', 'Ani', 'kita mulai rapat anggaran hari ikan', 1000)], [heard('[transcript failed]', 500, { failedUntil: 120500 })]);
  assert.equal(out.find((s) => s.id === 'c1').text, 'kita mulai rapat anggaran hari ikan');
});

test('an audio line goes to the caption it matches best', () => {
  const out = run(
    [caption('c1', 'Ani', 'tolong kirim laporan anggaran besok pagi', 1000), caption('c2', 'Budi', 'nanti saya kirim laporan penjualan sore', 4000)],
    [heard('nanti saya kirim laporan penjualan sore ini', 4500)],
  );
  assert.equal(out[0].text, 'tolong kirim laporan anggaran besok pagi');
  assert.equal(out[1].text, 'nanti saya kirim laporan penjualan sore ini');
});

test('saving the same recording twice gives the same result', () => {
  const audio = [heard('kita mulai rapat anggaran hari ini', 1500)];
  const once = run([caption('c1', 'Ani', 'kita mulai rapat anggaran hari ikan', 1000)], audio);
  assert.deepEqual(run(once, audio), once);
});

test('retranscribing starts again from what the caption said', () => {
  const once = run([caption('c1', 'Ani', 'kita mulai rapat anggaran hari ikan', 1000)], [heard('kita mulai rapat anggaran hari ini', 1500)]);
  const again = run(once, [heard('kita mulai rapat anggaran hari esok', 1500)], { replace: true });
  assert.equal(again[0].text, 'kita mulai rapat anggaran hari esok');
  assert.equal(again[0].captionText, 'kita mulai rapat anggaran hari ikan');
});

test('retranscribing to something unrelated puts the caption back', () => {
  const once = run([caption('c1', 'Ani', 'kita mulai rapat anggaran hari ikan', 1000)], [heard('kita mulai rapat anggaran hari ini', 1500)]);
  const again = run(once, [heard('peluncuran produk pindah ke bulan maret', 1500)], { replace: true });
  assert.equal(again[0].text, 'kita mulai rapat anggaran hari ikan');
  assert.equal(again[0].captionText, undefined);
  assert.equal(again[0].correctedFrom, undefined);
});

test('a corrected line edited by hand keeps the edit when retranscribed', () => {
  const [line] = run([caption('c1', 'Ani', 'kita mulai rapat anggaran hari ikan', 1000)], [heard('kita mulai rapat anggaran hari ini', 1500)]);
  const edited = { ...line, text: 'rapat dimulai', edited: true };
  const [again] = run([edited], [heard('kita mulai rapat anggaran hari esok', 1500)], { replace: true });
  assert.equal(again.text, 'rapat dimulai');
});

test('a part that fails on retranscribe keeps its earlier correction', () => {
  const once = run([caption('c1', 'Ani', 'kita mulai rapat anggaran hari ikan', 1000)], [heard('kita mulai rapat anggaran hari ini', 1500), heard('peluncuran produk pindah ke bulan maret', 2000)]);
  const again = run(once, [heard('[transcript failed]', 500, { failedUntil: 120500 })], { replace: true });
  assert.equal(again.find((s) => s.id === 'c1').text, 'kita mulai rapat anggaran hari ini');
});

test('a correction from another recording stays when this one is saved', () => {
  const once = run([caption('c1', 'Ani', 'kita mulai rapat anggaran hari ikan', 1000)], [heard('kita mulai rapat anggaran hari ini', 1500)]);
  const other = replaceAudioSegments(once, [heard('peluncuran produk pindah ke bulan maret', 90000)], { baseTime: 900 });
  assert.equal(other.find((s) => s.id === 'c1').text, 'kita mulai rapat anggaran hari ini');
});

test('short audio lines repeating a corrected caption stay out', () => {
  const out = run([caption('c1', 'Ani', 'kita mulai rapat anggaran hari ikan', 1000)], [heard('kita mulai rapat anggaran hari ini', 1500), heard('hari ikan', 3000)]);
  assert.equal(out.length, 1);
});

test('the caption sending its old words again does not undo a correction', () => {
  const segments = run([caption('c1', 'Ani', 'kita mulai rapat anggaran hari ikan', 1000)], [heard('kita mulai rapat anggaran hari ini', 1500)]);
  upsertSegment(segments, caption('c1', 'Ani', 'kita mulai rapat anggaran hari ikan', 1000));
  assert.equal(segments[0].text, 'kita mulai rapat anggaran hari ini');
});

test('the caption changing to new words drops the correction', () => {
  const segments = run([caption('c1', 'Ani', 'kita mulai rapat anggaran hari ikan', 1000)], [heard('kita mulai rapat anggaran hari ini', 1500)]);
  upsertSegment(segments, caption('c1', 'Ani', 'kita mulai rapat anggaran hari ini dan besok', 1000));
  assert.equal(segments[0].text, 'kita mulai rapat anggaran hari ini dan besok');
  assert.equal(segments[0].captionText, undefined);
  assert.equal(segments[0].correctedFrom, undefined);
});

test('exports use the corrected words', () => {
  const segments = run([caption('c1', 'Ani', 'kita mulai rapat anggaran hari ikan', 1000)], [heard('kita mulai rapat anggaran hari ini', 1500)]);
  const text = globalThis.MeetMerge.formatTranscript(segments);
  assert.match(text, /hari ini/);
  assert.doesNotMatch(text, /ikan/);
});

test('a long meeting is corrected quickly', () => {
  const sentence = 'kita membahas rencana peluncuran produk baru minggu depan bersama seluruh tim';
  const captions = Array.from({ length: 1440 }, (_, i) => caption(`c${i}`, 'Ani', `${sentence} ${i} salah`, i * 5000));
  const audio = Array.from({ length: 1440 }, (_, i) => heard(`${sentence} ${i} benar`, i * 5000 + 200));
  const started = Date.now();
  const out = run(captions, audio);
  assert.equal(out.length, 1440);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});

test('a similar sentence from later in the meeting never rewrites a caption', () => {
  const out = run([caption('c1', 'Ani', 'kita bisa mulai rapat sekarang', 1000)], [heard('kita tidak bisa mulai rapat sekarang', 25000)]);
  assert.equal(out[0].text, 'kita bisa mulai rapat sekarang');
  assert.equal(out[0].captionText, undefined);
});

test('audio that only covers the start of a caption does not cut off the rest', () => {
  const text = 'we agreed the budget is ten thousand for marketing next quarter';
  const out = run([caption('c1', 'Ani', text, 1000)], [heard('we agreed the budget is ten thousand for', 1500)]);
  assert.equal(out[0].text, text);
});

test('audio that only covers the end of a caption does not cut off the start', () => {
  const text = 'we agreed the budget is ten thousand for marketing next quarter';
  const out = run([caption('c1', 'Ani', text, 1000)], [heard('budget is ten thousand for marketing next quarter', 1500)]);
  assert.equal(out[0].text, text);
});

test('a failed part keeps its corrections even when no audio line of its own remains', () => {
  const once = run([caption('c1', 'Ani', 'kita mulai rapat anggaran hari ikan', 1000)], [heard('kita mulai rapat anggaran hari ini', 1500)]);
  assert.equal(once.length, 1);
  const again = run(once, [heard('[transcript failed]', 500, { failedUntil: 120500 }), heard('peluncuran produk pindah ke bulan maret', 130000)], { replace: true });
  const line = again.find((s) => s.id === 'c1');
  assert.equal(line.text, 'kita mulai rapat anggaran hari ini');
  assert.equal(line.captionText, 'kita mulai rapat anggaran hari ikan');
});

test('a whole part returned as one block does not repeat the captions', () => {
  const sentences = ['kita mulai rapat anggaran hari ini', 'bulan depan anggaran naik sepuluh persen', 'marketing minta tambahan untuk iklan baru', 'penjualan bulan lalu sudah melewati target', 'tim produk siap merilis fitur minggu depan', 'budi akan mengirim laporan besok pagi'];
  const captions = sentences.map((text, i) => caption(`c${i}`, i % 2 ? 'Budi' : 'Ani', text, 1000 + i * 8000));
  const out = run(captions, [heard(sentences.join(' '), 500)]);
  assert.equal(out.length, sentences.length);
});

test('a block with speech the captions missed is still kept', () => {
  const captions = [caption('c0', 'Ani', 'kita mulai rapat anggaran hari ini', 1000)];
  const missed = 'peluncuran produk pindah ke bulan maret karena pabrik belum siap dan tim logistik masih menunggu bahan baku dari pemasok utama kita';
  const out = run(captions, [heard(`kita mulai rapat anggaran hari ini ${missed}`, 500)]);
  assert.equal(out.length, 2);
});
