import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { closeAction, quitPrompt, trayLook, SHORTCUTS } = createRequire(import.meta.url)('../main/lifecycle.js');

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
  assert.deepEqual(trayLook({ recording: true, muted: false }), { image: 'tray-recording', tooltip: 'Transcripables: merekam' });
  assert.deepEqual(trayLook({ recording: true, muted: true }), { image: 'tray-muted', tooltip: 'Transcripables: merekam, mikrofon dibisukan' });
});

test('shortcut memakai kombinasi dari plan', () => {
  assert.deepEqual(SHORTCUTS, {
    'Alt+Shift+A': 'rec-start',
    'Alt+Shift+V': 'rec-start-video',
    'Alt+Shift+S': 'rec-stop',
    'Alt+Shift+M': 'mute-toggle',
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
    { image: 'tray-idle', tooltip: 'Transcripables: mentranskrip' });
});

test('konfirmasi keluar menjelaskan apa yang berjalan', () => {
  assert.equal(quitPrompt({ recording: true }).button, 'Hentikan rekaman lalu keluar');
  assert.equal(quitPrompt({ recording: false }).button, 'Batalkan transkrip lalu keluar');
  assert.match(quitPrompt({ recording: false }).detail, /Riwayat/);
});
