const SHORTCUTS = {
  'Alt+Shift+A': 'rec-start',
  'Alt+Shift+V': 'rec-start-video',
  'Alt+Shift+S': 'rec-stop',
  'Alt+Shift+M': 'mute-toggle',
};

function closeAction({ recording, transcribing, quitting }) {
  if (!recording && !transcribing) return 'close';
  return quitting ? 'confirm-quit' : 'hide';
}

function quitPrompt({ recording }) {
  if (recording) {
    return {
      button: 'Hentikan rekaman lalu keluar',
      message: 'Rekaman masih berjalan.',
      detail: 'Rekaman disimpan sebelum aplikasi keluar. Transkrip bisa dibuat nanti dari Riwayat.',
    };
  }
  return {
    button: 'Batalkan transkrip lalu keluar',
    message: 'Transkrip masih dibuat.',
    detail: 'Rekaman tetap tersimpan. Transkrip bisa dibuat lagi dari Riwayat.',
  };
}

function trayLook({ recording, transcribing, muted }) {
  if (!recording) return { image: 'tray-idle', tooltip: transcribing ? 'Transcripables: mentranskrip' : 'Transcripables' };
  if (muted) return { image: 'tray-muted', tooltip: 'Transcripables: merekam, mikrofon dibisukan' };
  return { image: 'tray-recording', tooltip: 'Transcripables: merekam' };
}

module.exports = { SHORTCUTS, closeAction, quitPrompt, trayLook };
