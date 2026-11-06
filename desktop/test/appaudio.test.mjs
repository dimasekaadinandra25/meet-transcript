import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAppAudio } = require('../main/appaudio.js');
require('../renderer/app-audio.js');
const { createPcmSource } = globalThis.MeetAppAudio;

function setup({ platform = 'win32', exists = () => true, timeout = () => {} } = {}) {
  const children = [];
  const data = [];
  const ended = [];
  const audio = createAppAudio({
    dir: 'C:/helper',
    platform,
    exists,
    onData: (bytes) => data.push(bytes),
    onEnded: () => ended.push(true),
    timer: timeout,
    run: (file, args) => {
      const child = Object.assign(new EventEmitter(), {
        file, args, killed: 0, kill() { this.killed++; },
        stdout: new EventEmitter(), stderr: new EventEmitter(),
      });
      children.push(child);
      return child;
    },
  });
  return { audio, children, data, ended };
}

const started = async (t, pid = 42) => {
  const running = t.audio.start(pid);
  t.children.at(-1).stderr.emit('data', Buffer.from('ready\n'));
  await running;
  return t.children.at(-1);
};

test('it is available only on Windows with the helper present', () => {
  assert.equal(setup().audio.available(), true);
  assert.equal(setup({ platform: 'darwin' }).audio.available(), false);
  assert.equal(setup({ exists: () => false }).audio.available(), false);
});

test('the app list keeps valid entries and hides this app', async () => {
  const t = setup();
  const listing = t.audio.list();
  const child = t.children[0];
  assert.deepEqual(child.args, ['list']);
  child.stdout.emit('data', Buffer.from(JSON.stringify([
    { pid: 12, name: 'Zoom.exe', active: true },
    { pid: process.pid, name: 'Transcripables.exe', active: true },
    { pid: 'x', name: 'Jahat.exe' },
    { pid: 13 },
  ])));
  child.emit('close', 0);
  assert.deepEqual(await listing, [{ pid: 12, name: 'Zoom.exe', active: true }]);
});

test('a broken app list gives an empty list', async () => {
  const t = setup();
  const listing = t.audio.list();
  t.children[0].stdout.emit('data', Buffer.from('bukan json'));
  t.children[0].emit('close', 1);
  assert.deepEqual(await listing, []);
});

test('only a real process number can be recorded', async () => {
  for (const pid of ['1 & calc', -1, 0, 1.5, null]) {
    const t = setup();
    await assert.rejects(t.audio.start(pid), /could not be recorded/);
    assert.equal(t.children.length, 0);
  }
});

test('recording starts when the helper says ready', async () => {
  const t = setup();
  const child = await started(t);
  assert.deepEqual(child.args, ['capture', '42']);
});

test('a helper that quits before ready reports the app could not be recorded', async () => {
  const t = setup();
  const running = t.audio.start(42);
  t.children[0].emit('exit', 1);
  await assert.rejects(running, /could not be recorded/);
  assert.deepEqual(t.ended, []);
});

test('a helper that never gets ready is stopped', async () => {
  let expire;
  const t = setup({ timeout: (fn) => { expire = fn; } });
  const running = t.audio.start(42);
  expire();
  await assert.rejects(running, /could not be recorded/);
  assert.equal(t.children[0].killed, 1);
});

test('sound is passed on in whole frames', async () => {
  const t = setup();
  const child = await started(t);
  child.stdout.emit('data', Buffer.from([1, 2, 3, 4, 5, 6]));
  child.stdout.emit('data', Buffer.from([7, 8, 9]));
  assert.deepEqual(t.data.map((b) => [...b]), [[1, 2, 3, 4], [5, 6, 7, 8]]);
});

test('you are told when the chosen app closes', async () => {
  const t = setup();
  const child = await started(t);
  child.emit('exit', 3);
  assert.equal(t.ended.length, 1);
});

test('stopping is silent and ends the helper', async () => {
  const t = setup();
  const child = await started(t);
  t.audio.stop();
  child.emit('exit', 0);
  assert.equal(child.killed, 1);
  assert.deepEqual(t.ended, []);
});

test('starting again replaces the running helper', async () => {
  const t = setup();
  const first = await started(t, 1);
  await started(t, 2);
  assert.equal(first.killed, 1);
  first.stdout.emit('data', Buffer.from([1, 2, 3, 4]));
  assert.deepEqual(t.data, []);
});

function fakeContext() {
  const played = [];
  const output = { connected: [] };
  return {
    played,
    output,
    currentTime: 10,
    createGain: () => output,
    createBuffer: (channels, frames, rate) => {
      const data = Array.from({ length: channels }, () => new Float32Array(frames));
      return { frames, rate, duration: frames / rate, getChannelData: (i) => data[i] };
    },
    createBufferSource() {
      const source = { connect(to) { source.to = to; }, start(at) { played.push({ at, buffer: source.buffer, to: source.to }); } };
      return source;
    },
  };
}

const pcm = (...samples) => {
  const view = new DataView(new ArrayBuffer(samples.length * 2));
  samples.forEach((sample, i) => view.setInt16(i * 2, sample, true));
  return new Uint8Array(view.buffer);
};

test('sound becomes left and right channels at the helper rate', () => {
  const ctx = fakeContext();
  const source = createPcmSource(ctx);
  source.push(pcm(16384, -16384, 32767, 0));
  const { buffer } = ctx.played[0];
  assert.equal(buffer.rate, 48000);
  assert.deepEqual([...buffer.getChannelData(0)], [0.5, 32767 / 32768]);
  assert.deepEqual([...buffer.getChannelData(1)], [-0.5, 0]);
});

test('parts play one after another without a gap', () => {
  const ctx = fakeContext();
  const source = createPcmSource(ctx);
  source.push(new Uint8Array(4800 * 4));
  source.push(new Uint8Array(4800 * 4));
  assert.equal(ctx.played[0].at, 10.2);
  assert.ok(Math.abs(ctx.played[1].at - 10.3) < 1e-9);
  assert.equal(ctx.played[0].to, source.node);
});

test('a slightly late part joins on without a gap', () => {
  const ctx = fakeContext();
  const source = createPcmSource(ctx);
  source.push(new Uint8Array(4800 * 4));
  ctx.currentTime = 10.15;
  source.push(new Uint8Array(4800 * 4));
  assert.ok(Math.abs(ctx.played[1].at - 10.3) < 1e-9);
});

test('sound that arrives late catches up instead of drifting', () => {
  const ctx = fakeContext();
  const source = createPcmSource(ctx);
  source.push(new Uint8Array(4800 * 4));
  ctx.currentTime = 20;
  source.push(new Uint8Array(4800 * 4));
  assert.equal(ctx.played[1].at, 20.2);
});

test('a backlog is dropped so the recording stays in time', () => {
  const ctx = fakeContext();
  const source = createPcmSource(ctx);
  for (let i = 0; i < 40; i++) source.push(new Uint8Array(4800 * 4));
  assert.ok(ctx.played.at(-1).at <= ctx.currentTime + 2.2);
  assert.ok(ctx.played.length < 40);
});

test('an empty part plays nothing', () => {
  const ctx = fakeContext();
  createPcmSource(ctx).push(new Uint8Array(0));
  assert.deepEqual(ctx.played, []);
});

test('apps using the microphone are read from the helper, without this app', async () => {
  const { audio, children } = setup();
  const found = audio.micApps();
  assert.deepEqual(children[0].args, ['mic-apps']);
  children[0].stdout.emit('data', Buffer.from(JSON.stringify([{ pid: 9, name: 'Zoom.exe', active: true }, { pid: process.pid, name: 'me.exe', active: true }])));
  children[0].emit('close');
  assert.deepEqual(await found, [{ pid: 9, name: 'Zoom.exe', active: true }]);
});

test('a failed microphone check is reported as unknown, not as nobody using it', async () => {
  const { audio, children } = setup();
  const found = audio.micApps();
  children[0].emit('error', new Error('gone'));
  assert.equal(await found, null);
  const listed = audio.list();
  children[1].emit('error', new Error('gone'));
  assert.deepEqual(await listed, []);
});
