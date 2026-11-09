const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { createServer } = require('node:net');
const { availableParallelism } = require('node:os');
const { join, relative } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

// Returns the whisper server program name for the given platform.
const serverFile = (platform) => (platform === 'win32' ? 'whisper-server.exe' : 'whisper-server');
const MODEL_FILE = 'ggml-base-q5_1.bin';
const HOST = '127.0.0.1';
const API_PATH = '/v1/audio/transcriptions';
const READY_TIMEOUT_MS = 300000;
const READY_POLL_MS = 250;
const GUARD_POLL_SECONDS = 2;

// Builds a shell command that stops the speech engine once the app process is gone.
function guardCommand(platform, app, engine, root = process.env.SystemRoot ?? 'C:\\Windows') {
  const appPid = Number(app);
  const enginePid = Number(engine);
  if (platform === 'win32') {
    // Returns a PowerShell test that is true while the process is running.
    const alive = (pid) => `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue)`;
    const waitLoop = `while (${alive(enginePid)} -and ${alive(appPid)}) { Start-Sleep -Seconds ${GUARD_POLL_SECONDS} }`;
    const stopEngine = `if (-not ${alive(appPid)}) { Stop-Process -Id ${enginePid} -Force -ErrorAction SilentlyContinue }`;
    const powershell = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return { file: powershell, args: ['-NoProfile', '-NonInteractive', '-Command', `${waitLoop}; ${stopEngine}`] };
  }
  // Returns a shell test that succeeds while the process is running.
  const alive = (pid) => `kill -0 ${pid} 2>/dev/null`;
  const waitLoop = `while ${alive(enginePid)} && ${alive(appPid)}; do sleep ${GUARD_POLL_SECONDS}; done`;
  const stopEngine = `${alive(appPid)} || kill ${enginePid} 2>/dev/null`;
  return { file: '/bin/sh', args: ['-c', `${waitLoop}; ${stopEngine}`] };
}

// Lists the command-line arguments for starting the whisper server.
const engineArgs = (model, port, threads) => [
  '-m', model,
  '--host', HOST,
  '--port', String(port),
  '--inference-path', API_PATH,
  '-t', String(threads),
  '-l', 'auto',
];

// Finds a free local port by briefly listening on port 0.
const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, HOST, () => {
    const { port } = Object(probe.address());
    probe.close(() => resolve(port));
  });
});

// Starts a background watcher that kills the engine if this app exits without stopping it.
function guardEngine(enginePid) {
  const { file, args } = guardCommand(process.platform, process.pid, enginePid);
  spawn(file, args, {
    stdio: 'ignore',
    windowsHide: true,
  }).on('error', (e) => console.error(e));
}

// Creates the controller that starts, reuses and stops the local whisper speech engine.
function createEngine({
  dir,
  platform = process.platform,
  run = spawn,
  request = fetch,
  findPort = freePort,
  wait = sleep,
  exists = existsSync,
  guard = guardEngine,
}) {
  const server = join(dir, serverFile(platform));
  const standardModel = join(dir, MODEL_FILE);
  let model = standardModel;
  const threads = Math.max(1, Math.floor(availableParallelism() / 2));
  let child;
  let starting;

  // Tells whether both the server program and the standard model are installed.
  const available = () => exists(server) && exists(standardModel);

  // Stops the running engine and forgets any start in progress.
  function stop() {
    child?.kill();
    child = undefined;
    starting = undefined;
  }

  // Switches to another model file, restarting the engine on next use if it changed.
  function useModel(path) {
    const next = path ?? standardModel;
    if (next === model) return;
    model = next;
    stop();
  }

  // Launches the server and waits until it answers its health check, returning its API address.
  async function start() {
    const port = await findPort();
    const args = engineArgs(relative(dir, model), port, threads);
    const proc = run(server, args, { cwd: dir, stdio: 'ignore', windowsHide: true });
    let failure = null;
    // Records why the process ended and clears it if it is still the current engine.
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
      if (failure) {
        const hint = platform === 'win32' ? ' It may need the Microsoft Visual C++ Redistributable.' : '';
        throw new Error(`The built-in speech engine could not start (${failure}).${hint}`);
      }
      if (up) return `http://${HOST}:${port}/v1`;
      await wait(READY_POLL_MS);
    }
    if (child === proc) stop();
    throw new Error('The built-in speech engine did not start within 5 minutes.');
  }

  // Returns the engine's API address, starting the engine once if it is not running yet.
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
