const RELEASES_URL = 'https://github.com/dimasekaadinandra25/meet-transcript/releases/latest';
const API_URL = 'https://api.github.com/repos/dimasekaadinandra25/meet-transcript/releases/latest';
const TIMEOUT_MS = 15000;

// Splits a version such as "v1.2.3" into its three numbers, or returns null if it is not a version.
const versionParts = (text) => {
  const match = String(text).match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return match ? [1, 2, 3].map((i) => Number(match[i] ?? 0)) : null;
};

// Tells whether the latest version is higher than the current one.
function isNewer(latest, current) {
  const latestParts = versionParts(latest);
  const currentParts = versionParts(current);
  if (!latestParts || !currentParts) return false;
  for (let i = 0; i < 3; i++) {
    if (latestParts[i] !== currentParts[i]) return latestParts[i] > currentParts[i];
  }
  return false;
}

// Asks GitHub for the latest release and tells whether it is newer than the running version.
async function checkForUpdate({ current, fetch: request = fetch }) {
  const res = await request(API_URL, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return { status: 'none' };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const release = await res.json();
  const latest = String(release.tag_name ?? '').replace(/^v/, '');
  return { status: isNewer(latest, current) ? 'available' : 'current', latest };
}

module.exports = { RELEASES_URL, isNewer, checkForUpdate };
