import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { createMicWatch, appLabel } = createRequire(import.meta.url)('../main/micwatch.js');

function setup({ watching = () => true } = {}) {
  let apps = [];
  const asked = [];
  const watch = createMicWatch({ list: async () => apps, shouldWatch: watching, onDetected: (name) => asked.push(name) });
  return { watch, asked, use: (...names) => { apps = names.map((name) => ({ pid: 1, name, active: true })); } };
}

test('an app already holding the microphone at the start, such as Discord, does not ask', async () => {
  const { watch, asked, use } = setup();
  use('Discord.exe');
  await watch.poll();
  await watch.poll();
  await watch.poll();
  assert.deepEqual(asked, []);
});

test('an app must hold the microphone for two checks before asking', async () => {
  const { watch, asked, use } = setup();
  await watch.poll();
  use('Zoom.exe');
  await watch.poll();
  assert.deepEqual(asked, []);
  await watch.poll();
  assert.deepEqual(asked, ['Zoom.exe']);
});

test('a quick microphone test does not ask', async () => {
  const { watch, asked, use } = setup();
  await watch.poll();
  use('Zoom.exe');
  await watch.poll();
  use();
  await watch.poll();
  use('Zoom.exe');
  await watch.poll();
  assert.deepEqual(asked, []);
});

test('it asks once per use of the microphone', async () => {
  const { watch, asked, use } = setup();
  await watch.poll();
  use('Zoom.exe');
  await watch.poll();
  await watch.poll();
  await watch.poll();
  assert.deepEqual(asked, ['Zoom.exe']);
  use();
  await watch.poll();
  use('Zoom.exe');
  await watch.poll();
  await watch.poll();
  assert.deepEqual(asked, ['Zoom.exe', 'Zoom.exe']);
});

test('an inactive session does not count', async () => {
  const asked = [];
  let apps = [];
  const watch = createMicWatch({ list: async () => apps, shouldWatch: () => true, onDetected: (name) => asked.push(name) });
  await watch.poll();
  apps = [{ pid: 1, name: 'Zoom.exe', active: false }];
  await watch.poll();
  await watch.poll();
  assert.deepEqual(asked, []);
});

test('it stays quiet while watching is off, and does not ask again after a recording', async () => {
  let on = true;
  const { watch, asked, use } = setup({ watching: () => on });
  await watch.poll();
  on = false;
  use('Zoom.exe');
  await watch.poll();
  await watch.poll();
  assert.deepEqual(asked, []);
  on = true;
  await watch.poll();
  await watch.poll();
  assert.deepEqual(asked, []);
  use();
  await watch.poll();
  use('Zoom.exe');
  await watch.poll();
  await watch.poll();
  assert.deepEqual(asked, ['Zoom.exe']);
});

test('a failed check changes nothing', async () => {
  let apps = [];
  const asked = [];
  const watch = createMicWatch({ list: async () => apps, shouldWatch: () => true, onDetected: (name) => asked.push(name) });
  apps = null;
  await watch.poll();
  apps = [{ pid: 1, name: 'Discord.exe', active: true }];
  await watch.poll();
  await watch.poll();
  assert.deepEqual(asked, []);
  apps = null;
  await watch.poll();
  apps = [{ pid: 1, name: 'Discord.exe', active: true }];
  await watch.poll();
  await watch.poll();
  assert.deepEqual(asked, []);
});

test('a slow helper does not stack up checks', async () => {
  let calls = 0;
  let finish;
  const watch = createMicWatch({ list: () => { calls++; return new Promise((done) => { finish = done; }); }, shouldWatch: () => true, onDetected() {} });
  watch.poll();
  watch.poll();
  assert.equal(calls, 1);
  finish([]);
});

test('app names read well', () => {
  assert.equal(appLabel('Zoom.exe'), 'Zoom');
  assert.equal(appLabel('ms-teams.EXE'), 'ms-teams');
});
