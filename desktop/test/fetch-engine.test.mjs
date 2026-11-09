import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { download } = require('../scripts/fetch-engine.js');

const BYTES = Buffer.from('engine');
const SHA = createHash('sha256').update(BYTES).digest('hex');
const FAST = { waitMs: 0 };

function serve(...replies) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(url);
    const reply = replies[Math.min(calls.length, replies.length) - 1];
    if (reply instanceof Error) throw reply;
    return new Response(reply === 200 ? BYTES : 'busy', { status: reply });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('a download that times out at first is tried again until it arrives', async (t) => {
  const server = serve(504, new TypeError('fetch failed'), 200);
  t.after(server.restore);
  assert.deepEqual(await download({ url: 'https://x/engine', sha256: SHA }, FAST), BYTES);
  assert.equal(server.calls.length, 3);
});

test('a download that keeps failing stops after the last try and names the address', async (t) => {
  const server = serve(503);
  t.after(server.restore);
  await assert.rejects(download({ url: 'https://x/engine', sha256: SHA }, { tries: 3, waitMs: 0 }), /https:\/\/x\/engine: HTTP 503/);
  assert.equal(server.calls.length, 3);
});

test('a missing file is not tried again', async (t) => {
  const server = serve(404);
  t.after(server.restore);
  await assert.rejects(download({ url: 'https://x/engine', sha256: SHA }, FAST), /HTTP 404/);
  assert.equal(server.calls.length, 1);
});

test('a file with the wrong checksum is not tried again', async (t) => {
  const server = serve(200);
  t.after(server.restore);
  await assert.rejects(download({ url: 'https://x/engine', sha256: 'f'.repeat(64) }, FAST), /expected SHA-256/);
  assert.equal(server.calls.length, 1);
});
