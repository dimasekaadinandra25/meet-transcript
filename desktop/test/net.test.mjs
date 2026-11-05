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
  const r = await netCall(async () => { throw new Error('HTTP 404 (endpoint/model STT tidak ditemukan?)'); });
  assert.deepEqual(r, { ok: false, name: 'Error', error: 'HTTP 404 (endpoint/model STT tidak ditemukan?)' });
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
