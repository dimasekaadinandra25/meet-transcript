const {
  app, BrowserWindow, Menu, Notification, Tray, desktopCapturer, dialog, globalShortcut, ipcMain, net,
  powerSaveBlocker, protocol, safeStorage, session, shell,
} = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveAsset, isAppUrl, SCHEME, APP_HOST } = require('./assets');
const { createStore } = require('./store');
const { loadLib, netCall, callChat, callTest, callStt, callShare, probe } = require('./net');
const { createEngine } = require('./engine');
const { createSpeakers } = require('./speakers');
const { createModels } = require('./models');
const { createAppAudio } = require('./appaudio');
const { appLabel, createMicWatch } = require('./micwatch');
const { createRecordingFolder } = require('./recordings');
const {
  HIDDEN_ARG, SHORTCUTS, closeAction, quitPrompt, startsHidden, trayLook, trayMenu, zoomStep,
} = require('./lifecycle');
const { RELEASES_URL, checkForUpdate } = require('./update');

const APP_ID = 'com.transcripables.desktop';
const APP_NAME = 'Transcripables';
const APP_URL = `${SCHEME}://${APP_HOST}`;
const APP_ROOT = join(__dirname, '..');
const ALLOWED_PERMISSIONS = new Set(['media', 'display-capture', 'clipboard-sanitized-write']);
const EXTERNAL_URLS = new Set(['https://gemini.google.com/app', 'https://chatgpt.com/', RELEASES_URL]);

// Returns the folder holding the files shared with the browser extension (lib, panel, icons).
const sharedRoot = () => (app.isPackaged ? process.resourcesPath : join(APP_ROOT, '..'));

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

// Serves the app's own pages and files over the transcripables:// scheme.
function handleAssets() {
  const roots = { app: APP_ROOT, shared: sharedRoot() };
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    const file = url.host === APP_HOST ? resolveAsset(url.pathname, roots) : null;
    return file ? net.fetch(pathToFileURL(file).href) : new Response('Not found', { status: 404 });
  });
}

let mainWindow;
let tray;
let quitting = false;
let sleepBlocker;
let recordingFolder;
let engine;
let appAudio;
let recState = { recording: false, transcribing: false, muted: false };
let keepInTray = true;
let askToRecord = true;
let micNotice;
let trayNoticeShown = false;

// Translates a text into the app's current language.
const t = (text) => globalThis.MeetI18n.t(text);
// Returns the path of a PNG image in the assets folder.
const assetPath = (name) => join(APP_ROOT, 'assets', `${name}.png`);

// Asks the app window to run a command such as starting or stopping a recording.
function runCommand(command) {
  const script = `globalThis.PanelHost.runCommand(${JSON.stringify(command)})`;
  mainWindow?.webContents.executeJavaScript(script, true)
    .catch((e) => console.error(e));
}

// Shows the app window and brings it to the front.
function showWindow() {
  mainWindow?.show();
  mainWindow?.focus();
}

// Shows the app window without taking focus if it is hidden or minimized.
function revealWindow() {
  if (!mainWindow.isVisible() || mainWindow.isMinimized()) mainWindow.showInactive();
}

const TRAY_ACTIONS = {
  show: () => showWindow(),
  quit: () => app.quit(),
  folder: async () => shell.openPath(await recordingFolder.ensure()),
};

// Rebuilds the tray icon's right-click menu for the current recording state.
function buildTrayMenu(state) {
  tray?.setContextMenu(Menu.buildFromTemplate(trayMenu(state).map((entry) => {
    const { separator, command, action, accelerator, label, ...item } = entry;
    if (separator) return { type: 'separator' };
    return {
      ...item,
      label: t(label),
      accelerator,
      registerAccelerator: false,
      click: () => (command ? runCommand(command) : TRAY_ACTIONS[action]?.()),
    };
  })));
}

// Updates the tray icon, tooltip, menu and window title to match the recording state.
function showState(state) {
  const look = trayLook(state);
  const tooltip = t(look.tooltip);
  tray?.setImage(assetPath(look.image));
  tray?.setToolTip(tooltip);
  buildTrayMenu(state);
  mainWindow?.setTitle(state.recording ? `● ${tooltip}` : tooltip);
}

// Stores the new recording state and keeps the computer awake while recording or transcribing.
function applyRecState(state) {
  recState = state;
  showState(state);
  const busy = state.recording || state.transcribing;
  if (busy && sleepBlocker == null) {
    sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!busy && sleepBlocker != null) {
    powerSaveBlocker.stop(sleepBlocker);
    sleepBlocker = undefined;
  }
}

// Creates the tray icon with its menu.
function setupTray() {
  tray = new Tray(assetPath('tray-idle'));
  tray.setToolTip('Transcripables');
  buildTrayMenu(recState);
  tray.on('click', showWindow);
}

// Registers the global recording shortcuts and warns about any that another app already uses.
function registerShortcuts() {
  const failed = Object.entries(SHORTCUTS)
    .filter(([accelerator, command]) => !globalShortcut.register(accelerator, () => runCommand(command)))
    .map(([accelerator]) => accelerator);
  if (!failed.length) return;
  mainWindow.webContents.once('did-finish-load', () => {
    const warning = `Shortcut ${failed.join(', ')} could not be registered because another app is using it.`;
    mainWindow.webContents.send('main:warn', warning);
  });
}

// Decides what closing the window does: close it, hide it to the tray, or ask before quitting.
function handleClose(event) {
  const action = closeAction({ ...recState, quitting, keepInTray });
  if (action === 'close') return;
  event.preventDefault();
  if (action === 'hide') {
    mainWindow.hide();
    if (process.platform === 'win32' && !trayNoticeShown) {
      trayNoticeShown = true;
      tray?.displayBalloon({
        title: 'Transcripables',
        content: t('Still running here, so shortcuts keep working. Right-click this icon to quit.'),
      });
    }
    return;
  }
  mainWindow.show();
  const { button, message, detail } = quitPrompt(recState);
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'warning',
    buttons: [t(button), t('Cancel')],
    defaultId: 1,
    cancelId: 1,
    message: t(message),
    detail: t(detail),
  });
  if (choice === 0) runCommand('quit-after-stop');
  else quitting = false;
}

// Registers an IPC handler that only answers requests coming from the app's own pages.
function handleFromApp(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isAppUrl(event.senderFrame?.url)) throw new Error('Unknown sender.');
    return handler(...args);
  });
}

// Applies the settings that change how the window and microphone watcher behave.
function applyWindowSettings(settings) {
  keepInTray = settings?.keepInTray !== false;
  askToRecord = settings?.askToRecord !== false;
}

// Creates the encrypted settings store and exposes it to the app window.
function serveStore() {
  const store = createStore({
    dir: join(app.getPath('userData'), 'store'),
    cipher: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
      decrypt: (data) => safeStorage.decryptString(Buffer.from(data, 'base64')),
    },
    onChange: (changes) => {
      if (changes.settings) applyWindowSettings(changes.settings.newValue);
      mainWindow?.webContents.send('store:changed', changes);
    },
  });
  store.get('settings').then((saved) => applyWindowSettings(Object(saved).settings)).catch(() => {});
  handleFromApp('store:get', store.get);
  handleFromApp('store:set', store.set);
  handleFromApp('store:remove', store.remove);
  handleFromApp('store:clear', store.clear);
}

// Sets up the network calls, speech engine, speaker finder and model downloads for the app window.
function serveNet() {
  loadLib(sharedRoot());
  const engineDir = join(app.isPackaged ? process.resourcesPath : APP_ROOT, 'engine');
  engine = createEngine({ dir: engineDir });
  const speakers = createSpeakers({ dir: join(engineDir, 'speakers') });
  handleFromApp('net:chat', callChat);
  handleFromApp('net:test', callTest);
  // Transcribes audio, starting the built-in engine when needed.
  handleFromApp('net:stt', (args) => callStt(args, engine.url));
  // Tells whether the built-in speech engine is installed.
  handleFromApp('engine:available', () => engine.available());
  // Starts the built-in speech engine ahead of use.
  handleFromApp('engine:start', () => netCall(engine.url));
  // Tells whether the speaker finder is installed.
  handleFromApp('speakers:available', () => speakers.available());
  // Finds who spoke when in the given audio.
  handleFromApp('speakers:find', (bytes) => netCall(() => speakers.find(bytes)));
  const models = createModels({
    dir: join(app.getPath('userData'), 'models'),
    onProgress: (progress) => mainWindow?.webContents.send('engine:model-progress', progress),
  });
  // Lists the downloadable speech models.
  handleFromApp('engine:models', () => models.list());
  // Downloads a speech model.
  handleFromApp('engine:download-model', (id) => netCall(() => models.download(id)));
  // Switches the engine to a downloaded model, or back to the standard one.
  handleFromApp('engine:use-model', (id) => engine.useModel(models.pathOf(id)));
  handleFromApp('net:probe', probe);
  handleFromApp('net:share', callShare);
}

// Sets up the folder recordings are saved into and exposes it to the app window.
function serveRecordings() {
  const folder = process.env.TRANSCRIPABLES_RECORDINGS_DIR ?? join(app.getPath('documents'), 'Transcripables');
  recordingFolder = createRecordingFolder(folder);
  handleFromApp('recordings:write', recordingFolder.write);
  handleFromApp('recordings:open', TRAY_ACTIONS.folder);
}

// Lets the app window pick a screen or window to record, with its system sound.
function serveCapture() {
  let chosenSource = null;
  // Lists the screens and windows that can be recorded.
  const listSources = () => desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 0, height: 0 },
  });
  // Returns the id and name of each screen and window that can be recorded.
  handleFromApp('capture:sources', async () => (await listSources()).map(({ id, name }) => ({ id, name })));
  // Remembers which screen or window the next recording should use.
  handleFromApp('capture:use', (id) => { chosenSource = id; });
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    listSources().then((sources) => {
      const chosen = sources.find((source) => source.id === chosenSource);
      const video = chosen ?? sources.find((source) => source.id.startsWith('screen:'));
      callback({ video, audio: 'loopback' });
    }).catch(() => callback({}));
  });
}

// Sets up recording a single app's sound and watching for apps that start using the microphone.
function serveAppAudio() {
  appAudio = createAppAudio({
    dir: join(app.isPackaged ? process.resourcesPath : APP_ROOT, 'native', 'bin'),
    onData: (bytes) => mainWindow?.webContents.send('appaudio:data', bytes),
    onEnded: () => mainWindow?.webContents.send('appaudio:ended'),
  });
  // Tells whether app sound recording is possible on this computer.
  handleFromApp('appaudio:available', () => appAudio.available());
  // Lists the apps that are playing sound.
  handleFromApp('appaudio:list', () => appAudio.list());
  // Starts recording the sound of the app with this process id.
  handleFromApp('appaudio:start', (pid) => netCall(() => appAudio.start(pid)));
  // Stops recording app sound.
  handleFromApp('appaudio:stop', () => appAudio.stop());
  createMicWatch({
    list: appAudio.micApps,
    shouldWatch: () => askToRecord && appAudio.available() && !recState.recording && !recState.transcribing,
    onDetected: offerToRecord,
  }).start();
}

// Shows a notification offering to record when an app starts using the microphone.
function offerToRecord(name) {
  const body = t(`${appLabel(name)} is using your microphone. Click to record this meeting.`);
  if (!Notification.isSupported()) {
    mainWindow?.webContents.send('main:warn', body);
    return;
  }
  micNotice = new Notification({ title: 'Transcripables', body });
  micNotice.on('click', () => {
    showWindow();
    runCommand('rec-start');
  });
  micNotice.show();
}

// Grants only the permissions the app needs, and only to the app's own pages.
function limitPermissions() {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isAppUrl(details.requestingUrl));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) => (
    ALLOWED_PERMISSIONS.has(permission) && isAppUrl(origin)
  ));
}

// Creates the locked-down app window and recovers it if its page crashes.
function createWindow() {
  const startHidden = startsHidden(process.argv)
    || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
  const win = new BrowserWindow({
    width: 420,
    height: 720,
    show: !startHidden,
    icon: join(sharedRoot(), 'icons', 'icon128.png'),
    webPreferences: {
      preload: join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.on('close', handleClose);
  win.webContents.on('render-process-gone', () => {
    if (quitting) {
      engine?.stop();
      app.exit(0);
      return;
    }
    appAudio?.stop();
    applyRecState({ recording: false, transcribing: false, muted: false });
    win.webContents.once('did-finish-load', () => {
      const warning = 'The app window crashed and restarted. Any recording in progress has stopped, and what was saved so far is in History.';
      win.webContents.send('main:warn', warning);
    });
    win.webContents.reload();
  });
  win.webContents.on('before-input-event', (event, input) => {
    const step = zoomStep(input);
    if (step === null) return;
    event.preventDefault();
    win.webContents.setZoomLevel(step === 0 ? 0 : win.webContents.getZoomLevel() + step);
  });
  win.on('page-title-updated', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  win.loadURL(`${APP_URL}/renderer/index.html`);
  return win;
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', showWindow);
app.on('activate', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  engine?.stop();
  appAudio?.stop();
});

app.whenReady().then(() => {
  app.setAppUserModelId(app.isPackaged ? APP_ID : APP_NAME);
  globalThis.fetch = (input, init) => net.fetch(input instanceof URL ? input.href : input, init);
  handleAssets();
  limitPermissions();
  serveStore();
  serveNet();
  serveCapture();
  serveAppAudio();
  serveRecordings();
  handleFromApp('rec:state', applyRecState);
  handleFromApp('window:reveal', revealWindow);
  // Switches the app's language and refreshes the tray texts.
  handleFromApp('app:language', (code) => {
    globalThis.MeetI18n.setLang(code);
    showState(recState);
  });
  // Checks GitHub for a newer release, reporting a failure instead of throwing.
  handleFromApp('app:update-check', () => (
    checkForUpdate({ current: app.getVersion() }).catch((e) => ({ status: 'failed', error: e.message }))
  ));
  // Opens the latest release page in the browser.
  handleFromApp('app:update-open', () => shell.openExternal(RELEASES_URL));
  // Tells whether the app can start at login and whether it currently does.
  handleFromApp('app:login-item', () => ({
    available: app.isPackaged,
    on: app.getLoginItemSettings({ args: [HIDDEN_ARG] }).openAtLogin,
  }));
  // Turns starting at login on or off, hidden in the tray.
  handleFromApp('app:set-login-item', (on) => {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!on, args: [HIDDEN_ARG] });
  });
  // Prints the current page to a PDF.
  handleFromApp('pdf:make', () => mainWindow.webContents.printToPDF({ printBackground: false }));
  // Stops the speech engine and quits right away.
  handleFromApp('app:quit', () => {
    engine.stop();
    app.exit(0);
  });
  // Opens a link in the browser, but only the known sites and empty email drafts.
  handleFromApp('shell:open', (url) => {
    if (EXTERNAL_URLS.has(url) || String(url).startsWith('mailto:?')) return shell.openExternal(url);
    return undefined;
  });
  const appMenu = process.platform === 'darwin'
    ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }])
    : null;
  Menu.setApplicationMenu(appMenu);
  mainWindow = createWindow();
  setupTray();
  registerShortcuts();
});

app.on('window-all-closed', () => app.quit());
