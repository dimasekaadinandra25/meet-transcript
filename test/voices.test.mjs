import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../lib/stt.js');
await import('../lib/openai.js');
const { createVoiceMemory, sendWithVoices, isDiarizeModel, parseSttResponse, namesCanMove } = globalThis.MeetStt;

const line = (speaker, start, end, text = 'halo') => ({ speaker, start, end, text });
const clips = () => {
  const made = [];
  return { made, makeClip: async (from, to) => { made.push([from, to]); return `clip-${from}`; } };
};

test('the service end time survives parsing, because voice clips need it', () => {
  const { segments } = parseSttResponse({ segments: [{ start: 1, end: 4, text: 'halo', speaker: 'A' }] });
  assert.equal(segments[0].end, 4);
});

test('only diarize models use voice memory', () => {
  assert.equal(isDiarizeModel('gpt-4o-transcribe-diarize'), true);
  assert.equal(isDiarizeModel('whisper-1'), false);
  assert.equal(isDiarizeModel(undefined), false);
});

test('the first part names speakers and remembers a clip of each', async () => {
  const voices = createVoiceMemory();
  const { made, makeClip } = clips();
  const result = await voices.learn({ segments: [line('A', 0, 3), line('B', 3, 20), line('A', 20, 21)] }, makeClip);
  assert.deepEqual(result.segments.map((s) => s.speaker), ['A', 'B', 'A']);
  assert.deepEqual(made, [[0, 3], [3, 9]]);
  assert.deepEqual(voices.references(), [{ name: 'Voice A', clip: 'clip-0' }, { name: 'Voice B', clip: 'clip-3' }]);
});

test('a later part keeps the same letter for a known voice', async () => {
  const voices = createVoiceMemory();
  const { makeClip } = clips();
  await voices.learn({ segments: [line('A', 0, 3), line('B', 3, 6)] }, makeClip);
  const later = await voices.learn({ segments: [line('Voice B', 0, 3), line('Voice A', 3, 6)] }, makeClip);
  assert.deepEqual(later.segments.map((s) => s.speaker), ['B', 'A']);
  assert.equal(voices.references().length, 2);
});

test('a new person in a later part does not take a known letter', async () => {
  const voices = createVoiceMemory();
  const { makeClip } = clips();
  await voices.learn({ segments: [line('A', 0, 3)] }, makeClip);
  const later = await voices.learn({ segments: [line('Voice A', 0, 3), line('A', 3, 6)] }, makeClip);
  assert.deepEqual(later.segments.map((s) => s.speaker), ['A', 'B']);
  assert.deepEqual(voices.references().map((r) => r.name), ['Voice A', 'Voice B']);
});

test('a voice heard too briefly has no clip yet, and is learned when long enough', async () => {
  const voices = createVoiceMemory();
  const { made, makeClip } = clips();
  await voices.learn({ segments: [line('A', 0, 1)] }, makeClip);
  assert.deepEqual(made, []);
  assert.deepEqual(voices.references(), []);
});

test('at most 4 voices are sent, and a fifth person still gets their own letter', async () => {
  const voices = createVoiceMemory();
  const { makeClip } = clips();
  const result = await voices.learn({ segments: ['A', 'B', 'C', 'D', 'E'].map((who, i) => line(who, i * 3, i * 3 + 3)) }, makeClip);
  assert.equal(voices.references().length, 4);
  assert.deepEqual(result.segments.map((s) => s.speaker), ['A', 'B', 'C', 'D', 'E']);
});

test('a clip that cannot be made does not lose the transcript', async () => {
  const voices = createVoiceMemory();
  const result = await voices.learn({ segments: [line('A', 0, 3)] }, async () => { throw new Error('no audio'); });
  assert.equal(result.segments[0].speaker, 'A');
  assert.deepEqual(voices.references(), []);
});

test('lines with no speaker stay that way', async () => {
  const voices = createVoiceMemory();
  const { makeClip } = clips();
  const result = await voices.learn({ segments: [line(undefined, 0, 3)] }, makeClip);
  assert.equal(result.segments[0].speaker, undefined);
});

test('if the service rejects the voice clips, the part is sent again without them', async () => {
  const voices = createVoiceMemory();
  const { makeClip } = clips();
  await voices.learn({ segments: [line('A', 0, 3)] }, makeClip);
  const sent = [];
  const send = async (known) => {
    sent.push(known.length);
    if (known.length) throw Object.assign(new Error('HTTP 400'), { name: 'RequestRejected' });
    return { segments: [line('A', 0, 3)] };
  };
  const result = await sendWithVoices({ send, blob: {}, voices, makeClip: async () => 'clip' });
  assert.deepEqual(sent, [1, 0]);
  assert.equal(result.segments[0].speaker, 'B');
});

test('a timeout or dead server is not sent a second time', async () => {
  const voices = createVoiceMemory();
  const { makeClip } = clips();
  await voices.learn({ segments: [line('A', 0, 3)] }, makeClip);
  let sent = 0;
  const send = async () => {
    sent++;
    throw new Error('Request timed out');
  };
  await assert.rejects(sendWithVoices({ send, blob: {}, voices, makeClip: async () => 'clip' }), /timed out/);
  assert.equal(sent, 1);
});

test('only a bad request counts as the service rejecting it', async () => {
  const real = globalThis.fetch;
  const failWith = async (status) => {
    globalThis.fetch = async () => new Response('{"error":{"message":"no"}}', { status });
    return globalThis.MeetOpenAI.transcribeAudio({ blob: new Blob(['x']), baseUrl: 'http://127.0.0.1:1/v1', model: 'm' }).catch((e) => e);
  };
  try {
    assert.equal((await failWith(400)).name, 'RequestRejected');
    assert.equal((await failWith(422)).name, 'RequestRejected');
    assert.equal((await failWith(401)).name, 'Error');
    assert.equal((await failWith(500)).name, 'Error');
  } finally {
    globalThis.fetch = real;
  }
});

test('renamed speakers can move only when a diarize model retranscribes', () => {
  assert.equal(namesCanMove({ speakerNames: { 'Speaker A': 'Ani' } }, 'gpt-4o-transcribe-diarize'), true);
  assert.equal(namesCanMove({ speakerNames: {} }, 'gpt-4o-transcribe-diarize'), false);
  assert.equal(namesCanMove({}, 'gpt-4o-transcribe-diarize'), false);
  assert.equal(namesCanMove({ speakerNames: { Others: 'Ani' } }, 'whisper-1'), false);
});

test('a failure with nothing to retry is reported', async () => {
  const voices = createVoiceMemory();
  await assert.rejects(sendWithVoices({ send: async () => { throw new Error('HTTP 500'); }, blob: {}, voices, makeClip: async () => 'clip' }), /500/);
});

test('an error answer from the service is passed through unchanged', async () => {
  const voices = createVoiceMemory();
  const result = await sendWithVoices({ send: async () => ({ error: 'gagal' }), blob: {}, voices, makeClip: async () => 'clip' });
  assert.deepEqual(result, { error: 'gagal' });
});

test('voice clips go in the documented form fields, only for diarize models', async () => {
  const real = globalThis.fetch;
  const forms = [];
  globalThis.fetch = async (_url, init) => {
    forms.push(init.body);
    return new Response('{"segments":[]}', { status: 200 });
  };
  try {
    const knownSpeakers = [{ name: 'Voice A', clip: 'data:audio/wav;base64,AAAA' }];
    const args = { blob: new Blob(['x']), baseUrl: 'http://127.0.0.1:1/v1', knownSpeakers };
    await globalThis.MeetOpenAI.transcribeAudio({ ...args, model: 'gpt-4o-transcribe-diarize' });
    assert.deepEqual(forms[0].getAll('known_speaker_names[]'), ['Voice A']);
    assert.deepEqual(forms[0].getAll('known_speaker_references[]'), ['data:audio/wav;base64,AAAA']);
    await globalThis.MeetOpenAI.transcribeAudio({ ...args, model: 'whisper-1' });
    assert.deepEqual(forms[1].getAll('known_speaker_names[]'), []);
  } finally {
    globalThis.fetch = real;
  }
});
