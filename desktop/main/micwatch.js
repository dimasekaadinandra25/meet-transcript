const POLL_MS = 10000;

const appLabel = (name) => name.replace(/\.exe$/i, '');

function createMicWatch({ list, shouldWatch, onDetected, timer = setInterval }) {
  let previous = new Set();
  let asked = new Set();
  let polling = false;
  let started = false;

  async function check() {
    if (!shouldWatch()) {
      previous = new Set();
      started = false;
      return;
    }
    const found = await list();
    if (!found) return;
    const current = new Set(found.filter((app) => app.active).map((app) => app.name));
    if (!started) {
      started = true;
      asked = new Set(current);
    }
    for (const name of current) {
      if (previous.has(name) && !asked.has(name)) {
        asked.add(name);
        onDetected(name);
      }
    }
    asked = new Set([...asked].filter((name) => current.has(name)));
    previous = current;
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      await check();
    } finally {
      polling = false;
    }
  }

  return { poll, start: () => timer(poll, POLL_MS) };
}

module.exports = { appLabel, createMicWatch };
