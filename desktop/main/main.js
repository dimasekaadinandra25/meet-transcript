const {
  app, BrowserWindow, Menu, Tray, desktopCapturer, dialog, globalShortcut, ipcMain, net,
  powerSaveBlocker, protocol, safeStorage, session, shell,
} = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveAsset, isAppUrl, SCHEME, APP_HOST } = require('./assets');
const { createStore } = require('./store');
const { loadLib, callChat, callTest, callStt, probe } = require('./net');
const { SHORTCUTS, closeAction, quitPrompt, trayLook } = require('./lifecycle');

const APP_URL = `${SCHEME}://${APP_HOST}`;
const APP_ROOT = join(__dirname, '..');
const ALLOWED_PERMISSIONS = new Set(['media', 'display-capture', 'clipboard-sanitized-write']);
const EXTERNAL_URLS = new Set(['https://gemini.google.com/app', 'https://chatgpt.com/']);

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
let recState = { recording: false, transcribing: false, muted: false };

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

function applyRecState(state) {
  recState = state;
  const look = trayLook(state);
  tray?.setImage(assetPath(look.image));
  tray?.setToolTip(look.tooltip);
  mainWindow?.setTitle(state.recording ? `● ${look.tooltip}` : look.tooltip);
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
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Tampilkan', click: showWindow },
    { label: 'Keluar', click: () => app.quit() },
  ]));
  tray.on('click', showWindow);
}

function registerShortcuts() {
  const failed = Object.entries(SHORTCUTS)
    .filter(([accelerator, command]) => !globalShortcut.register(accelerator, () => runCommand(command)))
    .map(([accelerator]) => accelerator);
  if (!failed.length) return;
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send('main:warn', `Shortcut ${failed.join(', ')} tidak bisa didaftarkan karena dipakai aplikasi lain.`);
  });
}

function handleClose(event) {
  const action = closeAction({ ...recState, quitting });
  if (action === 'close') return;
  event.preventDefault();
  if (action === 'hide') {
    mainWindow.hide();
    return;
  }
  const { button, message, detail } = quitPrompt(recState);
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'warning',
    buttons: [button, 'Batal'],
    defaultId: 1,
    cancelId: 1,
    message,
    detail,
  });
  if (choice === 0) runCommand('quit-after-stop');
  else quitting = false;
}

function handleFromApp(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isAppUrl(event.senderFrame?.url)) throw new Error('Pengirim tidak dikenal.');
    return handler(...args);
  });
}

function serveStore() {
  const store = createStore({
    dir: join(app.getPath('userData'), 'store'),
    cipher: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
      decrypt: (data) => safeStorage.decryptString(Buffer.from(data, 'base64')),
    },
    onChange: (changes) => mainWindow?.webContents.send('store:changed', changes),
  });
  handleFromApp('store:get', store.get);
  handleFromApp('store:set', store.set);
  handleFromApp('store:remove', store.remove);
  handleFromApp('store:clear', store.clear);
}

function serveNet() {
  loadLib(sharedRoot());
  handleFromApp('net:chat', callChat);
  handleFromApp('net:test', callTest);
  handleFromApp('net:stt', callStt);
  handleFromApp('net:probe', probe);
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
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());

app.whenReady().then(() => {
  handleAssets();
  limitPermissions();
  serveStore();
  serveNet();
  serveCapture();
  handleFromApp('rec:state', applyRecState);
  handleFromApp('window:reveal', revealWindow);
  handleFromApp('app:quit', () => app.exit(0));
  handleFromApp('shell:open', (url) => {
    if (EXTERNAL_URLS.has(url)) return shell.openExternal(url);
    return undefined;
  });
  mainWindow = createWindow();
  setupTray();
  registerShortcuts();
});

app.on('window-all-closed', () => app.quit());
