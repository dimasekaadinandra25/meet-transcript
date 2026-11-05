const { join } = require('node:path');

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

module.exports = { resolveAsset };
