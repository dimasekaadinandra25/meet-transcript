import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../lib/openai.js');
const { extractContent, errorFromBody, generateMoM } = globalThis.MeetOpenAI;

test('JSON tunggal biasa', () => {
  const raw = JSON.stringify({ choices: [{ message: { content: 'halo' } }] });
  assert.equal(extractContent(raw), 'halo');
});

test('JSON diikuti terminator SSE "data: [DONE]" (format sebagian proxy)', () => {
  const raw = JSON.stringify({ choices: [{ message: { content: 'halo' } }] }) + 'data: [DONE]';
  assert.equal(extractContent(raw), 'halo');
});

test('JSON + "\\ndata: [DONE]" dengan whitespace', () => {
  const raw = JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) + '\n\ndata: [DONE]\n';
  assert.equal(extractContent(raw), 'ok');
});

test('SSE stream: gabungkan delta antar baris', () => {
  const raw = [
    'data: ' + JSON.stringify({ choices: [{ delta: { content: 'ha' } }] }),
    'data: ' + JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
    'data: [DONE]',
  ].join('\n');
  assert.equal(extractContent(raw), 'halo');
});

test('SSE dengan baris tak lengkap dilewati, tidak throw', () => {
  const raw = [
    'data: ' + JSON.stringify({ choices: [{ delta: { content: 'a' } }] }),
    'data: {rusak',
    'data: ' + JSON.stringify({ choices: [{ delta: { content: 'b' } }] }),
    'data: [DONE]',
  ].join('\n');
  assert.equal(extractContent(raw), 'ab');
});

test('errorFromBody mengambil pesan error dari body 200', () => {
  assert.equal(errorFromBody('{"error":{"message":"model tidak ada"}}'), 'model tidak ada');
  assert.equal(errorFromBody('{"error":"kuota habis"}'), 'kuota habis');
  assert.equal(errorFromBody('{"choices":[]}'), null);
  assert.equal(errorFromBody('bukan json'), null);
  assert.equal(errorFromBody(''), null);
});

async function denganFetch(balasan, fn) {
  const asli = globalThis.fetch;
  globalThis.fetch = async () => balasan();
  try { return await fn(); } finally { globalThis.fetch = asli; }
}

test('chat: body error di HTTP 200 melaporkan pesan server, bukan "Respons kosong"', async () => {
  await denganFetch(
    () => new Response('{"error":{"message":"model tidak ada"}}', { status: 200 }),
    () => assert.rejects(
      () => generateMoM({ apiKey: 'k', model: 'm', prompt: 'p', baseUrl: 'https://x.test/v1' }),
      /model tidak ada/));
});

test('chat: body 200 tanpa content dan tanpa error tetap "Respons kosong"', async () => {
  await denganFetch(
    () => new Response('{"choices":[]}', { status: 200 }),
    () => assert.rejects(
      () => generateMoM({ apiKey: 'k', model: 'm', prompt: 'p', baseUrl: 'https://x.test/v1' }),
      /Empty response/));
});

async function sentForm(model) {
  await import('../lib/stt.js');
  const realFetch = globalThis.fetch;
  let form;
  globalThis.fetch = async (_url, init) => {
    form = init.body;
    return new Response('{"segments":[]}', { status: 200 });
  };
  try {
    await globalThis.MeetOpenAI.transcribeAudio({ blob: new Blob(['x']), baseUrl: 'https://stt.example/v1', apiKey: 'k', model, language: 'id' });
  } finally {
    globalThis.fetch = realFetch;
  }
  return form;
}

test('a diarize model asks for speaker labels', async () => {
  const form = await sentForm('gpt-4o-transcribe-diarize');
  assert.equal(form.get('response_format'), 'diarized_json');
  assert.equal(form.get('chunking_strategy'), 'auto');
});

test('other models keep verbose_json', async () => {
  const form = await sentForm('whisper-1');
  assert.equal(form.get('response_format'), 'verbose_json');
  assert.equal(form.get('chunking_strategy'), null);
});

test('the uploaded file keeps the name it is given', async () => {
  const realFetch = globalThis.fetch;
  let form;
  globalThis.fetch = async (_url, init) => {
    form = init.body;
    return new Response('{"segments":[]}', { status: 200 });
  };
  try {
    await globalThis.MeetOpenAI.transcribeAudio({ blob: new Blob(['x']), fileName: 'audio.wav', baseUrl: 'http://127.0.0.1:1/v1', model: 'm' });
    assert.equal(form.get('file').name, 'audio.wav');
    await globalThis.MeetOpenAI.transcribeAudio({ blob: new Blob(['x']), baseUrl: 'http://127.0.0.1:1/v1', model: 'm' });
    assert.equal(form.get('file').name, 'audio.webm');
    await globalThis.MeetOpenAI.transcribeAudio({ blob: new Blob(['x'], { type: 'audio/wav' }), baseUrl: 'http://127.0.0.1:1/v1', model: 'm' });
    assert.equal(form.get('file').name, 'audio.wav');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('no key means no Authorization header', async () => {
  const realFetch = globalThis.fetch;
  const headers = [];
  globalThis.fetch = async (_url, init) => {
    headers.push(init.headers);
    return new Response('{"choices":[{"message":{"content":"ok"}}]}', { status: 200 });
  };
  try {
    await generateMoM({ apiKey: '', model: 'm', prompt: 'p', baseUrl: 'http://localhost:11434/v1' });
    await generateMoM({ apiKey: 'k', model: 'm', prompt: 'p', baseUrl: 'https://x.test/v1' });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(headers[0].Authorization, undefined);
  assert.equal(headers[1].Authorization, 'Bearer k');
});

test('streamed replies with Windows line endings are read', () => {
  const raw = 'data: {"choices":[{"delta":{"content":"hel"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"lo"}}]}\r\n\r\ndata: [DONE]\r\n';
  assert.equal(extractContent(raw), 'hello');
});

test('a reply made of text parts becomes plain text', () => {
  const raw = JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: 'hel' }, { type: 'text', text: 'lo' }] } }] });
  assert.equal(extractContent(raw), 'hello');
});

test('a reply with no usable text counts as empty', () => {
  assert.equal(extractContent(JSON.stringify({ choices: [{ message: { content: { odd: true } } }] })), '');
});

test('AI service presets have an address and a model where one is known', () => {
  const { LLM_PRESETS, DEFAULT_BASE_URL } = globalThis.MeetOpenAI;
  assert.ok(LLM_PRESETS.some((p) => p.baseUrl === DEFAULT_BASE_URL));
  for (const preset of LLM_PRESETS) {
    assert.ok(preset.name && /^https?:\/\//.test(preset.baseUrl), preset.name);
    assert.ok(!preset.baseUrl.endsWith('/'), preset.name);
  }
  assert.ok(LLM_PRESETS.some((p) => p.baseUrl.includes('localhost')));
});
