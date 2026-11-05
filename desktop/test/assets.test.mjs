import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const { resolveAsset, isAppUrl } = createRequire(import.meta.url)('../main/assets.js');
const roots = { app: '/a/desktop', shared: '/a' };

test('isAppUrl hanya menerima halaman aplikasi', () => {
  assert.equal(isAppUrl('transcripables://app/renderer/index.html'), true);
  assert.equal(isAppUrl('transcripables://app/'), true);
  for (const url of ['https://app/x', 'transcripables://lain/x', 'file:///x', 'bukan url', '', undefined]) {
    assert.equal(isAppUrl(url), false, String(url));
  }
});

test('hanya memetakan folder yang diizinkan', () => {
  assert.equal(resolveAsset('/renderer/index.html', roots), join('/a/desktop', 'renderer/index.html'));
  assert.equal(resolveAsset('/lib/merge.js', roots), join('/a', 'lib/merge.js'));
  assert.equal(resolveAsset('/panel/panel.js', roots), join('/a', 'panel/panel.js'));
  assert.equal(resolveAsset('/icons/icon48.png', roots), join('/a', 'icons/icon48.png'));
});

test('menolak traversal dan path lain', () => {
  for (const p of ['/lib/../manifest.json', '/lib/%2e%2e/LICENSE', '/main/main.js', '/test/x.js', '/lib/..%5cLICENSE', '/lib/%E0%A4%A', '/', '/lib']) {
    assert.equal(resolveAsset(p, roots), null, p);
  }
});
