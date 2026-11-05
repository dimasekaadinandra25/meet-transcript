const { app, BrowserWindow, desktopCapturer, ipcMain, net, protocol, safeStorage, session } = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveAsset, isAppUrl, SCHEME, APP_HOST } = require('./assets');
const { createStore } = require('./store');
const { loadLib, callChat, callTest, callStt, probe } = require('./net');

const APP_URL = `${SCHEME}://${APP_HOST}`;
const APP_ROOT = join(__dirname, '..');
const ALLOWED_PERMISSIONS = new Set(['media', 'display-capture']);

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
  serveCapture();
  mainWindow = createWindow();
});

app.on('window-all-closed', () => app.quit());
