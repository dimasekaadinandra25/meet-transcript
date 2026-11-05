const SHORTCUTS = {
  'Alt+Shift+A': 'rec-start',
  'Alt+Shift+V': 'rec-start-video',
  'Alt+Shift+S': 'rec-stop',
  'Alt+Shift+M': 'mute-toggle',
};

function closeAction({ recording, quitting }) {
  if (!recording) return 'close';
  return quitting ? 'confirm-quit' : 'hide';
}

function trayLook({ recording, muted }) {
  if (!recording) return { image: 'tray-idle', tooltip: 'Transcripables' };
  if (muted) return { image: 'tray-muted', tooltip: 'Transcripables: merekam, mikrofon dibisukan' };
  return { image: 'tray-recording', tooltip: 'Transcripables: merekam' };
}

module.exports = { SHORTCUTS, closeAction, trayLook };
