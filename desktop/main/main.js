const { app, BrowserWindow, net, protocol, session } = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveAsset } = require('./assets');

const SCHEME = 'transcripables';
const ORIGIN = `${SCHEME}://app`;
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
    const file = url.host === 'app' ? resolveAsset(url.pathname, roots) : null;
    return file ? net.fetch(pathToFileURL(file).href) : new Response('Not found', { status: 404 });
  });
}

function limitPermissions() {
  const isApp = (url) => {
    try {
      return new URL(url).origin === ORIGIN;
    } catch {
      return false;
    }
  };
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(permission === 'media' && isApp(details.requestingUrl));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) => (
    permission === 'media' && isApp(origin)
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
  win.loadURL(`${ORIGIN}/renderer/index.html`);
  return win;
}

app.whenReady().then(() => {
  handleAssets();
  limitPermissions();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
