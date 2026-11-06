const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const HELPER_FILE = 'app-audio.exe';
const START_TIMEOUT_MS = 5000;
const FRAME_BYTES = 4;
const COULD_NOT_RECORD = 'That app could not be recorded. It may have closed, or this Windows version may not support it.';
const HELPER_OPTIONS = { windowsHide: true };

function createAppAudio({ dir, onData, onEnded, platform = process.platform, exists = existsSync, run = spawn, timer = setTimeout }) {
  const helper = join(dir, HELPER_FILE);
  let child;

  const available = () => platform === 'win32' && exists(helper);

  function ask(command) {
    return new Promise((resolve) => {
      const lister = run(helper, [command], { ...HELPER_OPTIONS, stdio: ['ignore', 'pipe', 'ignore'] });
      const parts = [];
      lister.once('error', () => resolve(null));
      lister.stdout.on('data', (part) => parts.push(part));
      lister.once('close', () => {
        try {
          const found = JSON.parse(Buffer.concat(parts).toString());
          resolve(found.filter((app) => Number.isInteger(app?.pid) && typeof app.name === 'string' && app.pid !== process.pid));
        } catch {
          resolve(null);
        }
      });
    });
  }

  const list = () => ask('list').then((found) => found ?? []);
  const micApps = () => ask('mic-apps');

  function stop() {
    const running = child;
    child = undefined;
    running?.kill();
  }

  function start(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return Promise.reject(new Error(COULD_NOT_RECORD));
    stop();
    return new Promise((resolve, reject) => {
      const capture = run(helper, ['capture', String(pid)], { ...HELPER_OPTIONS, stdio: ['pipe', 'pipe', 'pipe'] });
      child = capture;
      let ready = false;
      let carry = Buffer.alloc(0);
      const refuse = () => {
        if (ready) return;
        if (child === capture) stop();
        reject(new Error(COULD_NOT_RECORD));
      };
      timer(refuse, START_TIMEOUT_MS);
      capture.stderr.on('data', (text) => {
        if (ready || !String(text).includes('ready')) return;
        ready = true;
        resolve(true);
      });
      capture.stdout.on('data', (part) => {
        if (child !== capture) return;
        const all = Buffer.concat([carry, part]);
        const whole = all.length - (all.length % FRAME_BYTES);
        carry = all.subarray(whole);
        if (whole) onData(all.subarray(0, whole));
      });
      capture.once('error', refuse);
      capture.once('exit', () => {
        if (!ready) return refuse();
        if (child !== capture) return undefined;
        child = undefined;
        return onEnded();
      });
    });
  }

  return { available, list, micApps, start, stop };
}

module.exports = { createAppAudio };
