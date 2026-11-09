const POLL_MS = 10000;

// Turns a process name such as "Zoom.exe" into a label such as "Zoom".
const appLabel = (name) => name.replace(/\.exe$/i, '');

// Creates a watcher that notices when an app keeps using the microphone and offers to record it.
function createMicWatch({ list, shouldWatch, onDetected, timer = setInterval }) {
  let previous = new Set();
  let asked = new Set();
  let polling = false;
  let started = false;

  // Compares the apps using the microphone with the last check and reports newly active ones.
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

  // Runs one check, skipping it if the previous check is still running.
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
