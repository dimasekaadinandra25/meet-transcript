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
const { createModels } = require('./models');
const { createAppAudio } = require('./appaudio');
const { appLabel, createMicWatch } = require('./micwatch');
const { createRecordingFolder } = require('./recordings');
const { HIDDEN_ARG, SHORTCUTS, closeAction, quitPrompt, startsHidden, trayLook, trayMenu, zoomStep } = require('./lifecycle');
const { RELEASES_URL, checkForUpdate } = require('./update');

const APP_ID = 'com.transcripables.desktop';
const APP_NAME = 'Transcripables';
const APP_URL = `${SCHEME}://${APP_HOST}`;
const APP_ROOT = join(__dirname, '..');
const ALLOWED_PERMISSIONS = new Set(['media', 'display-capture', 'clipboard-sanitized-write']);
const EXTERNAL_URLS = new Set(['https://gemini.google.com/app', 'https://chatgpt.com/', RELEASES_URL]);

const sharedRoot = () => (app.isPackaged ? process.resourcesPath : join(APP_ROOT, '..'));

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

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

const t = (text) => globalThis.MeetI18n.t(text);
const assetPath = (name) => join(APP_ROOT, 'assets', `${name}.png`);

function runCommand(command) {
  mainWindow?.webContents.executeJavaScript(`globalThis.PanelHost.runCommand(${JSON.stringify(command)})`, true)
    .catch((e) => console.error(e));
}

function showWindow() {
  mainWindow?.show();
  mainWindow?.focus();
}

function revealWindow() {
  if (!mainWindow.isVisible() || mainWindow.isMinimized()) mainWindow.showInactive();
}

const TRAY_ACTIONS = {
  show: () => showWindow(),
  quit: () => app.quit(),
  folder: async () => shell.openPath(await recordingFolder.ensure()),
};

function buildTrayMenu(state) {
  tray?.setContextMenu(Menu.buildFromTemplate(trayMenu(state).map(({ separator, command, action, accelerator, label, ...item }) => (separator ? { type: 'separator' } : {
    ...item,
    label: t(label),
    accelerator,
    registerAccelerator: false,
    click: () => (command ? runCommand(command) : TRAY_ACTIONS[action]?.()),
  }))));
}

function showState(state) {
  const look = trayLook(state);
  const tooltip = t(look.tooltip);
  tray?.setImage(assetPath(look.image));
  tray?.setToolTip(tooltip);
  buildTrayMenu(state);
  mainWindow?.setTitle(state.recording ? `● ${tooltip}` : tooltip);
}

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

function setupTray() {
  tray = new Tray(assetPath('tray-idle'));
  tray.setToolTip('Transcripables');
  buildTrayMenu(recState);
  tray.on('click', showWindow);
}

function registerShortcuts() {
  const failed = Object.entries(SHORTCUTS)
    .filter(([accelerator, command]) => !globalShortcut.register(accelerator, () => runCommand(command)))
    .map(([accelerator]) => accelerator);
  if (!failed.length) return;
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send('main:warn', `Shortcut ${failed.join(', ')} could not be registered because another app is using it.`);
  });
}

function handleClose(event) {
  const action = closeAction({ ...recState, quitting, keepInTray });
  if (action === 'close') return;
  event.preventDefault();
  if (action === 'hide') {
    mainWindow.hide();
    if (process.platform === 'win32' && !trayNoticeShown) {
      trayNoticeShown = true;
      tray?.displayBalloon({ title: 'Transcripables', content: t('Still running here, so shortcuts keep working. Right-click this icon to quit.') });
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

function handleFromApp(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isAppUrl(event.senderFrame?.url)) throw new Error('Unknown sender.');
    return handler(...args);
  });
}

function applyWindowSettings(settings) {
  keepInTray = settings?.keepInTray !== false;
  askToRecord = settings?.askToRecord !== false;
}

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

function serveNet() {
  loadLib(sharedRoot());
  engine = createEngine({ dir: join(app.isPackaged ? process.resourcesPath : APP_ROOT, 'engine') });
  handleFromApp('net:chat', callChat);
  handleFromApp('net:test', callTest);
  handleFromApp('net:stt', (args) => callStt(args, engine.url));
  handleFromApp('engine:available', () => engine.available());
  handleFromApp('engine:start', () => netCall(engine.url));
  const models = createModels({
    dir: join(app.getPath('userData'), 'models'),
    onProgress: (progress) => mainWindow?.webContents.send('engine:model-progress', progress),
  });
  handleFromApp('engine:models', () => models.list());
  handleFromApp('engine:download-model', (id) => netCall(() => models.download(id)));
  handleFromApp('engine:use-model', (id) => engine.useModel(models.pathOf(id)));
  handleFromApp('net:probe', probe);
  handleFromApp('net:share', callShare);
}

function serveRecordings() {
  recordingFolder = createRecordingFolder(process.env.TRANSCRIPABLES_RECORDINGS_DIR ?? join(app.getPath('documents'), 'Transcripables'));
  handleFromApp('recordings:write', recordingFolder.write);
  handleFromApp('recordings:open', TRAY_ACTIONS.folder);
}

function serveCapture() {
  let chosenSource = null;
  const listSources = () => desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 0, height: 0 },
  });
  handleFromApp('capture:sources', async () => (await listSources()).map(({ id, name }) => ({ id, name })));
  handleFromApp('capture:use', (id) => { chosenSource = id; });
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    listSources().then((sources) => {
      const video = sources.find((s) => s.id === chosenSource) ?? sources.find((s) => s.id.startsWith('screen:'));
      callback({ video, audio: 'loopback' });
    }).catch(() => callback({}));
  });
}

function serveAppAudio() {
  appAudio = createAppAudio({
    dir: join(app.isPackaged ? process.resourcesPath : APP_ROOT, 'native', 'bin'),
    onData: (bytes) => mainWindow?.webContents.send('appaudio:data', bytes),
    onEnded: () => mainWindow?.webContents.send('appaudio:ended'),
  });
  handleFromApp('appaudio:available', () => appAudio.available());
  handleFromApp('appaudio:list', () => appAudio.list());
  handleFromApp('appaudio:start', (pid) => netCall(() => appAudio.start(pid)));
  handleFromApp('appaudio:stop', () => appAudio.stop());
  createMicWatch({
    list: appAudio.micApps,
    shouldWatch: () => askToRecord && appAudio.available() && !recState.recording && !recState.transcribing,
    onDetected: offerToRecord,
  }).start();
}

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

function limitPermissions() {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isAppUrl(details.requestingUrl));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) => (
    ALLOWED_PERMISSIONS.has(permission) && isAppUrl(origin)
  ));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 420,
    height: 720,
    show: !startsHidden(process.argv) && !(process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin),
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
      win.webContents.send('main:warn', 'The app window crashed and restarted. Any recording in progress has stopped, and what was saved so far is in History.');
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
  handleFromApp('app:language', (code) => {
    globalThis.MeetI18n.setLang(code);
    showState(recState);
  });
  handleFromApp('app:update-check', () => checkForUpdate({ current: app.getVersion() }).catch((e) => ({ status: 'failed', error: e.message })));
  handleFromApp('app:update-open', () => shell.openExternal(RELEASES_URL));
  handleFromApp('app:login-item', () => ({ available: app.isPackaged, on: app.getLoginItemSettings({ args: [HIDDEN_ARG] }).openAtLogin }));
  handleFromApp('app:set-login-item', (on) => {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!on, args: [HIDDEN_ARG] });
  });
  handleFromApp('pdf:make', () => mainWindow.webContents.printToPDF({ printBackground: false }));
  handleFromApp('app:quit', () => {
    engine.stop();
    app.exit(0);
  });
  handleFromApp('shell:open', (url) => {
    if (EXTERNAL_URLS.has(url) || String(url).startsWith('mailto:?')) return shell.openExternal(url);
    return undefined;
  });
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]) : null);
  mainWindow = createWindow();
  setupTray();
  registerShortcuts();
});

app.on('window-all-closed', () => app.quit());
