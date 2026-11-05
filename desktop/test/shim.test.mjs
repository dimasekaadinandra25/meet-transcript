import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

createRequire(import.meta.url)('../renderer/chrome-shim.js');
const { createChromeShim } = globalThis;

let changed;
let store;
let handled;
let chrome;
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  changed = null;
  handled = [];
  store = {
    get: async (keys) => ({ keys }),
    set: async (values) => { store.saved = values; },
    remove: async (keys) => { store.removed = keys; },
    clear: async () => { store.cleared = true; },
    onChanged: (listener) => { changed = listener; },
  };
  chrome = createChromeShim({ store, handle: async (msg) => { handled.push(msg); return { id: null }; } });
});

test('sendMessage meneruskan balasan controller', async () => {
  assert.deepEqual(await chrome.runtime.sendMessage({ type: 'get-active' }), { id: null });
  assert.deepEqual(handled, [{ type: 'get-active' }]);
});

test('storage.local meneruskan get, set, remove, dan clear', async () => {
  assert.deepEqual(await chrome.storage.local.get(null), { keys: null });
  await chrome.storage.local.set({ a: 1 });
  assert.deepEqual(store.saved, { a: 1 });
  await chrome.storage.local.remove('a');
  assert.equal(store.removed, 'a');
  await chrome.storage.local.clear();
  assert.equal(store.cleared, true);
});

test('onChanged berbentuk seperti chrome.storage', () => {
  const seen = [];
  chrome.storage.onChanged.addListener((c, area) => seen.push([area, c]));
  changed({ settings: { newValue: { a: 1 }, oldValue: undefined } });
  assert.deepEqual(seen[0], ['local', { settings: { newValue: { a: 1 }, oldValue: undefined } }]);
});

test('emit mengirim pesan ke listener onMessage', async () => {
  const seen = [];
  chrome.runtime.onMessage.addListener((msg) => seen.push(msg));
  chrome.runtime.emit({ type: 'rec-state' });
  await flush();
  assert.deepEqual(seen, [{ type: 'rec-state' }]);
});

test('emit tetap mengirim ke listener lain bila satu listener gagal', async () => {
  const seen = [];
  chrome.runtime.onMessage.addListener(() => { throw new Error('rusak'); });
  chrome.runtime.onMessage.addListener((msg) => seen.push(msg));
  chrome.runtime.emit({ type: 'status' });
  await flush();
  assert.deepEqual(seen, [{ type: 'status' }]);
});

test('izin host selalu dianggap diberikan dan tabCapture menandai rekam tersedia', async () => {
  assert.equal(await chrome.permissions.request({ origins: ['http://x/*'] }), true);
  assert.ok(chrome.tabCapture);
});
