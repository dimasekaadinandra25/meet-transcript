import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { closeAction, quitPrompt, trayLook, trayMenu, zoomStep, SHORTCUTS } = createRequire(import.meta.url)('../main/lifecycle.js');

test('tutup jendela saat merekam tidak menghentikan rekaman', () => {
  assert.equal(closeAction({ recording: true, quitting: false }), 'hide');
});

test('keluar saat merekam meminta konfirmasi', () => {
  assert.equal(closeAction({ recording: true, quitting: true }), 'confirm-quit');
});

test('tanpa rekaman jendela menutup', () => {
  assert.equal(closeAction({ recording: false, quitting: false }), 'close');
  assert.equal(closeAction({ recording: false, quitting: true }), 'close');
});

test('tampilan tray mengikuti rekaman dan mute', () => {
  assert.deepEqual(trayLook({ recording: false, muted: false }), { image: 'tray-idle', tooltip: 'Transcripables' });
  assert.deepEqual(trayLook({ recording: true, muted: false }), { image: 'tray-recording', tooltip: 'Transcripables: recording' });
  assert.deepEqual(trayLook({ recording: true, muted: true }), { image: 'tray-muted', tooltip: 'Transcripables: recording, microphone muted' });
});

test('shortcut memakai kombinasi dari plan', () => {
  assert.deepEqual(SHORTCUTS, {
    'Alt+Shift+A': 'rec-start',
    'Alt+Shift+V': 'rec-start-video',
    'Alt+Shift+S': 'rec-stop',
    'Alt+Shift+M': 'mute-toggle',
    'Alt+Shift+K': 'mark',
  });
});

test('tutup jendela saat transkrip berjalan tidak menghentikan transkrip', () => {
  assert.equal(closeAction({ recording: false, transcribing: true, quitting: false }), 'hide');
});

test('keluar saat transkrip berjalan meminta konfirmasi', () => {
  assert.equal(closeAction({ recording: false, transcribing: true, quitting: true }), 'confirm-quit');
});

test('tray menunjukkan transkrip sedang berjalan', () => {
  assert.deepEqual(trayLook({ recording: false, transcribing: true, muted: false }),
    { image: 'tray-idle', tooltip: 'Transcripables: transcribing' });
});

test('konfirmasi keluar menjelaskan apa yang berjalan', () => {
  assert.equal(quitPrompt({ recording: true }).button, 'Stop recording and quit');
  assert.equal(quitPrompt({ recording: false }).button, 'Cancel transcript and quit');
  assert.match(quitPrompt({ recording: false }).detail, /History/);
});

test('Ctrl plus, minus, dan 0 mengubah zoom', () => {
  const press = (key, extra = {}) => zoomStep({ type: 'keyDown', control: true, key, ...extra });
  assert.equal(press('='), 1);
  assert.equal(press('+'), 1);
  assert.equal(press('-'), -1);
  assert.equal(press('0'), 0);
  assert.equal(press('a'), null);
  assert.equal(press('='), 1);
  assert.equal(zoomStep({ type: 'keyDown', control: false, key: '=' }), null);
  assert.equal(zoomStep({ type: 'keyUp', control: true, key: '=' }), null);
  assert.equal(press('=', { alt: true }), null);
});

const labels = (state) => trayMenu(state).filter((item) => item.label).map((item) => item.label);
const find = (state, label) => trayMenu(state).find((item) => item.label === label);

test('tray saat diam bisa mulai merekam', () => {
  const state = { recording: false, transcribing: false, muted: false };
  assert.deepEqual(labels(state), ['Record audio', 'Record audio + video', 'Open recordings folder', 'Show', 'Quit']);
  assert.equal(find(state, 'Record audio').command, 'rec-start');
  assert.equal(find(state, 'Record audio').accelerator, 'Alt+Shift+A');
  assert.equal(find(state, 'Record audio + video').command, 'rec-start-video');
});

test('tray saat merekam bisa berhenti dan membisukan', () => {
  const state = { recording: true, transcribing: false, muted: false };
  assert.deepEqual(labels(state), ['Recording', 'Stop recording', 'Mute microphone', 'Mark moment', 'Open recordings folder', 'Show', 'Quit']);
  assert.equal(find(state, 'Recording').enabled, false);
  assert.equal(find(state, 'Stop recording').command, 'rec-stop');
  assert.equal(find(state, 'Mute microphone').command, 'mute-toggle');
});

test('tray menunjukkan mikrofon yang dibisukan', () => {
  const state = { recording: true, transcribing: false, muted: true };
  assert.ok(labels(state).includes('Recording, microphone muted'));
  assert.equal(find(state, 'Unmute microphone').command, 'mute-toggle');
});

test('tray saat mentranskrip tidak bisa mulai merekam', () => {
  const state = { recording: false, transcribing: true, muted: false };
  assert.deepEqual(labels(state), ['Transcribing…', 'Open recordings folder', 'Show', 'Quit']);
  assert.equal(find(state, 'Transcribing…').enabled, false);
});

test('tray selalu punya tampilkan dan keluar', () => {
  assert.equal(find({ recording: false }, 'Show').action, 'show');
  assert.equal(find({ recording: false }, 'Quit').action, 'quit');
  assert.equal(find({ recording: false }, 'Open recordings folder').action, 'folder');
});
