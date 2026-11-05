import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { isNewer, checkForUpdate, RELEASES_URL } = createRequire(import.meta.url)('../main/update.js');

const answer = (status, body = {}) => async () => ({ ok: status < 400, status, json: async () => body });

test('versi dibandingkan per angka', () => {
  assert.equal(isNewer('0.2.0', '0.1.0'), true);
  assert.equal(isNewer('v0.10.0', '0.9.0'), true);
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
  assert.equal(isNewer('0.1.0', '0.2.0'), false);
  assert.equal(isNewer('1.0', '1.0.1'), false);
  assert.equal(isNewer('nonsense', '1.0.0'), false);
});

test('rilis baru dilaporkan', async () => {
  const result = await checkForUpdate({ current: '0.1.0', fetch: answer(200, { tag_name: 'v0.2.0' }) });
  assert.deepEqual(result, { status: 'available', latest: '0.2.0' });
});

test('versi terbaru dilaporkan', async () => {
  const result = await checkForUpdate({ current: '0.2.0', fetch: answer(200, { tag_name: 'v0.2.0' }) });
  assert.deepEqual(result, { status: 'current', latest: '0.2.0' });
});

test('repo tanpa rilis tidak dianggap gagal', async () => {
  assert.deepEqual(await checkForUpdate({ current: '0.1.0', fetch: answer(404) }), { status: 'none' });
});

test('jawaban server lain menjadi error yang jelas', async () => {
  await assert.rejects(checkForUpdate({ current: '0.1.0', fetch: answer(500) }), /HTTP 500/);
});

test('halaman unduhan tetap dan milik repo ini', () => {
  assert.equal(RELEASES_URL, 'https://github.com/dimasekaadinandra25/meet-transcript/releases/latest');
});
