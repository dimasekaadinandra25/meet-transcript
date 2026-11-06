import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
await import('../../lib/stt.js');
await import('../../lib/merge.js');
require('../renderer/tracks.js');
const { mergeTracks, replaceBlocker } = globalThis.MeetTracks;

const text = (t) => ({ segments: [{ start: 0, text: t }] });

test('memberi label dan mengurutkan menurut waktu', () => {
  const segs = mergeTracks({ chunkMs: 600000, baseTime: 1000,
    system: { results: [{ segments: [{ start: 2, text: 'halo' }] }], indices: [0] },
    mic: { results: [{ segments: [{ start: 1, text: 'hai' }] }], indices: [0] } });
  assert.deepEqual(segs.map((s) => [s.speaker, s.text, s.t]), [['You', 'hai', 2000], ['Others', 'halo', 3000]]);
});

test('indeks asli menjaga waktu potongan yang bolong', () => {
  const segs = mergeTracks({ chunkMs: 600000, baseTime: 0,
    system: { results: [text('a')], indices: [2] }, mic: { results: [], indices: [] } });
  assert.equal(segs[0].t, 1200000);
});

test('potongan gagal tetap ditandai dengan label tracknya', () => {
  const segs = mergeTracks({ chunkMs: 1000, baseTime: 0,
    system: { results: [{ error: 'x' }], indices: [0] }, mic: { results: [], indices: [] } });
  assert.deepEqual(segs.map((s) => [s.speaker, s.text]), [['Others', '[transcript failed]']]);
});

test('track tanpa potongan tidak menghasilkan baris', () => {
  const segs = mergeTracks({ chunkMs: 1000, baseTime: 0,
    system: { results: [text('a')], indices: [0] }, mic: { results: [], indices: [] } });
  assert.deepEqual(segs.map((s) => s.speaker), ['Others']);
});

test('mikrofon sukses tapi audio komputer gagal total diblokir', () => {
  assert.match(replaceBlocker({ system: { results: [{ error: 'HTTP 500' }] }, mic: { results: [text('a')] } }), /HTTP 500/);
});

test('audio komputer sukses tapi mikrofon gagal total diblokir', () => {
  assert.match(replaceBlocker({ system: { results: [text('a')] }, mic: { results: [{ error: 'HTTP 502' }] } }), /HTTP 502/);
});

test('mikrofon sunyi tanpa error tidak memblokir', () => {
  assert.equal(replaceBlocker({ system: { results: [text('a')] }, mic: { results: [{ segments: [] }] } }), null);
});

test('tanpa teks sama sekali diblokir', () => {
  const none = { results: [{ segments: [] }] };
  assert.match(replaceBlocker({ system: none, mic: none }), /returned no text/);
});

test('sebagian potongan gagal tidak memblokir bila track itu masih punya teks', () => {
  const part = { results: [{ error: 'x' }, text('a')] };
  assert.equal(replaceBlocker({ system: part, mic: { results: [] } }), null);
});

test('rekaman tanpa track mikrofon tidak diblokir', () => {
  assert.equal(replaceBlocker({ system: { results: [text('a')] }, mic: { results: [] } }), null);
});

test('speakers from the service replace Others, while the microphone stays You', () => {
  const segs = mergeTracks({ chunkMs: 1000, baseTime: 0,
    system: { results: [{ segments: [{ start: 0, text: 'a', speaker: 'A' }, { start: 0.1, text: 'b' }] }], indices: [0] },
    mic: { results: [{ segments: [{ start: 0.2, text: 'c', speaker: 'B' }] }], indices: [0] } });
  assert.deepEqual(segs.map((s) => s.speaker), ['Speaker A', 'Others', 'You']);
});
