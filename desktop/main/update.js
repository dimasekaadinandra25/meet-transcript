const RELEASES_URL = 'https://github.com/dimasekaadinandra25/meet-transcript/releases/latest';
const API_URL = 'https://api.github.com/repos/dimasekaadinandra25/meet-transcript/releases/latest';
const TIMEOUT_MS = 15000;

const versionParts = (text) => {
  const match = String(text).match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return match ? [1, 2, 3].map((i) => Number(match[i] ?? 0)) : null;
};

function isNewer(latest, current) {
  const [a, b] = [versionParts(latest), versionParts(current)];
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

async function checkForUpdate({ current, fetch: request = fetch }) {
  const res = await request(API_URL, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return { status: 'none' };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const latest = String((await res.json()).tag_name ?? '').replace(/^v/, '');
  return { status: isNewer(latest, current) ? 'available' : 'current', latest };
}

module.exports = { RELEASES_URL, isNewer, checkForUpdate };
