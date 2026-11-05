const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { createServer } = require('node:net');
const { availableParallelism } = require('node:os');
const { join } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

const SERVER_FILE = 'whisper-server.exe';
const MODEL_FILE = 'ggml-base-q5_1.bin';
const HOST = '127.0.0.1';
const API_PATH = '/v1/audio/transcriptions';
const READY_TIMEOUT_MS = 60000;
const READY_POLL_MS = 250;

const engineArgs = (model, port, threads) => [
  '-m', model, '--host', HOST, '--port', String(port), '--inference-path', API_PATH, '-t', String(threads), '-l', 'auto',
];

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, HOST, () => {
    const { port } = Object(probe.address());
    probe.close(() => resolve(port));
  });
});

function createEngine({ dir, run = spawn, request = fetch, findPort = freePort, wait = sleep, exists = existsSync }) {
  const server = join(dir, SERVER_FILE);
  const model = join(dir, MODEL_FILE);
  const threads = Math.max(1, Math.floor(availableParallelism() / 2));
  let child;
  let starting;

  const available = () => exists(server) && exists(model);

  function stop() {
    child?.kill();
    child = undefined;
    starting = undefined;
  }

  async function start() {
    const port = await findPort();
    const proc = run(server, engineArgs(model, port, threads), { cwd: dir, stdio: 'ignore', windowsHide: true });
    let failure = null;
    const ended = (reason) => {
      failure = reason;
      if (child !== proc) return;
      child = undefined;
      starting = undefined;
    };
    child = proc;
    proc.once('error', (e) => ended(e.message));
    proc.once('exit', (code) => ended(`exit code ${code}`));
    for (let waited = 0; waited < READY_TIMEOUT_MS; waited += READY_POLL_MS) {
      const up = await request(`http://${HOST}:${port}/health`, { signal: AbortSignal.timeout(READY_POLL_MS * 4) })
        .then((res) => res.ok, () => false);
      if (failure) throw new Error(`The built-in speech engine could not start (${failure}). It may need the Microsoft Visual C++ Redistributable.`);
      if (up) return `http://${HOST}:${port}/v1`;
      await wait(READY_POLL_MS);
    }
    if (child === proc) stop();
    throw new Error('The built-in speech engine did not start within 60 seconds.');
  }

  async function url() {
    if (!available()) throw new Error('The built-in speech engine is not installed.');
    starting ??= start().catch((e) => {
      starting = undefined;
      throw e;
    });
    return starting;
  }

  return { available, url, stop };
}

module.exports = { createEngine, engineArgs };
