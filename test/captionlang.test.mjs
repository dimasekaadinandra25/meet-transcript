import { test } from 'node:test';
import assert from 'node:assert/strict';

const LABELS = ['English', 'English (Australia)', 'English (India)',
  'English (Philippines)', 'English (UK)', 'Indonesian (Indonesia)', 'Javanese (Indonesia)'];

globalThis.document = {
  querySelectorAll: () => LABELS.map((t) => ({ textContent: `  ${t}  ` })),
};
await import('../content/selectors.js');
const { langOption, LANG_PATTERN } = globalThis.MeetSelectors;

const pick = (lang) => langOption(LANG_PATTERN[lang])?.textContent.trim();

test('Indonesia tidak tertukar dengan Javanese (Indonesia)', () => {
  assert.equal(pick('id'), 'Indonesian (Indonesia)');
  assert.ok(!LANG_PATTERN.id.test('Javanese (Indonesia)'));
});

test('English memilih yang polos, bukan varian negara', () => {
  assert.equal(pick('en'), 'English');
});

test('label versi UI Indonesia ikut cocok', () => {
  assert.ok(LANG_PATTERN.id.test('Bahasa Indonesia'));
  assert.ok(LANG_PATTERN.id.test('Indonesia (Indonesia)'));
  assert.ok(LANG_PATTERN.en.test('Inggris (Amerika Serikat)'));
  assert.ok(!LANG_PATTERN.en.test('Indonesia (Indonesia)'));
});

test('tanpa opsi yang cocok mengembalikan null, bukan opsi sembarang', () => {
  assert.equal(langOption(/^klingon\b/i), null);
});

test('with no saved choice, Meet captions are switched to English', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const ticks = [];
  const clicked = [];
  const ctx = vm.createContext({
    chrome: { runtime: { id: 'x' } },
    setInterval: (fn) => ticks.push(fn),
    setTimeout: (fn) => fn(),
    KeyboardEvent: class {},
    MeetSession: { watchSettings: (apply) => apply({}, false) },
    MeetSelectors: {
      LANG_PATTERN,
      inCall: () => true,
      langCombobox: () => ({ textContent: 'Indonesian (Indonesia)', click() {} }),
      langOption: (re) => ({ click: () => clicked.push(String(re)) }),
    },
  });
  vm.runInContext('globalThis.MeetSession = MeetSession; globalThis.MeetSelectors = MeetSelectors;', ctx);
  vm.runInContext(readFileSync(new URL('../content/captionlang.js', import.meta.url), 'utf8'), ctx);
  ticks[0]();
  assert.deepEqual(clicked, [String(LANG_PATTERN.en)]);
});
