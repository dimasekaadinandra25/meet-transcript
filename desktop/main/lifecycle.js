const SHORTCUTS = {
  'Alt+Shift+A': 'rec-start',
  'Alt+Shift+V': 'rec-start-video',
  'Alt+Shift+S': 'rec-stop',
  'Alt+Shift+M': 'mute-toggle',
};

const ZOOM_KEYS = { '=': 1, '+': 1, '-': -1, 0: 0 };

function zoomStep({ type, control, alt, meta, key }) {
  if (type !== 'keyDown' || !control || alt || meta) return null;
  return ZOOM_KEYS[key] ?? null;
}

function closeAction({ recording, transcribing, quitting }) {
  if (!recording && !transcribing) return 'close';
  return quitting ? 'confirm-quit' : 'hide';
}

function quitPrompt({ recording }) {
  if (recording) {
    return {
      button: 'Stop recording and quit',
      message: 'A recording is still running.',
      detail: 'The recording is saved before the app quits. You can make the transcript later from History.',
    };
  }
  return {
    button: 'Cancel transcript and quit',
    message: 'A transcript is still being made.',
    detail: 'The recording stays saved. You can make the transcript again from History.',
  };
}

function trayLook({ recording, transcribing, muted }) {
  if (!recording) return { image: 'tray-idle', tooltip: transcribing ? 'Transcripables: transcribing' : 'Transcripables' };
  if (muted) return { image: 'tray-muted', tooltip: 'Transcripables: recording, microphone muted' };
  return { image: 'tray-recording', tooltip: 'Transcripables: recording' };
}

module.exports = { SHORTCUTS, closeAction, quitPrompt, trayLook, zoomStep };
