const { app, BrowserWindow, ipcMain, net, protocol, safeStorage, session } = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveAsset, isAppUrl, SCHEME, APP_HOST } = require('./assets');
const { createStore } = require('./store');
const { loadLib, callChat, callTest, callStt, probe } = require('./net');

const APP_URL = `${SCHEME}://${APP_HOST}`;
const APP_ROOT = join(__dirname, '..');

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

function limitPermissions() {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(permission === 'media' && isAppUrl(details.requestingUrl));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) => (
    permission === 'media' && isAppUrl(origin)
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
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  win.loadURL(`${APP_URL}/renderer/index.html`);
  return win;
}

app.whenReady().then(() => {
  handleAssets();
  limitPermissions();
  serveStore();
  serveNet();
  mainWindow = createWindow();
});

app.on('window-all-closed', () => app.quit());
