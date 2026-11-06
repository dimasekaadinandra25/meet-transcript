import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createEngine, engineArgs, GUARD_SCRIPT } = require('../main/engine.js');

const DIR = join('C:', 'engine');

function setup({ exists = () => true, healthy = () => true, platform = 'win32' } = {}) {
  const started = [];
  const guarded = [];
  const engine = createEngine({
    dir: DIR,
    platform,
    exists,
    guard: (pid) => guarded.push(pid),
    run: (file, args, options) => {
      const child = Object.assign(new EventEmitter(), { pid: 900 + started.length, killed: 0, kill() { this.killed++; } });
      started.push({ file, args, options, child });
      return child;
    },
    request: async () => ({ ok: healthy() }),
    findPort: async () => 5000 + started.length,
    wait: () => new Promise((resolve) => setImmediate(resolve)),
  });
  return { engine, started, guarded };
}

test('on a Mac the engine program has no .exe', async () => {
  const { engine, started } = setup({ platform: 'darwin' });
  await engine.url();
  assert.equal(started[0].file, join(DIR, 'whisper-server'));
});

test('a chosen model is used from the next start, and the old engine stops', async () => {
  const { engine, started } = setup();
  await engine.url();
  assert.equal(started[0].args[1], join(DIR, 'ggml-base-q5_1.bin'));
  engine.useModel('C:/models/small.bin');
  assert.equal(started[0].child.killed, 1);
  await engine.url();
  assert.equal(started[1].args[1], 'C:/models/small.bin');
});

test('choosing the same model again keeps the engine running', async () => {
  const { engine, started } = setup();
  await engine.url();
  engine.useModel(null);
  assert.equal(started[0].child.killed, 0);
});

test('engine arguments stay on this computer and use the OpenAI path', () => {
  const args = engineArgs('model.bin', 5000, 4);
  assert.deepEqual(args, ['-m', 'model.bin', '--host', '127.0.0.1', '--port', '5000', '--inference-path', '/v1/audio/transcriptions', '-t', '4', '-l', 'auto']);
});

test('engine is available only with both the program and the model', () => {
  const seen = [];
  const { engine } = setup({ exists: (file) => { seen.push(file); return !file.endsWith('.bin'); } });
  assert.equal(engine.available(), false);
  assert.ok(seen.some((file) => file.endsWith('whisper-server.exe')));
});

test('a missing engine gives a clear error and starts nothing', async () => {
  const { engine, started } = setup({ exists: () => false });
  await assert.rejects(engine.url(), /not installed/);
  assert.equal(started.length, 0);
});

test('engine starts once and returns its local address', async () => {
  const { engine, started } = setup();
  const [first, second] = await Promise.all([engine.url(), engine.url()]);
  assert.equal(first, 'http://127.0.0.1:5000/v1');
  assert.equal(second, first);
  assert.equal(await engine.url(), first);
  assert.equal(started.length, 1);
  assert.equal(started[0].file, join(DIR, 'whisper-server.exe'));
  assert.equal(started[0].options.windowsHide, true);
  assert.equal(started[0].options.shell, undefined);
});

test('engine restarts after it stops by itself', async () => {
  const { engine, started } = setup();
  await engine.url();
  started[0].child.emit('exit', 1);
  assert.equal(await engine.url(), 'http://127.0.0.1:5001/v1');
  assert.equal(started.length, 2);
});

test('a program that cannot run reports why', async () => {
  const { engine, started } = setup({ healthy: () => false });
  const pending = engine.url();
  await new Promise((resolve) => setImmediate(resolve));
  started[0].child.emit('exit', 3221225781);
  await assert.rejects(pending, /could not start \(exit code 3221225781\).*Visual C\+\+/);
});

test('an engine that never answers is stopped', async () => {
  const { engine, started } = setup({ healthy: () => false });
  await assert.rejects(engine.url(), /did not start within 60 seconds/);
  assert.equal(started[0].child.killed, 1);
});

test('stop ends the engine, and the next request starts a new one', async () => {
  const { engine, started } = setup();
  await engine.url();
  engine.stop();
  assert.equal(started[0].child.killed, 1);
  await engine.url();
  assert.equal(started.length, 2);
  engine.stop();
  engine.stop();
  assert.equal(started[1].child.killed, 1);
});

test('a failed start does not forget the engine that replaced it', async () => {
  let healthy = false;
  const { engine, started } = setup({ healthy: () => healthy });
  const first = engine.url();
  await new Promise((resolve) => setImmediate(resolve));
  started[0].child.emit('exit', 1);
  healthy = true;
  const second = engine.url();
  await assert.rejects(first, /could not start/);
  assert.equal(await second, 'http://127.0.0.1:5001/v1');
  assert.equal(await engine.url(), 'http://127.0.0.1:5001/v1');
  assert.equal(started.length, 2);
});

test('every engine started gets a guard', async () => {
  const { engine, guarded } = setup();
  await engine.url();
  assert.deepEqual(guarded, [900]);
});

const IDLE_PROGRAM = 'setInterval(() => {}, 1000)';
const isRunning = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitUntilStopped(pid) {
  for (let i = 0; i < 60; i++) {
    if (!isRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function startProgram(program, ...args) {
  return spawn(process.execPath, ['-e', program, ...args.map(String)], { stdio: 'ignore', windowsHide: true });
}

test('the guard ends the engine when the app dies without warning', async () => {
  const app = startProgram(IDLE_PROGRAM);
  const fakeEngine = startProgram(IDLE_PROGRAM);
  const guard = startProgram(GUARD_SCRIPT, app.pid, fakeEngine.pid);
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(isRunning(fakeEngine.pid), true);
    app.kill('SIGKILL');
    assert.equal(await waitUntilStopped(fakeEngine.pid), true, 'engine kept running');
    assert.equal(await waitUntilStopped(guard.pid), true, 'guard kept running');
  } finally {
    for (const child of [app, fakeEngine, guard]) child.kill();
  }
});

test('the guard ends itself when the engine stops first', async () => {
  const app = startProgram(IDLE_PROGRAM);
  const fakeEngine = startProgram(IDLE_PROGRAM);
  const guard = startProgram(GUARD_SCRIPT, app.pid, fakeEngine.pid);
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    fakeEngine.kill();
    assert.equal(await waitUntilStopped(guard.pid), true, 'guard kept running');
    assert.equal(isRunning(app.pid), true);
  } finally {
    for (const child of [app, fakeEngine, guard]) child.kill();
  }
});
