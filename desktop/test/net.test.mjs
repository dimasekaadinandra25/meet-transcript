import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { netCall, probe, callStt, loadLib } = require('../main/net.js');

let server;
let base;
const seen = [];

before(async () => {
  loadLib(new URL('../..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
  server = createServer((req, res) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: Buffer.concat(parts).toString('latin1') });
      if (req.url.endsWith('/models')) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: 'hasil' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/v1`;
});
after(() => server.close());

test('pesan error tiba utuh tanpa awalan IPC', async () => {
  const r = await netCall(async () => { throw new Error('HTTP 404 (STT endpoint or model not found?)'); });
  assert.deepEqual(r, { ok: false, name: 'Error', error: 'HTTP 404 (STT endpoint or model not found?)' });
});

test('nama TimeoutError dipertahankan', async () => {
  const e = Object.assign(new Error('x'), { name: 'TimeoutError' });
  assert.equal((await netCall(async () => { throw e; })).name, 'TimeoutError');
});

test('hasil sukses dibungkus', async () => {
  assert.deepEqual(await netCall(async () => 5), { ok: true, value: 5 });
});

test('probe menolak skema selain http dan https', async () => {
  assert.equal((await probe('file:///etc/passwd', '')).ok, false);
});

test('probe mengembalikan status dan mengirim key', async () => {
  const r = await probe(`${base}/models`, 'kunci');
  assert.deepEqual(r, { ok: true, value: { ok: false, status: 404 } });
  assert.equal(seen.at(-1).auth, 'Bearer kunci');
});

test('callStt mengirim audio dari ArrayBuffer sebagai file', async () => {
  const bytes = new TextEncoder().encode('AUDIO-UJI').buffer;
  const r = await callStt({ bytes, baseUrl: base, apiKey: '', model: 'm', language: 'id' });
  assert.deepEqual(r, { ok: true, value: { segments: [{ start: 0, text: 'hasil' }] } });
  assert.ok(seen.at(-1).url.endsWith('/audio/transcriptions'));
  assert.ok(seen.at(-1).body.includes('AUDIO-UJI'));
  assert.equal(seen.at(-1).auth, undefined);
});

test('callStt menolak skema selain http dan https', async () => {
  const r = await callStt({ bytes: new ArrayBuffer(1), baseUrl: 'file:///x', model: 'm' });
  assert.equal(r.ok, false);
});

test('built-in STT goes to the address of the running engine', async () => {
  const res = await callStt({ bytes: new TextEncoder().encode('x'), baseUrl: globalThis.MeetStt.BUILTIN_URL, model: 'm', fileName: 'audio.wav' }, async () => base);
  assert.equal(res.ok, true);
  assert.match(seen.at(-1).body, /filename="audio\.wav"/);
});

test('an engine that cannot start becomes a failed result', async () => {
  const res = await callStt({ bytes: new Uint8Array(1), baseUrl: globalThis.MeetStt.BUILTIN_URL, model: 'm' }, async () => { throw new Error('not installed'); });
  assert.deepEqual([res.ok, res.error], [false, 'not installed']);
});

test('bridge renderer melempar ulang error dengan nama dan pesan asli', async () => {
  globalThis.window = {
    desktop: { net: {
      chat: async () => ({ ok: false, name: 'TimeoutError', error: 'server diam' }),
      test: async () => ({ ok: true, value: true }),
      stt: async (args) => ({ ok: true, value: { size: args.bytes.byteLength, model: args.model, hasBlob: 'blob' in args } }),
      probe: async (url, key) => ({ ok: true, value: { ok: true, status: 200, url, key } }),
    } },
  };
  globalThis.MeetOpenAI = { DEFAULT_MODEL: 'tetap' };
  require('../renderer/openai-bridge.js');
  await assert.rejects(globalThis.MeetOpenAI.generateMoM({}), (e) => e.name === 'TimeoutError' && e.message === 'server diam');
  assert.equal(await globalThis.MeetOpenAI.testConnection({}), true);
  assert.equal(globalThis.MeetOpenAI.DEFAULT_MODEL, 'tetap');
  const stt = await globalThis.MeetOpenAI.transcribeAudio({ blob: new Blob(['abc']), model: 'm' });
  assert.deepEqual(stt, { size: 3, model: 'm', hasBlob: false });
  const res = await globalThis.bridgeFetch('http://x/models', { headers: { Authorization: 'Bearer kk' } });
  assert.equal(res.status, 200);
  assert.equal(res.key, 'kk');
});

test('bridge converts audio to WAV only for the built-in engine', async () => {
  const sent = [];
  globalThis.window.desktop.net.stt = async (args) => {
    sent.push(args);
    return { ok: true, value: {} };
  };
  globalThis.MeetWav = { speechWav: async () => new Blob(['wave']) };
  const { BUILTIN_URL } = globalThis.MeetStt;
  delete require.cache[require.resolve('../renderer/openai-bridge.js')];
  require('../renderer/openai-bridge.js');
  await globalThis.MeetOpenAI.transcribeAudio({ blob: new Blob(['webm-bytes']), baseUrl: BUILTIN_URL, model: 'm' });
  await globalThis.MeetOpenAI.transcribeAudio({ blob: new Blob(['webm-bytes']), baseUrl: 'http://stt/v1', model: 'm' });
  assert.deepEqual(sent.map((args) => [args.fileName, args.bytes.byteLength]), [['audio.wav', 4], [undefined, 10]]);
});
