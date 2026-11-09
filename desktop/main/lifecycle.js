const SHORTCUTS = {
  'Alt+Shift+A': 'rec-start',
  'Alt+Shift+V': 'rec-start-video',
  'Alt+Shift+S': 'rec-stop',
  'Alt+Shift+M': 'mute-toggle',
  'Alt+Shift+P': 'pause-toggle',
  'Alt+Shift+K': 'mark',
};

const HIDDEN_ARG = '--hidden';
const ZOOM_KEYS = { '=': 1, '+': 1, '-': -1, 0: 0 };

// Returns how a Ctrl key press changes the zoom (1, -1, or 0 to reset), or null if it is not a zoom key.
function zoomStep({ type, control, alt, meta, key }) {
  if (type !== 'keyDown' || !control || alt || meta) return null;
  return ZOOM_KEYS[key] ?? null;
}

const ACCELERATORS = Object.fromEntries(
  Object.entries(SHORTCUTS).map(([accelerator, command]) => [command, accelerator]),
);
// Builds a tray menu item that runs an app command and shows its shortcut.
const commandItem = (label, command) => ({ label, command, accelerator: ACCELERATORS[command] });
// Builds a greyed-out tray menu item that only shows a status.
const statusItem = (label) => ({ label, enabled: false });
const SEPARATOR = { separator: true };

// Returns the recording controls shown at the top of the tray menu.
function trayControls({ recording, transcribing, muted, paused }) {
  if (transcribing) return [statusItem('Transcribing…')];
  if (recording) {
    let status = 'Recording';
    if (paused) status = 'Paused';
    else if (muted) status = 'Recording, microphone muted';
    return [
      statusItem(status),
      commandItem('Stop recording', 'rec-stop'),
      commandItem(paused ? 'Resume recording' : 'Pause recording', 'pause-toggle'),
      commandItem(muted ? 'Unmute microphone' : 'Mute microphone', 'mute-toggle'),
      commandItem('Mark moment', 'mark'),
    ];
  }
  return [commandItem('Record audio', 'rec-start'), commandItem('Record audio + video', 'rec-start-video')];
}

// Returns the full tray menu for the current recording state.
function trayMenu(state) {
  return [
    ...trayControls(state),
    SEPARATOR,
    { label: 'Open recordings folder', action: 'folder' },
    { label: 'Show', action: 'show' },
    { label: 'Quit', action: 'quit' },
  ];
}

// Decides whether closing the window should close it, hide it to the tray, or ask before quitting.
function closeAction({ recording, transcribing, quitting, keepInTray }) {
  const busy = recording || transcribing;
  if (quitting) return busy ? 'confirm-quit' : 'close';
  return busy || keepInTray ? 'hide' : 'close';
}

// Tells whether the app was launched with the flag to start hidden.
const startsHidden = (argv) => argv.includes(HIDDEN_ARG);

// Returns the texts of the dialog that asks before quitting during a recording or transcript.
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

// Returns the tray icon image and tooltip for the current recording state.
function trayLook({ recording, transcribing, muted, paused }) {
  if (!recording) {
    return { image: 'tray-idle', tooltip: transcribing ? 'Transcripables: transcribing' : 'Transcripables' };
  }
  if (paused) return { image: 'tray-muted', tooltip: 'Transcripables: recording paused' };
  if (muted) return { image: 'tray-muted', tooltip: 'Transcripables: recording, microphone muted' };
  return { image: 'tray-recording', tooltip: 'Transcripables: recording' };
}

module.exports = { HIDDEN_ARG, SHORTCUTS, closeAction, quitPrompt, startsHidden, trayLook, trayMenu, zoomStep };
