import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const SCRIPTS = ['../content/session.js', '../lib/merge.js', '../lib/i18n.js', '../background/service-worker.js'].map(read);
const MEET = 'abc-defg-hij';
const flush = () => new Promise((done) => setTimeout(done, 5));

function loadSw({ offscreen = null, store = {}, firefox = false, shortcut = 'Alt+Shift+R' } = {}) {
  const handlers = [];
  const connects = [];
  const sent = [];
  const stateReply = {};
  stateReply.promise = new Promise((resolve) => { stateReply.resolve = resolve; });
  const chrome = {
    action: { setBadgeBackgroundColor() {}, setBadgeTextColor() {}, setBadgeText() {}, setTitle() {} },
    runtime: {
      onMessage: { addListener: (f) => handlers.push(f) },
      onConnect: { addListener: (f) => connects.push(f) },
      onInstalled: { addListener() {} },
      getContexts: async () => (offscreen ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []),
      async sendMessage(msg) {
        sent.push(msg);
        if (msg.target !== 'offscreen') return undefined;
        if (msg.op === 'state') return stateReply.promise;
        return { ok: true };
      },
      getURL: (p) => p,
    },
    storage: { local: {
      get: async (keys) => {
        const out = {};
        for (const k of keys == null ? Object.keys(store) : [].concat(keys)) if (k in store) out[k] = structuredClone(store[k]);
        return out;
      },
      set: async (o) => { Object.assign(store, structuredClone(o)); },
      remove: async (k) => { for (const x of [].concat(k)) delete store[x]; },
    }, onChanged: { addListener() {} } },
    offscreen: { closeDocument: async () => {}, createDocument: async () => {} },
    tabs: { create: async () => ({ id: 7 }), onUpdated: { addListener() {}, removeListener() {} }, onRemoved: { addListener() {}, removeListener() {} } },
    commands: { onCommand: { addListener() {} }, getAll: async () => [{ name: 'rec-start', shortcut }] },
    ...(firefox ? {} : { tabCapture: {}, contextMenus: { removeAll() {}, create() {}, update: async () => {}, onClicked: { addListener() {} } } }),
  };
  let pings = 0;
  chrome.runtime.getPlatformInfo = async () => { pings++; };
  const ctx = vm.createContext({ chrome, console, URL, setTimeout: (f, ms) => { const t = setTimeout(f, ms === 20000 ? 10 : ms); t.unref(); return t; }, clearTimeout });
  vm.runInContext('globalThis.MeetAudioStore = {}; globalThis.MeetStt = {}; globalThis.MeetOpenAI = { DEFAULT_MODEL: "m" };', ctx);
  ctx.removed = [];
  ctx.MeetAudioStore.listRecordings = async () => [];
  ctx.MeetAudioStore.retagAudioMeta = async () => {};
  ctx.MeetAudioStore.removeRecordings = async (id) => { ctx.removed.push(id); };
  ctx.MeetStt.sttEndpoint = () => ({ mode: 'http', baseUrl: 'http://localhost:1/v1', apiKey: '', model: 'whisper-1', language: '' });
  for (const script of SCRIPTS) vm.runInContext(script, ctx);
  const ask = (msg) => new Promise((resolve) => {
    for (const f of handlers) if (f(msg, {}, resolve) === true) return;
    resolve(undefined);
  });
  const connect = (tabId = 5) => {
    const posted = [];
    const msgFns = [];
    const gone = [];
    const port = { name: 'captions', sender: { tab: { id: tabId } }, postMessage: (m) => posted.push(m),
      onMessage: { addListener: (f) => msgFns.push(f) }, onDisconnect: { addListener: (f) => gone.push(f) } };
    for (const f of connects) f(port);
    return { posted, send: (m) => msgFns.forEach((f) => f(m)), disconnect: () => gone.forEach((f) => f()) };
  };
  const setNow = (now) => vm.runInContext(`Date.now = () => ${now};`, ctx);
  const finishWaking = () => stateReply.resolve(offscreen ? { ok: true, ...offscreen } : { ok: false });
  const useModel = (fn) => { ctx.MeetOpenAI.generateMoM = fn; };
  return { ask, connect, setNow, finishWaking, store, sent, removed: ctx.removed, useModel, pings: () => pings };
}

const RECORDING = { recording: true, transcribing: false, meetingId: 'discord-1-2', tabId: 42, autoStt: false };

test('a mark pressed while the worker wakes reaches the running recording', async () => {
  const sw = loadSw({ offscreen: RECORDING, store: { meetings: ['discord-1-2'], 'meeting:discord-1-2': { id: 'discord-1-2', title: 'x', startedAt: 1, segments: [] } } });
  const answer = sw.ask({ type: 'mark-moment' });
  sw.finishWaking();
  assert.equal((await answer).ok, true);
  assert.equal(sw.store['meeting:discord-1-2'].marks.length, 1);
});

test('a running recording cannot be deleted while the worker wakes', async () => {
  const sw = loadSw({ offscreen: RECORDING, store: { meetings: ['discord-1-2'], 'meeting:discord-1-2': { id: 'discord-1-2', title: 'x', startedAt: 1, segments: [] } } });
  const answer = sw.ask({ type: 'delete-meeting', id: 'discord-1-2' });
  sw.finishWaking();
  assert.match((await answer).error, /still running/);
  assert.deepEqual(sw.removed, []);
  assert.ok(sw.store['meeting:discord-1-2']);
});

test('retranscribing during a recording keeps the recording visible', async () => {
  const sw = loadSw({ offscreen: RECORDING });
  const answer = sw.ask({ type: 'regenerate-transcript', id: 'other', recId: 5 });
  sw.finishWaking();
  assert.match((await answer).error, /still running/);
  const state = await sw.ask({ type: 'get-active' });
  assert.equal(state.rec.recording, true);
  assert.equal(state.rec.meetingId, 'discord-1-2');
});

test('a file cannot be imported during a recording', async () => {
  const sw = loadSw({ offscreen: RECORDING });
  const answer = sw.ask({ type: 'add-imported-meeting', title: 'x', baseTime: 5 });
  sw.finishWaking();
  assert.match((await answer).error, /Stop the recording/);
  assert.equal(sw.store.meetings, undefined);
});

async function inCall(options = {}) {
  const sw = loadSw({ store: { settings: { transcriptSource: 'caption' } }, ...options });
  sw.finishWaking();
  await flush();
  sw.setNow(1000000);
  const tab = sw.connect();
  const status = async (captionsOn, now) => {
    sw.setNow(now);
    tab.send({ type: 'status', meetingId: MEET, inCall: true, captionsOn });
    await flush();
    return tab.posted.at(-1)?.text;
  };
  return { sw, tab, status };
}

test('captions off just after joining does not warn yet', async () => {
  const { status } = await inCall();
  assert.equal(await status(false, 1000000), '');
  assert.equal(await status(false, 1014000), '');
});

test('captions staying off warns and names the record shortcut', async () => {
  const { status } = await inCall();
  await status(false, 1000000);
  assert.match(await status(false, 1016000), /Press Alt\+Shift\+R to record audio/);
});

test('without a shortcut the warning points at the extension icon', async () => {
  const { status } = await inCall({ shortcut: '' });
  await status(false, 1000000);
  assert.match(await status(false, 1016000), /extension icon/);
});

test('captions going quiet warns only after a minute', async () => {
  const { status } = await inCall();
  await status(true, 1000000);
  assert.equal(await status(true, 1059000), '');
  assert.match(await status(true, 1061000), /Captions stopped/);
});

test('new captions clear the warning', async () => {
  const { sw, status } = await inCall();
  await status(true, 1000000);
  assert.match(await status(true, 1061000), /Captions stopped/);
  sw.setNow(1062000);
  const tab = sw.connect();
  tab.send({ type: 'segments', meetingId: MEET, title: 't', segs: [{ id: 'a', speaker: 'Ani', text: 'halo', t: 1062000 }] });
  await flush();
  assert.equal(await status(true, 1063000), '');
});

test('a running recording means no warning', async () => {
  const sw = loadSw({ offscreen: { ...RECORDING, meetingId: MEET }, store: { settings: { transcriptSource: 'caption' } } });
  sw.finishWaking();
  await flush();
  const tab = sw.connect();
  sw.setNow(1000000);
  tab.send({ type: 'status', meetingId: MEET, inCall: true, captionsOn: false });
  await flush();
  sw.setNow(1016000);
  tab.send({ type: 'status', meetingId: MEET, inCall: true, captionsOn: false });
  await flush();
  assert.equal(tab.posted.at(-1).text, '');
});

test('audio mode never warns about captions', async () => {
  const { status } = await inCall({ store: { settings: { transcriptSource: 'audio' } } });
  await status(false, 1000000);
  assert.equal(await status(false, 1016000), '');
});

test('Firefox cannot record, so it gets no record prompt', async () => {
  const { status } = await inCall({ firefox: true });
  await status(false, 1000000);
  assert.equal(await status(false, 1016000), '');
});

test('MoM asks for a streamed reply and keeps the worker awake while waiting', async () => {
  const sw = loadSw({ store: { settings: { apiKey: 'k' }, meetings: ['m'], 'meeting:m': { id: 'm', title: 't', startedAt: 1, segments: [{ id: 'a', speaker: 'Ani', text: 'halo', t: 1 }] } } });
  sw.finishWaking();
  const seen = [];
  sw.useModel(async (args) => {
    seen.push(args.stream);
    await new Promise((done) => setTimeout(done, 60));
    return 'hasil';
  });
  assert.equal((await sw.ask({ type: 'generate-mom', id: 'm' })).mom, 'hasil');
  assert.deepEqual(seen, [true]);
  assert.ok(sw.pings() > 0);
  const after = sw.pings();
  await new Promise((done) => setTimeout(done, 60));
  assert.equal(sw.pings(), after);
});

test('time spent in the lobby does not count once you join', async () => {
  const sw = loadSw({ store: { settings: { transcriptSource: 'caption' } } });
  sw.finishWaking();
  await flush();
  const tab = sw.connect();
  const status = async (inCallNow, now) => {
    sw.setNow(now);
    tab.send({ type: 'status', meetingId: MEET, inCall: inCallNow, captionsOn: false });
    await flush();
    return tab.posted.at(-1)?.text;
  };
  await status(false, 1000000);
  await status(false, 1028000);
  assert.equal(await status(true, 1030000), '');
  assert.equal(await status(true, 1040000), '');
  assert.match(await status(true, 1046000), /Captions stopped/);
});

const meetingFor = (extra = {}) => ({ id: MEET, title: 't', startedAt: 1, endedAt: null, source: 'caption', segments: [{ id: 'a', speaker: 'Ani', text: 'halo', t: 1 }], ...extra });

test('closing a duplicate tab does not end a call still open in another', async () => {
  const sw = loadSw({ store: { settings: { apiKey: 'k', autoMom: true }, meetings: [MEET], [`meeting:${MEET}`]: meetingFor() } });
  sw.finishWaking();
  let made = 0;
  sw.useModel(async () => { made++; return 'mom'; });
  await flush();
  const first = sw.connect(1);
  const second = sw.connect(2);
  first.send({ type: 'status', meetingId: MEET, inCall: true, captionsOn: true });
  second.send({ type: 'status', meetingId: MEET, inCall: true, captionsOn: true });
  second.disconnect();
  await flush();
  assert.equal(sw.store[`meeting:${MEET}`].endedAt, null);
  assert.equal(made, 0);
  first.disconnect();
  await flush();
  assert.ok(sw.store[`meeting:${MEET}`].endedAt);
  assert.equal(made, 1);
});

test('leaving after stopping a recording mid-call makes the MoM', async () => {
  const sw = loadSw({ store: { settings: { apiKey: 'k', autoMom: true, transcriptSource: 'both' }, meetings: [MEET], [`meeting:${MEET}`]: meetingFor({ source: 'audio' }) } });
  sw.finishWaking();
  let made = 0;
  sw.useModel(async () => { made++; return 'mom'; });
  await flush();
  const tab = sw.connect();
  tab.send({ type: 'status', meetingId: MEET, inCall: true, captionsOn: true });
  tab.send({ type: 'ended', meetingId: MEET, joined: true });
  await flush();
  assert.equal(made, 1);
});

test('leaving during a recording waits for its transcript before the MoM', async () => {
  const sw = loadSw({ offscreen: { recording: true, transcribing: false, meetingId: MEET, tabId: 5, autoStt: true }, store: { settings: { apiKey: 'k', autoMom: true, transcriptSource: 'both' }, meetings: [MEET], [`meeting:${MEET}`]: meetingFor({ source: 'audio' }) } });
  sw.finishWaking();
  let made = 0;
  sw.useModel(async () => { made++; return 'mom'; });
  await flush();
  const tab = sw.connect();
  tab.send({ type: 'status', meetingId: MEET, inCall: true, captionsOn: true });
  tab.send({ type: 'ended', meetingId: MEET, joined: true });
  await flush();
  assert.equal(made, 0);
});

test('a slow MoM does not land on a newer session of the same room', async () => {
  const key = `meeting:${MEET}`;
  const sw = loadSw({ store: { settings: { apiKey: 'k' }, meetings: [MEET], [key]: meetingFor({ startedAt: 1 }) } });
  sw.finishWaking();
  sw.useModel(async () => {
    sw.store[key] = meetingFor({ startedAt: 999 });
    return 'old mom';
  });
  const answer = await sw.ask({ type: 'generate-mom', id: MEET });
  assert.match(answer.error, /not found/i);
  assert.equal(sw.store[key].mom, undefined);
});

test('leaving the lobby of a recorded meeting stops the recording and ends it', async () => {
  const sw = loadSw({ offscreen: { recording: true, transcribing: false, meetingId: MEET, tabId: 5, autoStt: false }, store: { meetings: [MEET], [`meeting:${MEET}`]: meetingFor() } });
  sw.finishWaking();
  await flush();
  const tab = sw.connect();
  tab.send({ type: 'ended', meetingId: MEET, joined: false });
  await flush();
  assert.ok(sw.sent.some((m) => m.target === 'offscreen' && m.op === 'stop'));
  assert.ok(sw.store[`meeting:${MEET}`].endedAt);
});

test('looking at the lobby of an old meeting leaves it alone', async () => {
  const sw = loadSw({ store: { meetings: [MEET], [`meeting:${MEET}`]: meetingFor({ endedAt: 5 }) } });
  sw.finishWaking();
  await flush();
  const tab = sw.connect();
  tab.send({ type: 'status', meetingId: MEET, inCall: false, captionsOn: false });
  tab.send({ type: 'ended', meetingId: MEET, joined: false });
  await flush();
  assert.equal(sw.store[`meeting:${MEET}`].endedAt, 5);
});

test('the worker stays awake while the AI tab loads', async () => {
  const sw = loadSw();
  sw.finishWaking();
  sw.ask({ type: 'send-to-ai', text: 'x', target: 'gemini', id: 'm' });
  await new Promise((done) => setTimeout(done, 40));
  assert.ok(sw.pings() > 0);
});

test('an archived meeting tells the panel where it moved', async () => {
  const key = `meeting:${MEET}`;
  const sw = loadSw({ store: { meetings: [MEET], [key]: meetingFor({ startedAt: 1, endedAt: 1000 }) } });
  sw.finishWaking();
  sw.setNow(1000 + 31 * 60000);
  await flush();
  const tab = sw.connect();
  tab.send({ type: 'segments', meetingId: MEET, title: 't', segs: [{ id: 'b', speaker: 'Ani', text: 'baru', t: 2000000 }] });
  await flush();
  const moved = sw.sent.find((m) => m.type === 'meeting-updated' && m.movedFrom === MEET);
  assert.equal(moved.id, `${MEET}@1000`);
});
