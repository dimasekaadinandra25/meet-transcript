import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createEngine, engineArgs } = require('../main/engine.js');

const DIR = join('C:', 'engine');

function setup({ exists = () => true, healthy = () => true } = {}) {
  const started = [];
  const engine = createEngine({
    dir: DIR,
    exists,
    run: (file, args, options) => {
      const child = Object.assign(new EventEmitter(), { killed: 0, kill() { this.killed++; } });
      started.push({ file, args, options, child });
      return child;
    },
    request: async () => ({ ok: healthy() }),
    findPort: async () => 5000 + started.length,
    wait: () => new Promise((resolve) => setImmediate(resolve)),
  });
  return { engine, started };
}

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
