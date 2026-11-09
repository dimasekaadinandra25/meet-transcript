const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { createServer } = require('node:net');
const { availableParallelism } = require('node:os');
const { join, relative } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

const serverFile = (platform) => (platform === 'win32' ? 'whisper-server.exe' : 'whisper-server');
const MODEL_FILE = 'ggml-base-q5_1.bin';
const HOST = '127.0.0.1';
const API_PATH = '/v1/audio/transcriptions';
const READY_TIMEOUT_MS = 300000;
const READY_POLL_MS = 250;
const GUARD_POLL_SECONDS = 2;

function guardCommand(platform, app, engine, root = process.env.SystemRoot ?? 'C:\\Windows') {
  const [a, e] = [Number(app), Number(engine)];
  if (platform === 'win32') {
    const alive = (pid) => `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue)`;
    const script = `while (${alive(e)} -and ${alive(a)}) { Start-Sleep -Seconds ${GUARD_POLL_SECONDS} }; if (-not ${alive(a)}) { Stop-Process -Id ${e} -Force -ErrorAction SilentlyContinue }`;
    return [join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script]];
  }
  const alive = (pid) => `kill -0 ${pid} 2>/dev/null`;
  return ['/bin/sh', ['-c', `while ${alive(e)} && ${alive(a)}; do sleep ${GUARD_POLL_SECONDS}; done; ${alive(a)} || kill ${e} 2>/dev/null`]];
}

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

function guardEngine(enginePid) {
  const [file, args] = guardCommand(process.platform, process.pid, enginePid);
  spawn(file, args, {
    stdio: 'ignore',
    windowsHide: true,
  }).on('error', (e) => console.error(e));
}

function createEngine({ dir, platform = process.platform, run = spawn, request = fetch, findPort = freePort, wait = sleep, exists = existsSync, guard = guardEngine }) {
  const server = join(dir, serverFile(platform));
  const standardModel = join(dir, MODEL_FILE);
  let model = standardModel;
  const threads = Math.max(1, Math.floor(availableParallelism() / 2));
  let child;
  let starting;

  const available = () => exists(server) && exists(standardModel);

  function stop() {
    child?.kill();
    child = undefined;
    starting = undefined;
  }

  function useModel(path) {
    const next = path ?? standardModel;
    if (next === model) return;
    model = next;
    stop();
  }

  async function start() {
    const port = await findPort();
    const proc = run(server, engineArgs(relative(dir, model), port, threads), { cwd: dir, stdio: 'ignore', windowsHide: true });
    let failure = null;
    const ended = (reason) => {
      failure = reason;
      if (child !== proc) return;
      child = undefined;
      starting = undefined;
    };
    child = proc;
    if (proc.pid) guard(proc.pid);
    proc.once('error', (e) => ended(e.message));
    proc.once('exit', (code) => ended(`exit code ${code}`));
    for (let waited = 0; waited < READY_TIMEOUT_MS; waited += READY_POLL_MS) {
      const up = await request(`http://${HOST}:${port}/health`, { signal: AbortSignal.timeout(READY_POLL_MS * 4) })
        .then((res) => res.ok, () => false);
      if (failure) throw new Error(`The built-in speech engine could not start (${failure}).${platform === 'win32' ? ' It may need the Microsoft Visual C++ Redistributable.' : ''}`);
      if (up) return `http://${HOST}:${port}/v1`;
      await wait(READY_POLL_MS);
    }
    if (child === proc) stop();
    throw new Error('The built-in speech engine did not start within 5 minutes.');
  }

  async function url() {
    if (!available()) throw new Error('The built-in speech engine is not installed.');
    if (starting) return starting;
    const attempt = start().catch((e) => {
      if (starting === attempt) starting = undefined;
      throw e;
    });
    starting = attempt;
    return attempt;
  }

  return { available, url, stop, useModel };
}

module.exports = { createEngine, engineArgs, guardCommand };
