import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const { createStore } = createRequire(import.meta.url)('../main/store.js');

const cipher = {
  available: () => true,
  encrypt: (s) => Buffer.from(s).toString('base64'),
  decrypt: (s) => Buffer.from(s, 'base64').toString(),
};
const noCipher = { ...cipher, available: () => false };

let dir;
let store;
const readAll = () => readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tx-store-'));
  store = createStore({ dir, cipher });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('API key terenkripsi di disk dan terbaca polos', async () => {
  await store.set({ settings: { apiKey: 'sk-rahasia', sttApiKey: 'stt-rahasia', model: 'm' } });
  const disk = readAll();
  assert.ok(!disk.includes('sk-rahasia') && !disk.includes('stt-rahasia'));
  const { settings } = await store.get('settings');
  assert.equal(settings.apiKey, 'sk-rahasia');
  assert.equal(settings.sttApiKey, 'stt-rahasia');
  assert.equal(settings.model, 'm');
});

test('menolak menyimpan key bila enkripsi tidak tersedia', async () => {
  const plain = createStore({ dir, cipher: noCipher });
  await assert.rejects(plain.set({ settings: { apiKey: 'x' } }), /encryption/i);
  assert.equal(readAll().includes('"x"'), false);
});

test('settings tanpa key tetap tersimpan tanpa enkripsi', async () => {
  const plain = createStore({ dir, cipher: noCipher });
  await plain.set({ settings: { apiKey: '', model: 'm' } });
  assert.equal((await plain.get('settings')).settings.model, 'm');
});

test('key yang tidak bisa didekripsi menjadi kosong tanpa merusak settings', async () => {
  await store.set({ settings: { apiKey: 'sk', model: 'm' } });
  const broken = createStore({ dir, cipher: { ...cipher, decrypt: () => { throw new Error('x'); } } });
  const { settings } = await broken.get('settings');
  assert.equal(settings.apiKey, '');
  assert.equal(settings.model, 'm');
});

test('file rusak dipindahkan, bukan ditimpa', async () => {
  writeFileSync(join(dir, encodeURIComponent('meeting:a') + '.json'), '{rusak');
  assert.deepEqual(await store.get('meeting:a'), {});
  const names = readdirSync(dir);
  const kept = names.find((f) => f.includes('.corrupt-'));
  assert.ok(kept);
  assert.equal(readFileSync(join(dir, kept), 'utf8'), '{rusak');
});

test('key berisi titik dua dan get(null) bekerja', async () => {
  await store.set({ 'meeting:desktop-1': { id: 'desktop-1' }, meetings: ['desktop-1'] });
  assert.deepEqual(Object.keys(await store.get(null)).sort(), ['meeting:desktop-1', 'meetings']);
});

test('get menerima satu key, daftar key, dan key yang tidak ada', async () => {
  await store.set({ a: 1, b: 2 });
  assert.deepEqual(await store.get('a'), { a: 1 });
  assert.deepEqual(await store.get(['a', 'b', 'c']), { a: 1, b: 2 });
});

test('remove dan clear menghapus data', async () => {
  await store.set({ a: 1, b: 2, c: 3 });
  await store.remove('a');
  await store.remove(['b']);
  assert.deepEqual(await store.get(null), { c: 3 });
  await store.clear();
  assert.deepEqual(await store.get(null), {});
});

test('tidak ada file sementara setelah menulis', async () => {
  await store.set({ a: { n: 1 } });
  await store.set({ a: { n: 2 } });
  assert.equal(readdirSync(dir).length, 1);
  assert.deepEqual(await store.get('a'), { a: { n: 2 } });
});

test('penulisan bersamaan pada key sama berakhir dengan nilai terakhir', async () => {
  await Promise.all([store.set({ a: 1 }), store.set({ a: 2 }), store.set({ a: 3 })]);
  assert.deepEqual(await store.get('a'), { a: 3 });
  assert.equal(readdirSync(dir).length, 1);
});

test('onChange memuat nilai baru dan lama dengan key polos', async () => {
  const seen = [];
  const watched = createStore({ dir, cipher, onChange: (c) => seen.push(c) });
  await watched.set({ settings: { apiKey: 'sk' } });
  await watched.set({ settings: { apiKey: 'baru' } });
  assert.deepEqual(seen[0], { settings: { newValue: { apiKey: 'sk' }, oldValue: undefined } });
  assert.deepEqual(seen[1], { settings: { newValue: { apiKey: 'baru' }, oldValue: { apiKey: 'sk' } } });
});

test('a key that cannot be read for now survives other settings being saved', async () => {
  const good = createStore({ dir, cipher });
  await good.set({ settings: { apiKey: 'rahasia', model: 'a' } });
  const locked = createStore({ dir, cipher: { ...cipher, decrypt: () => { throw new Error('locked'); } } });
  const { settings } = await locked.get('settings');
  assert.equal(settings.apiKey, '');
  await locked.set({ settings: { ...settings, model: 'b' } });
  const { settings: after } = await createStore({ dir, cipher }).get('settings');
  assert.equal(after.apiKey, 'rahasia');
  assert.equal(after.model, 'b');
});

test('a new key replaces one that could not be read', async () => {
  const good = createStore({ dir, cipher });
  await good.set({ settings: { apiKey: 'lama' } });
  const locked = createStore({ dir, cipher: { ...cipher, decrypt: () => { throw new Error('locked'); } } });
  await locked.get('settings');
  await locked.set({ settings: { apiKey: 'baru' } });
  assert.equal((await createStore({ dir, cipher }).get('settings')).settings.apiKey, 'baru');
});

test('sharing secrets are encrypted like API keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tx-store-'));
  const cipher = { available: () => true, encrypt: (t) => `enc:${t}`, decrypt: (t) => t.slice(4) };
  const store = createStore({ dir, cipher });
  await store.set({ settings: { slackWebhook: 'https://hooks.slack.com/services/A', notionToken: 'n' } });
  const raw = readdirSync(dir).map((name) => readFileSync(join(dir, name), 'utf8')).join('');
  assert.doesNotMatch(raw, /"slackWebhook":"https/);
  const { settings } = await store.get('settings');
  assert.equal(settings.notionToken, 'n');
  rmSync(dir, { recursive: true, force: true });
});

test('a key that cannot be read is dropped when its server changes', async () => {
  const good = createStore({ dir, cipher });
  await good.set({ settings: { apiKey: 'rahasia', baseUrl: 'https://mine.example/v1', sttApiKey: 'suara', sttBaseUrl: 'https://speech.example/v1', notionToken: 'ntn' } });
  const locked = createStore({ dir, cipher: { ...cipher, decrypt: () => { throw new Error('locked'); } } });
  const { settings } = await locked.get('settings');
  await locked.set({ settings: { ...settings, baseUrl: 'https://other.example/v1', sttBaseUrl: 'http://speech.example/v1' } });
  const { settings: after } = await createStore({ dir, cipher }).get('settings');
  assert.ok(!after.apiKey, 'the key went to another server');
  assert.ok(!after.sttApiKey, 'the speech key went to an http address');
  assert.equal(after.notionToken, 'ntn');
});
