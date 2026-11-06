import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

await import('../lib/i18n.js');
const { t, setLang, entries } = globalThis.MeetI18n;

const inIndonesian = (fn) => {
  setLang('id');
  try {
    return fn();
  } finally {
    setLang('en');
  }
};

test('English is the default and stays as written', () => {
  assert.equal(t('Save'), 'Save');
  assert.equal(t('Transcribing… 1/2'), 'Transcribing… 1/2');
});

test('Indonesian replaces a known text', () => {
  assert.equal(inIndonesian(() => t('Save')), 'Simpan');
});

test('marks and spaces around a text stay in place', () => {
  assert.equal(inIndonesian(() => t('← History')), '← Riwayat');
  assert.equal(inIndonesian(() => t('Copied ✓')), 'Tersalin ✓');
  assert.equal(inIndonesian(() => t(' Saved.')), ' Tersimpan.');
});

test('values inside a text are kept', () => {
  assert.equal(inIndonesian(() => t('Transcribing… 1/2')), 'Mentranskrip… 1/2');
  assert.equal(inIndonesian(() => t('Opening Gemini…')), 'Membuka Gemini…');
});

test('a message made of two known messages is translated in both parts', () => {
  assert.equal(inIndonesian(() => t('Saved, but Access to a was denied. Requests may fail.')),
    'Tersimpan, tetapi Akses ke a ditolak. Permintaan mungkin gagal.');
});

test('an unknown text stays as it is', () => {
  assert.equal(inIndonesian(() => t('Budget review')), 'Budget review');
});

test('every translation keeps the same number of values', () => {
  const count = (text) => text.split('{}').length - 1;
  for (const [english, indonesian] of entries()) assert.equal(count(indonesian), count(english), english);
});

test('every page loads the translator before the buttons', () => {
  for (const page of ['panel/panel.html', 'panel/print.html', 'popup/popup.html', 'desktop/renderer/index.html']) {
    const html = readFileSync(page, 'utf8');
    assert.ok(html.indexOf('lib/i18n.js') > 0, page);
    assert.ok(html.indexOf('lib/i18n.js') < html.indexOf('lib/ui.js'), page);
  }
});

test('a template with a value keeps that value untranslated', () => {
  const key = 'Delete "{}" and its recordings? This cannot be undone.';
  assert.equal(t(key), key);
  assert.equal(inIndonesian(() => t(key)), 'Hapus "{}" beserta rekamannya? Ini tidak bisa dibatalkan.');
});

test('messages built by the desktop app are translated', () => {
  const texts = ['no answer within 15 seconds', 'exit code 5', 'API key encryption is not available on this computer.'];
  for (const text of texts) assert.notEqual(inIndonesian(() => t(text)), text);
});
