import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { createSpeakers, parseTurns } = require('../main/speakers.js');

const OUTPUT = 'Started\n0.318 -- 6.865 speaker_00\nnot a turn\n7.017 -- 10.747 speaker_01\n';

test('reads each turn and ignores other lines', () => {
  assert.deepEqual(parseTurns(OUTPUT), [{ start: 0.318, end: 6.865, speaker: 0 }, { start: 7.017, end: 10.747, speaker: 1 }]);
});

test('runs the program on the audio with both models, then removes the audio', async () => {
  const calls = [];
  const dir = resolve('engine-test', 'speakers');
  const speakers = createSpeakers({ dir, platform: 'win32', exists: () => true, run: async (file, args, options) => {
    const audio = resolve(options.cwd, args.at(-1));
    calls.push({ file, args, options, audio, bytes: [...readFileSync(audio)] });
    return { stdout: OUTPUT };
  } });
  const turns = await speakers.find(new Uint8Array([1, 2, 3]).buffer);
  assert.equal(turns.length, 2);
  const [call] = calls;
  assert.equal(call.file, join(dir, 'bin', 'sherpa-onnx-offline-speaker-diarization.exe'));
  assert.equal(call.options.cwd, dir);
  assert.ok(call.args.includes('--segmentation.pyannote-model=segmentation.onnx'));
  assert.ok(call.args.includes('--embedding.model=embedding.onnx'));
  assert.ok(call.args.some((a) => a.startsWith('--clustering.cluster-threshold=')));
  assert.ok(!isAbsolute(call.args.at(-1)));
  assert.deepEqual(call.bytes, [1, 2, 3]);
  assert.ok(!existsSync(call.audio));
});

test('a failed run is reported and still removes the audio', async () => {
  let audio;
  const speakers = createSpeakers({ dir: resolve('x'), platform: 'darwin', exists: () => true, run: async (file, args, options) => {
    audio = resolve(options.cwd, args.at(-1));
    assert.equal(file, join(resolve('x'), 'bin', 'sherpa-onnx-offline-speaker-diarization'));
    throw new Error('crashed');
  } });
  await assert.rejects(speakers.find(new ArrayBuffer(4)), /crashed/);
  assert.ok(!existsSync(audio));
});

test('needs the program and both models', () => {
  const have = new Set();
  const speakers = createSpeakers({ dir: 'd', platform: 'win32', exists: (path) => have.has(path) });
  assert.equal(speakers.available(), false);
  have.add(join('d', 'bin', 'sherpa-onnx-offline-speaker-diarization.exe')).add(join('d', 'segmentation.onnx'));
  assert.equal(speakers.available(), false);
  have.add(join('d', 'embedding.onnx'));
  assert.equal(speakers.available(), true);
});
