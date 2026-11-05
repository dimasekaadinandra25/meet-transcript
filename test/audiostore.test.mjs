import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../lib/audiostore.js');
const { groupRecordings, pruneTargets, keysOfMeeting, KEEP_RECORDINGS } = globalThis.MeetAudioStore;

const metaOf = (over = {}) => ({ meetingId: 'abc-defg-hij', chunkMs: 600000,
  baseTime: 1000, count: 0, videoCount: 0, ...over });

test('layout baru: chunk & vchunk dikelompokkan ke rekamannya', () => {
  const metas = new Map([
    ['meta:1000', metaOf({ baseTime: 1000, count: 2, videoCount: 1 })],
    ['meta:2000', metaOf({ baseTime: 2000, meetingId: 'discord-1-2', count: 1 })],
  ]);
  const keys = ['meta:1000', 'chunk:1000:0', 'chunk:1000:1', 'vchunk:1000:0',
    'meta:2000', 'chunk:2000:0'];
  const recs = groupRecordings(keys, metas);
  assert.deepEqual(recs.map((r) => r.recId), [2000, 1000]);
  assert.equal(recs[1].meetingId, 'abc-defg-hij');
  assert.deepEqual(recs[1].chunkKeys.map((c) => c.key), ['chunk:1000:0', 'chunk:1000:1']);
  assert.deepEqual(recs[1].videoKeys.map((c) => c.key), ['vchunk:1000:0']);
  assert.equal(recs[1].legacy, false);
  assert.equal(recs[1].oldKeys, false);
  assert.deepEqual([...recs[1].keys].sort(),
    ['chunk:1000:0', 'chunk:1000:1', 'meta:1000', 'vchunk:1000:0']);
});

test('urutan numerik, bukan leksikografis', () => {
  const metas = new Map([['meta:1000', metaOf({ count: 11 })]]);
  const keys = ['meta:1000', ...Array.from({ length: 11 }, (_, i) => `chunk:1000:${i}`)];
  const recs = groupRecordings(keys.slice().reverse(), metas);
  assert.deepEqual(recs[0].chunkKeys.map((c) => c.index),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('indeks bolong tetap mengembalikan indeks ASLI', () => {
  const metas = new Map([['meta:1000', metaOf({ count: 4 })]]);
  const recs = groupRecordings(
    ['meta:1000', 'chunk:1000:0', 'chunk:1000:2', 'chunk:1000:3'], metas);
  assert.deepEqual(recs[0].chunkKeys.map((c) => c.index), [0, 2, 3]);
});

test('bentuk key lama dibaca sebagai SATU rekaman, flag oldKeys', () => {
  const metas = new Map([['meta', metaOf({ baseTime: 1500, count: 2 })]]);
  const recs = groupRecordings(
    ['meta', 'chunk:0', 'chunk:1', 'vchunk:0'], metas);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].recId, 1500);
  assert.equal(recs[0].oldKeys, true);
  assert.equal(recs[0].legacy, false);
  assert.deepEqual(recs[0].chunkKeys.map((c) => c.index), [0, 1]);
  assert.deepEqual(recs[0].videoKeys.map((c) => c.index), [0]);
});

test("layout 'blobs' ≤0.3 menyalakan legacy, bukan oldKeys saja", () => {
  const metas = new Map([['meta', metaOf({ baseTime: 900 })]]);
  const recs = groupRecordings(['meta', 'blobs'], metas);
  assert.equal(recs[0].legacy, true);
  assert.equal(recs[0].oldKeys, true);
  assert.deepEqual([...recs[0].keys].sort(), ['blobs', 'meta']);
});

test('meta legacy tanpa baseTime → recId 0, bukan NaN', () => {
  const metas = new Map([['meta', { meetingId: 'abc-defg-hij', count: 1 }]]);
  const recs = groupRecordings(['meta', 'chunk:0'], metas);
  assert.equal(recs[0].recId, 0);
  assert.deepEqual(recs[0].chunkKeys.map((c) => c.key), ['chunk:0']);
});

test('chunk tanpa meta diabaikan, tidak jadi rekaman hantu', () => {
  const metas = new Map([['meta:2000', metaOf({ baseTime: 2000 })]]);
  const recs = groupRecordings(['meta:2000', 'chunk:2000:0', 'chunk:1000:0'], metas);
  assert.deepEqual(recs.map((r) => r.recId), [2000]);
});

test('recId legacy yang bertabrakan dengan meta: baru tidak menimpanya', () => {
  const metas = new Map([
    ['meta:1000', metaOf({ baseTime: 1000, meetingId: 'baru' })],
    ['meta', metaOf({ baseTime: 1000, meetingId: 'lama' })],
  ]);
  const recs = groupRecordings(['meta:1000', 'meta'], metas);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].meetingId, 'baru');
  assert.equal(recs[0].oldKeys, false);
});

test('store kosong → daftar kosong', () => {
  assert.deepEqual(groupRecordings([], new Map()), []);
});

test('pruneTargets: tepat KEEP tidak memangkas apa pun', () => {
  assert.equal(KEEP_RECORDINGS, 5);
  const recs = Array.from({ length: 5 }, (_, i) => ({ recId: i, keys: [`meta:${i}`] }));
  assert.deepEqual(pruneTargets(recs), []);
});

test('pruneTargets: lebih dari KEEP memangkas yang TERTUA beserta chunk-nya', () => {
  const recs = Array.from({ length: 6 }, (_, i) => ({
    recId: i * 1000,
    keys: [`meta:${i * 1000}`, `chunk:${i * 1000}:0`, `vchunk:${i * 1000}:0`],
  }));
  assert.deepEqual(pruneTargets(recs), ['meta:0', 'chunk:0:0', 'vchunk:0:0']);
});

test('pruneTargets tidak bergantung urutan masukan', () => {
  const recs = [{ recId: 1, keys: ['meta:1'] }, { recId: 9, keys: ['meta:9'] }];
  assert.deepEqual(pruneTargets(recs, 1), ['meta:1']);
});

test('pruneTargets: slot legacy terpangkas sebagai satu unit', () => {
  const legacy = { recId: 0, keys: ['meta', 'chunk:0', 'vchunk:0', 'blobs'] };
  const recs = [legacy, ...Array.from({ length: 5 },
    (_, i) => ({ recId: (i + 1) * 1000, keys: [`meta:${(i + 1) * 1000}`] }))];
  assert.deepEqual(pruneTargets(recs), ['meta', 'chunk:0', 'vchunk:0', 'blobs']);
});

test('pruneTargets: daftar kosong → kosong', () => {
  assert.deepEqual(pruneTargets([]), []);
});

test('prefix baru dikelompokkan ke daftarnya, bukan ke video', () => {
  const [r] = groupRecordings(['meta:5', 'schunk:5:0', 'mchunk:5:0', 'xpart:5:0', 'vchunk:5:0'],
    new Map([['meta:5', { baseTime: 5 }]]));
  assert.deepEqual(r.systemKeys.map((k) => k.key), ['schunk:5:0']);
  assert.deepEqual(r.micKeys.map((k) => k.key), ['mchunk:5:0']);
  assert.deepEqual(r.mixKeys.map((k) => k.key), ['xpart:5:0']);
  assert.deepEqual(r.videoKeys.map((k) => k.key), ['vchunk:5:0']);
  assert.deepEqual(r.chunkKeys, []);
});

test('prefix baru diurut numerik per indeks', () => {
  const [r] = groupRecordings(['meta:5', 'xpart:5:10', 'xpart:5:2', 'schunk:5:10', 'schunk:5:2'],
    new Map([['meta:5', { baseTime: 5 }]]));
  assert.deepEqual(r.mixKeys.map((k) => k.index), [2, 10]);
  assert.deepEqual(r.systemKeys.map((k) => k.index), [2, 10]);
});

test('pemangkasan ikut menghapus prefix baru', () => {
  const metas = new Map([1, 2, 3, 4, 5, 6].map((n) => [`meta:${n}`, { baseTime: n }]));
  const recs = groupRecordings([...metas.keys(), 'schunk:1:0', 'mchunk:1:0', 'xpart:1:0'], metas);
  assert.deepEqual(pruneTargets(recs).sort(), ['mchunk:1:0', 'meta:1', 'schunk:1:0', 'xpart:1:0']);
});

test('API rekaman desktop tersedia', () => {
  for (const name of ['appendSystemChunk', 'appendMicChunk', 'appendMixPart', 'loadSystem', 'loadMic', 'loadMix']) {
    assert.equal(typeof globalThis.MeetAudioStore[name], 'function', name);
  }
});

test('keysOfMeeting mengambil semua bagian rekaman milik meeting itu saja', () => {
  const metas = new Map([
    ['meta:1000', metaOf({ baseTime: 1000, meetingId: 'a' })],
    ['meta:2000', metaOf({ baseTime: 2000, meetingId: 'b' })],
    ['meta:3000', metaOf({ baseTime: 3000, meetingId: 'a' })],
  ]);
  const recs = groupRecordings(['meta:1000', 'chunk:1000:0', 'vchunk:1000:0', 'meta:2000', 'chunk:2000:0',
    'meta:3000', 'schunk:3000:0', 'mchunk:3000:0', 'xpart:3000:0'], metas);
  assert.deepEqual(keysOfMeeting(recs, 'a').sort(), ['chunk:1000:0', 'meta:1000', 'meta:3000',
    'mchunk:3000:0', 'schunk:3000:0', 'vchunk:1000:0', 'xpart:3000:0'].sort());
  assert.deepEqual(keysOfMeeting(recs, 'tidak-ada'), []);
});
