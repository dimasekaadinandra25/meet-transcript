import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../renderer/wav.js');
const { encodeWav, mono } = globalThis.MeetWav;

const text = (view, at, length) => String.fromCharCode(...new Uint8Array(view.buffer, at, length));

test('encodeWav writes a 16-bit mono header', () => {
  const view = new DataView(encodeWav(new Float32Array(3), 16000));
  assert.equal(view.byteLength, 50);
  assert.equal(text(view, 0, 4), 'RIFF');
  assert.equal(view.getUint32(4, true), 42);
  assert.equal(text(view, 8, 8), 'WAVEfmt ');
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(28, true), 32000);
  assert.equal(view.getUint16(32, true), 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(text(view, 36, 4), 'data');
  assert.equal(view.getUint32(40, true), 6);
});

test('encodeWav limits loud samples instead of wrapping them', () => {
  const view = new DataView(encodeWav(Float32Array.of(2, -2, 0.5), 16000));
  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32767);
  assert.equal(view.getInt16(48, true), 16384);
});

test('mono averages every channel', () => {
  const audio = { numberOfChannels: 2, length: 2, getChannelData: (i) => (i === 0 ? Float32Array.of(1, 0) : Float32Array.of(0, 0.5)) };
  assert.deepEqual([...mono(audio)], [0.5, 0.25]);
});

test('splitSamples cuts long audio into equal parts', () => {
  const { splitSamples } = globalThis.MeetWav;
  const parts = splitSamples(new Float32Array(25), 2, 5);
  assert.deepEqual(parts.map((p) => p.length), [10, 10, 5]);
});

test('splitSamples drops a last part shorter than a second', () => {
  const { splitSamples } = globalThis.MeetWav;
  assert.deepEqual(splitSamples(new Float32Array(21), 2, 5).map((p) => p.length), [10, 10]);
  assert.deepEqual(splitSamples(new Float32Array(1), 2, 5), []);
});
