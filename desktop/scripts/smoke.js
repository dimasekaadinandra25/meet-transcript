const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

const PORT = 9333;
const WAIT_TRIES = 60;
const WAIT_MS = 1000;
const CHECK = `(async () => JSON.stringify({
  lib: typeof MeetMerge,
  host: typeof PanelHost,
  nav: !!document.querySelector('nav button[data-tab="live"]'),
  engine: await window.desktop.engine.available(),
  appSound: await window.desktop.appAudio.available(),
  loginItem: (await window.desktop.loginItem()).available,
}))()`;
const EXPECTED = JSON.stringify({
  lib: 'object',
  host: 'object',
  nav: true,
  engine: true,
  appSound: process.platform === 'win32',
  loginItem: true,
});

// Waits for the app window to show up in the remote debugging list and returns it.
async function appPage() {
  for (let i = 0; i < WAIT_TRIES; i++) {
    const pages = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((res) => res.json(), () => []);
    const page = pages.find((entry) => entry.type === 'page' && entry.url.endsWith('/renderer/index.html'));
    if (page) return page;
    await sleep(WAIT_MS);
  }
  throw new Error('The app window did not open.');
}

// Runs a JavaScript expression in the app window through the debugging protocol and returns its value.
function evaluate(page, expression) {
  return new Promise((done, fail) => {
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    socket.onopen = () => socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true },
    }));
    socket.onerror = () => fail(new Error('Could not talk to the app.'));
    socket.onclose = () => fail(new Error('The app closed the connection.'));
    socket.onmessage = ({ data }) => {
      const { result } = JSON.parse(data);
      socket.close();
      done(result?.result?.value);
    };
  });
}

// Starts the packaged app with a fresh profile and checks that its window loads completely.
async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'transcripables-smoke-'));
  const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`];
  const app = spawn(resolve(process.argv[2]), args, { stdio: 'ignore' });
  try {
    const page = await appPage();
    let answer;
    for (let i = 0; i < WAIT_TRIES && answer !== EXPECTED; i++) {
      answer = await evaluate(page, CHECK);
      if (answer !== EXPECTED) await sleep(WAIT_MS);
    }
    console.log(answer);
    if (answer !== EXPECTED) throw new Error('The app opened but did not load fully.');
  } finally {
    app.kill();
    await sleep(WAIT_MS * 2);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (e) {
      console.warn(`Could not remove the temporary profile: ${e.message}`);
    }
  }
}

main().then(() => process.exit(0), (e) => {
  console.error(e.message);
  process.exit(1);
});
