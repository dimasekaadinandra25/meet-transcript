import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = {
  addEventListener() {},
  querySelectorAll: () => [],
  createElement: () => ({ dataset: {}, setAttribute() {} }),
  body: { classList: { toggle() {}, remove() {} } },
};
globalThis.addEventListener = () => {};
await import('../lib/ui.js');
const { shortcutFor } = globalThis.MeetUi;

test('tiap tombol mendapat shortcut dari labelnya', () => {
  const expected = {
    Live: '1', History: '2', Settings: '3', '← History': 'B', Copy: 'C', 'Copy transcript': 'T', 'Copy prompt + transcript': 'P',
    'Generate MoM': 'M', 'Regenerate MoM': 'M', 'Paste into Gemini': 'G', 'Paste into ChatGPT': 'C',
    'Copy & open Gemini': 'G', 'Copy & open ChatGPT': 'C', Download: 'U', 'Download .txt': 'T', 'Download .md': 'M',
    'Download recording — 14:00': 'R', 'Download audio (3 file)': 'A', 'Download video': 'V', Delete: 'X',
    'Generate transcript': 'T', Retranscribe: 'T', 'Transcribe audio': 'T', 'Stop recording': 'Q',
    'Mute microphone': 'N', 'Unmute microphone': 'N', 'Record audio': 'R', 'Record audio + video': 'V', 'Got it': 'O',
    'Open recordings folder': 'O', 'Allow microphone': 'A', 'Test connection': 'T', Save: 'S', 'Export backup (.zip)': 'X', 'Import backup': 'I',
    Record: 'R', 'Audio only': 'A', 'Audio + video': 'V', Microphone: 'M', 'Microphone  ✓': 'M', 'Caption language': 'L',
    Indonesia: 'I', 'Indonesia  ✓': 'I', English: 'N', 'Show details': 'T', 'See all (12)': 'L',
  };
  for (const [label, key] of Object.entries(expected)) assert.equal(shortcutFor(label), key, label);
});

test('tombol dengan isi bebas tidak mendapat shortcut', () => {
  assert.equal(shortcutFor('Weekly product meeting'), undefined);
});

test('shortcut tidak memakai tombol milik menu Chrome', () => {
  for (const label of ['Copy', 'Download', 'Delete', 'Save', 'Export backup', 'Import backup', 'Record audio']) {
    assert.ok(!['D', 'E', 'F'].includes(shortcutFor(label)), label);
  }
});

test('judul meeting bisa dilepas dari shortcut', () => {
  const removed = [];
  const button = { dataset: { shortcut: 'C' }, removeAttribute: (name) => removed.push(name) };
  globalThis.MeetUi.clearShortcut(button);
  assert.equal(button.dataset.shortcut, undefined);
  assert.deepEqual(removed.sort(), ['aria-keyshortcuts', 'title']);
});
