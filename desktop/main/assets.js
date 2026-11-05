const { join } = require('node:path');

const SCHEME = 'transcripables';
const APP_HOST = 'app';
const ROOT_OF = { renderer: 'app', lib: 'shared', panel: 'shared', icons: 'shared' };

function resolveAsset(urlPath, roots) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null;
  const parts = decoded.replace(/^\//, '').split('/');
  if (parts.length < 2 || parts.some((p) => !p || p === '.' || p === '..')) return null;
  const root = Object.hasOwn(ROOT_OF, parts[0]) ? roots[ROOT_OF[parts[0]]] : null;
  return root ? join(root, ...parts) : null;
}

function isAppUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === SCHEME + ':' && parsed.host === APP_HOST;
  } catch {
    return false;
  }
}

module.exports = { resolveAsset, isAppUrl, SCHEME, APP_HOST };
