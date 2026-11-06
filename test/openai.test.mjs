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

test('OpenAI transcribe models that only allow json get json', async () => {
  for (const model of ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'gpt-4o-mini-transcribe-2025-12-15', 'gpt-transcribe']) {
    const form = await sentForm(model);
    assert.equal(form.get('response_format'), 'json', model);
  }
});

test('gpt-transcribe gets languages instead of language', async () => {
  const real = globalThis.fetch;
  const forms = [];
  globalThis.fetch = async (_url, init) => {
    forms.push(init.body);
    return new Response('{"text":"halo"}', { status: 200 });
  };
  try {
    const args = { blob: new Blob(['x']), baseUrl: 'http://127.0.0.1:1/v1', language: 'id' };
    const result = await globalThis.MeetOpenAI.transcribeAudio({ ...args, model: 'gpt-transcribe' });
    assert.deepEqual(forms[0].getAll('languages[]'), ['id']);
    assert.equal(forms[0].get('language'), null);
    assert.equal(result.segments[0].text, 'halo');
    await globalThis.MeetOpenAI.transcribeAudio({ ...args, model: 'gpt-4o-transcribe' });
    assert.equal(forms[1].get('language'), 'id');
    assert.deepEqual(forms[1].getAll('languages[]'), []);
  } finally {
    globalThis.fetch = real;
  }
});

test('a streamed reply is asked for only when requested', async () => {
  const real = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response('data: {"choices":[{"delta":{"content":"ha"}}]}\ndata: {"choices":[{"delta":{"content":"lo"}}]}\ndata: [DONE]\n', { status: 200 });
  };
  try {
    const args = { apiKey: 'k', model: 'm', prompt: 'p', baseUrl: 'http://127.0.0.1:1/v1' };
    assert.equal(await globalThis.MeetOpenAI.generateMoM({ ...args, stream: true }), 'halo');
    assert.equal(bodies[0].stream, true);
    await globalThis.MeetOpenAI.generateMoM(args);
    assert.equal(bodies[1].stream, false);
  } finally {
    globalThis.fetch = real;
  }
});

test('a streamed reply that reports an error fails with that error', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"ha"}}]}\ndata: {"error":{"message":"provider overloaded"}}\n', { status: 200 });
  try {
    await assert.rejects(globalThis.MeetOpenAI.generateMoM({ apiKey: 'k', model: 'm', prompt: 'p', baseUrl: 'http://127.0.0.1:1/v1', stream: true }), /provider overloaded/);
  } finally {
    globalThis.fetch = real;
  }
});

test('a streamed reply that stops early is not treated as finished', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"ha"}}]}\n', { status: 200 });
  try {
    await assert.rejects(globalThis.MeetOpenAI.generateMoM({ apiKey: 'k', model: 'm', prompt: 'p', baseUrl: 'http://127.0.0.1:1/v1', stream: true }), /stopped before it finished/);
  } finally {
    globalThis.fetch = real;
  }
});

test('a stream ending with a finish reason counts as finished', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"halo"},"finish_reason":"stop"}]}\n', { status: 200 });
  try {
    assert.equal(await globalThis.MeetOpenAI.generateMoM({ apiKey: 'k', model: 'm', prompt: 'p', baseUrl: 'http://127.0.0.1:1/v1', stream: true }), 'halo');
  } finally {
    globalThis.fetch = real;
  }
});

test('a server that ignores streaming still works', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"choices":[{"message":{"content":"halo"}}]}', { status: 200 });
  try {
    assert.equal(await globalThis.MeetOpenAI.generateMoM({ apiKey: 'k', model: 'm', prompt: 'p', baseUrl: 'http://127.0.0.1:1/v1', stream: true }), 'halo');
  } finally {
    globalThis.fetch = real;
  }
});

test('custom vocabulary goes to the speech service as a prompt', async () => {
  const real = globalThis.fetch;
  const forms = [];
  globalThis.fetch = async (_url, init) => {
    forms.push(init.body);
    return new Response('{"segments":[]}', { status: 200 });
  };
  try {
    const args = { blob: new Blob(['x']), baseUrl: 'http://127.0.0.1:1/v1', prompt: 'Dimas, Transcripables' };
    await globalThis.MeetOpenAI.transcribeAudio({ ...args, model: 'whisper-1' });
    assert.equal(forms[0].get('prompt'), 'Dimas, Transcripables');
    await globalThis.MeetOpenAI.transcribeAudio({ ...args, model: 'gpt-4o-transcribe-diarize' });
    assert.equal(forms[1].get('prompt'), null);
    await globalThis.MeetOpenAI.transcribeAudio({ blob: args.blob, baseUrl: args.baseUrl, model: 'whisper-1' });
    assert.equal(forms[2].get('prompt'), null);
  } finally {
    globalThis.fetch = real;
  }
});

test('a service that rejects the vocabulary still gets the audio', async () => {
  const real = globalThis.fetch;
  const forms = [];
  globalThis.fetch = async (_url, init) => {
    forms.push(init.body);
    if (forms.length === 1) return new Response('{"error":{"message":"unknown field prompt"}}', { status: 422 });
    return new Response('{"text":"halo"}', { status: 200 });
  };
  try {
    const result = await globalThis.MeetOpenAI.transcribeAudio({ blob: new Blob(['x']), baseUrl: 'http://127.0.0.1:1/v1', model: 'm', prompt: 'Dimas' });
    assert.equal(forms.length, 2);
    assert.equal(forms[1].get('prompt'), null);
    assert.equal(result.segments[0].text, 'halo');
  } finally {
    globalThis.fetch = real;
  }
});
