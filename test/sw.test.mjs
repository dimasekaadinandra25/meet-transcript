import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../background/service-worker.js', import.meta.url), 'utf8');
const SESSION = readFileSync(new URL('../content/session.js', import.meta.url), 'utf8');
const MERGE = readFileSync(new URL('../lib/merge.js', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../lib/i18n.js', import.meta.url), 'utf8');

function loadSw({ offscreen, recordings = [], store = {}, removeRecordings = async () => {}, generateMoM = async () => 'MOM OTOMATIS', withMenus = false, withCommands = false }) {
  const sent = [];
  const scripts = [];
  const tabUpdated = [];
  const removedAudio = [];
  let badge = null;
  let badgeTitle = null;
  const chrome = {
    action: {
      setBadgeBackgroundColor() {}, setBadgeTextColor() {},
      setBadgeText(o) { badge = o.text; },
      setTitle(o) { badgeTitle = o.title; },
    },
    runtime: {
      onMessage: { addListener: (f) => handlers.push(f) },
      onConnect: { addListener: (f) => connects.push(f) },
      onInstalled: { addListener: (f) => installed.push(f) },
      getContexts: async () => (offscreen ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []),
      async sendMessage(msg) {
        sent.push(msg);
        if (msg.target !== 'offscreen') return undefined;
        if (!offscreen) throw new Error('Could not establish connection.');
        return msg.op === 'state' ? { ok: true, ...offscreen } : { ok: true };
      },
      id: 'ext',
      getURL: (p) => `chrome-extension://ext/${p}`,
    },
    storage: { local: {
      get: async (keys) => {
        const out = {};
        for (const k of keys == null ? Object.keys(store) : [].concat(keys)) {
          if (k in store) out[k] = structuredClone(store[k]);
        }
        return out;
      },
      set: async (o) => { Object.assign(store, structuredClone(o)); },
      remove: async (k) => { for (const x of [].concat(k)) delete store[x]; },
    }, onChanged: { addListener: (f) => changed.push(f) } },
    offscreen: { closeDocument: async () => {}, createDocument: async () => {} },
    tabs: {
      create: async () => ({ id: 7 }),
      onUpdated: { addListener: (f) => tabUpdated.push(f), removeListener() {} },
      onRemoved: { addListener() {}, removeListener() {} },
    },
    scripting: { executeScript: async (options) => { scripts.push(options); } },
  };
  const handlers = [];
  const connects = [];
  const installed = [];
  const changed = [];
  const menus = {};
  const patterns = [];
  const commands = [];
  if (withCommands) chrome.commands = { onCommand: { addListener: (f) => commands.push(f) }, getAll: async () => [{ name: 'rec-start', shortcut: 'Alt+Shift+R' }] };
  if (withMenus) {
    chrome.tabCapture = {};
    chrome.contextMenus = {
      removeAll: (done) => done(),
      create: ({ id, title, documentUrlPatterns }) => { menus[id] = title; patterns.push(...documentUrlPatterns); },
      update: async (id, { title }) => { menus[id] = title; },
      onClicked: { addListener() {} },
    };
  }
  const unrefTimeout = (f, ms) => {
    const timer = setTimeout(f, ms);
    timer.unref();
    return timer;
  };
  const ctx = vm.createContext({ chrome, console, URL, setTimeout: unrefTimeout, clearTimeout });
  vm.runInContext('globalThis.MeetAudioStore = {}; globalThis.MeetStt = {};', ctx);
  ctx.MeetAudioStore.listRecordings = async () => recordings;
  ctx.MeetAudioStore.retagAudioMeta = async () => {};
  ctx.MeetAudioStore.removeRecordings = async (id) => {
    removedAudio.push(id);
    await removeRecordings(id);
  };
  ctx.MeetStt.sttEndpoint = () => ({ mode: 'api', baseUrl: 'http://localhost:1/v1',
    apiKey: '', model: 'whisper-1', language: '' });
  vm.runInContext('globalThis.MeetOpenAI = { DEFAULT_MODEL: "m" };', ctx);
  ctx.MeetOpenAI.generateMoM = generateMoM;
  vm.runInContext(SESSION, ctx);
  vm.runInContext(MERGE, ctx);
  vm.runInContext(I18N, ctx);
  vm.runInContext(SRC, ctx);
  const PANEL = { id: 'ext', url: 'chrome-extension://ext/panel/panel.html' };
  const ask = (msg, sender = PANEL) => new Promise((resolve) => {
    for (const f of handlers) if (f(msg, sender, resolve) === true) return;
    resolve(undefined);
  });
  const connect = (tabId) => {
    const posted = [];
    const port = { name: 'captions', sender: { tab: { id: tabId } }, msgFns: [], discFns: [],
      postMessage: (m) => posted.push(m),
      onMessage: { addListener: (f) => port.msgFns.push(f) },
      onDisconnect: { addListener: (f) => port.discFns.push(f) } };
    for (const f of connects) f(port);
    return { posted, send: (m) => port.msgFns.forEach((f) => f(m)), disconnect: () => port.discFns.forEach((f) => f()) };
  };
  const setNow = (now) => vm.runInContext(`Date.now = () => ${now};`, ctx);
  return { setNow, ask, sent, store, connect, scripts, tabUpdated, removedAudio, badge: () => badge, badgeTitle: () => badgeTitle, meetingIdFromUrl: ctx.meetingIdFromUrl,
    autoTranscribe: ctx.autoTranscribe, saveSegments: ctx.saveSegments, startRecording: ctx.startRecording, menuPatterns: () => patterns, pressCommand: (id) => commands.forEach((f) => f(id)), menus, install: () => installed.forEach((f) => f()), settingsChanged: (settings) => changed.forEach((f) => f({ settings: { newValue: settings } }, 'local')) };
}

const idOf = loadSw({ offscreen: null }).meetingIdFromUrl;

const IDLE = { recording: false, transcribing: false, meetingId: null, tabId: null, autoStt: undefined, paused: false };
const flush = () => new Promise((r) => setTimeout(r, 0));

test('get-active memulihkan rekaman yang masih jalan di offscreen', async () => {
  const sw = loadSw({ offscreen: { recording: true, transcribing: false, meetingId: 'discord-1-2',
    tabId: 42, autoStt: false } });
  const a = await sw.ask({ type: 'get-active' });
  assert.deepEqual({ ...a.rec },
    { ...IDLE, recording: true, meetingId: 'discord-1-2', tabId: 42, autoStt: false });
  assert.equal(sw.badge(), '●');
  assert.ok(sw.sent.some((m) => m.target === 'offscreen' && m.op === 'state'));
});

test('transkrip yang masih jalan ikut dipulihkan', async () => {
  const sw = loadSw({ offscreen: { recording: false, transcribing: true, meetingId: 'abc-defg-hij',
    tabId: null, autoStt: true } });
  const a = await sw.ask({ type: 'get-active' });
  assert.deepEqual({ ...a.rec },
    { ...IDLE, transcribing: true, meetingId: 'abc-defg-hij', autoStt: true });
});

test('tanpa dokumen offscreen, rec tetap kosong', async () => {
  const sw = loadSw({ offscreen: null });
  const a = await sw.ask({ type: 'get-active' });
  assert.deepEqual({ ...a.rec }, IDLE);
  assert.ok(!sw.sent.some((m) => m.target === 'offscreen'));
});

test('offscreen yang idle tidak memalsukan rekaman', async () => {
  const sw = loadSw({ offscreen: { recording: false, transcribing: false, meetingId: null } });
  const a = await sw.ask({ type: 'get-active' });
  assert.deepEqual({ ...a.rec }, IDLE);
  assert.ok(!sw.badge());
});

test('STT otomatis mengikuti sumber transkrip', () => {
  const { autoTranscribe } = loadSw({ offscreen: null });
  assert.equal(autoTranscribe('caption'), false);
  assert.equal(autoTranscribe('audio'), true);
  assert.equal(autoTranscribe('both'), true);
});

test('audio-saved melepas status transkrip', async () => {
  const sw = loadSw({ offscreen: { recording: false, transcribing: true, meetingId: 'abc-defg-hij' } });
  assert.equal((await sw.ask({ type: 'get-active' })).rec.transcribing, true);
  await sw.ask({ type: 'audio-saved', meetingId: 'abc-defg-hij' });
  const a = await sw.ask({ type: 'get-active' });
  assert.deepEqual({ ...a.rec }, IDLE);
  assert.equal(sw.badge(), '');
});

test('audio-saved tidak menghapus peringatan rekaman', async () => {
  const sw = loadSw({ offscreen: { recording: false, transcribing: true, meetingId: 'discord-1-2' } });
  await sw.ask({ type: 'get-active' });
  await sw.ask({ type: 'audio-saved', meetingId: 'discord-1-2' });
  const last = sw.sent.filter((m) => m.type === 'rec-state').at(-1);
  assert.equal(last.transcribing, false);
  assert.ok(!('error' in last));
});

test('audio-saved menandai selesai record non-Meet, bukan Meet', async () => {
  const store = {
    'meeting:discord-1-2': { id: 'discord-1-2', startedAt: 1, endedAt: null, segments: [] },
    'meeting:abc-defg-hij': { id: 'abc-defg-hij', startedAt: 1, endedAt: null, segments: [] },
  };
  const sw = loadSw({ offscreen: null, store });
  await sw.ask({ type: 'audio-saved', meetingId: 'discord-1-2' });
  await sw.ask({ type: 'audio-saved', meetingId: 'abc-defg-hij' });
  await flush(); await flush();
  assert.equal(typeof sw.store['meeting:discord-1-2'].endedAt, 'number');
  assert.equal(sw.store['meeting:abc-defg-hij'].endedAt, null);
});

test('menutup tab lain di ruang yang sama tidak menghentikan rekaman', async () => {
  const sw = loadSw({ offscreen: { recording: true, transcribing: false, meetingId: 'abc-defg-hij', tabId: 1 } });
  await sw.ask({ type: 'get-active' });
  const b = sw.connect(2);
  b.send({ type: 'status', meetingId: 'abc-defg-hij', inCall: true, captionsOn: false });
  b.disconnect();
  await flush();
  assert.ok(!sw.sent.some((m) => m.op === 'stop'));
  const a = sw.connect(1);
  a.send({ type: 'status', meetingId: 'abc-defg-hij', inCall: true, captionsOn: false });
  a.disconnect();
  await flush();
  assert.ok(sw.sent.some((m) => m.op === 'stop'));
});

test('tab in-call kedua tidak merebut status meeting aktif', async () => {
  const sw = loadSw({ offscreen: null });
  const a = sw.connect(1);
  const b = sw.connect(2);
  a.send({ type: 'status', meetingId: 'aaa-aaaa-aaa', inCall: true, captionsOn: true });
  b.send({ type: 'status', meetingId: 'bbb-bbbb-bbb', inCall: true, captionsOn: false });
  a.send({ type: 'status', meetingId: 'aaa-aaaa-aaa', inCall: true, captionsOn: true });
  b.send({ type: 'status', meetingId: 'bbb-bbbb-bbb', inCall: true, captionsOn: false });
  assert.equal((await sw.ask({ type: 'get-active' })).id, 'aaa-aaaa-aaa');
});

test('enable-mic diteruskan ke offscreen saat rekaman jalan', async () => {
  const sw = loadSw({ offscreen: { recording: true, transcribing: false, meetingId: 'discord-1-2' } });
  await sw.ask({ type: 'enable-mic' });
  await flush();
  assert.ok(sw.sent.some((m) => m.target === 'offscreen' && m.op === 'mic-enable'));
});

test('tanpa dokumen offscreen, enable-mic tidak dikirim ke mana pun', async () => {
  const sw = loadSw({ offscreen: null });
  await sw.ask({ type: 'enable-mic' });
  await flush();
  assert.ok(!sw.sent.some((m) => m.op === 'mic-enable'));
});

test('regenerate-transcript tanpa recId ditolak, tanpa menyentuh offscreen', async () => {
  const sw = loadSw({ offscreen: null,
    recordings: [{ recId: 1000, meetingId: 'abc-defg-hij', count: 2 }] });
  const res = await sw.ask({ type: 'regenerate-transcript', id: 'abc-defg-hij' });
  assert.equal(res.ok, false);
  assert.match(res.error, /recId|rekaman/i);
  assert.ok(!sw.sent.some((m) => m.op === 'retranscribe'));
  const a = await sw.ask({ type: 'get-active' });
  assert.equal(a.rec.transcribing, false);
});

test('recId yang sudah terpangkas ditolak dengan pesan yang menjelaskan', async () => {
  const sw = loadSw({ offscreen: null,
    recordings: [{ recId: 1000, meetingId: 'abc-defg-hij', count: 2 }] });
  const res = await sw.ask({ type: 'regenerate-transcript', id: 'abc-defg-hij', recId: 999 });
  assert.equal(res.ok, false);
  assert.match(res.error, /no longer saved/);
  assert.ok(!sw.sent.some((m) => m.op === 'retranscribe'));
});

test('recId milik meeting lain ditolak', async () => {
  const sw = loadSw({ offscreen: null,
    recordings: [{ recId: 1000, meetingId: 'discord-1-2', count: 2 }] });
  const res = await sw.ask({ type: 'regenerate-transcript', id: 'abc-defg-hij', recId: 1000 });
  assert.equal(res.ok, false);
  assert.match(res.error, /another meeting/);
  assert.ok(!sw.sent.some((m) => m.op === 'retranscribe'));
});

test('recId sah diteruskan ke offscreen bersama recId-nya', async () => {
  const sw = loadSw({ offscreen: { recording: false, transcribing: false, meetingId: null },
    recordings: [{ recId: 1000, meetingId: 'abc-defg-hij', count: 2 }] });
  const res = await sw.ask({ type: 'regenerate-transcript', id: 'abc-defg-hij', recId: 1000 });
  assert.equal(res.ok, true);
  const sent = sw.sent.find((m) => m.op === 'retranscribe');
  assert.equal(sent.recId, 1000);
  assert.equal(sent.meetingId, 'abc-defg-hij');
});

test('Zoom web: tiga bentuk URL /wc/ yang dilayani Zoom', () => {
  assert.equal(idOf('https://zoom.us/wc/8412345678/join'), 'zoom-8412345678');
  assert.equal(idOf('https://zoom.us/wc/8412345678/start'), 'zoom-8412345678');
  assert.equal(idOf('https://zoom.us/wc/join/8412345678'), 'zoom-8412345678');
  assert.equal(idOf('https://zoom.us/wc/8412345678/join?prefer=1&un=cmlvbg=='),
    'zoom-8412345678');
});

test('Zoom web: app.zoom.us dan subdomain vanity ikut dikenali', () => {
  assert.equal(idOf('https://app.zoom.us/wc/8412345678/start'), 'zoom-8412345678');
  assert.equal(idOf('https://dlabs.zoom.us/wc/join/8412345678'), 'zoom-8412345678');
});

test('Zoom: halaman non-meeting dan host lain ditolak', () => {
  assert.equal(idOf('https://zoom.us/pricing'), null);
  assert.equal(idOf('https://zoom.us/j/8412345678'), null);
  assert.equal(idOf('https://zoom.us/wc/join/'), null);
  assert.equal(idOf('https://zoomgov.com/wc/8412345678/join'), null);
  assert.equal(idOf('https://notzoom.us.evil.com/wc/8412345678/join'), null);
});

test('Meet & Discord tetap dikenali setelah cabang Zoom disisipkan', () => {
  assert.equal(idOf('https://meet.google.com/abc-defg-hij'), 'abc-defg-hij');
  assert.equal(idOf('https://discord.com/channels/123/456'), 'discord-123-456');
  assert.equal(idOf('https://discord.com/channels/@me/456'), 'discord-dm-456');
  assert.equal(idOf('https://meet.google.com/landing'), null);
  assert.equal(idOf(undefined), null);
});

test('Meet: /meet/<kode> dan /_meet/<kode> dikenali sebagai ruang yang sama', () => {
  assert.equal(idOf('https://meet.google.com/meet/rek-rore-iwm'), 'rek-rore-iwm');
  assert.equal(idOf('https://meet.google.com/meet/rek-rore-iwm?authuser=1'), 'rek-rore-iwm');
  assert.equal(idOf('https://meet.google.com/meet/'), null);
  assert.equal(idOf('https://meet.google.com/other/rek-rore-iwm'), null);
  assert.equal(idOf('https://meet.google.com/_meet/rek-rore-iwm'), 'rek-rore-iwm');
});

test('Meet: kode ruang di domain lain bukan Meet', () => {
  assert.equal(idOf('https://example.com/abc-defg-hij'), null);
  assert.equal(idOf('https://teams.microsoft.com/abc-defg-hij'), null);
});

const TOKEN = 'MWNmNTVhN2ItYTA1YS00YzI1LTg3MmItZjgxYTIyYjhhNGIw';

test('Teams: id thread rapat dari hash, path undangan, dan launcher', () => {
  const want = `teams-${TOKEN}`;
  assert.equal(idOf(`https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/19:meeting_${TOKEN}@thread.v2/0?context=%7b%7d&anon=true`), want);
  assert.equal(idOf(`https://teams.microsoft.com/l/meetup-join/19%3ameeting_${TOKEN}%40thread.v2/0?context=%7b%22Tid%22%7d`), want);
  assert.equal(idOf(`https://teams.microsoft.com/dl/launcher/launcher.html?url=%2F_%23%2Fl%2Fmeetup-join%2F19%3Ameeting_${TOKEN}%40thread.v2%2F0%3Fcontext%3D%257b%257d&type=meetup-join`), want);
  assert.equal(idOf(`https://teams.cloud.microsoft/v2/#/l/meetup-join/19:meeting_${TOKEN}@thread.v2/0`), want);
});

test('Teams: link pendek /meet/<angka> di domain kerja & pribadi', () => {
  assert.equal(idOf('https://teams.microsoft.com/meet/2345678901234?p=AbCdEf'), 'teams-2345678901234');
  assert.equal(idOf('https://teams.live.com/meet/9345678901234?p=XyZ'), 'teams-9345678901234');
});

test('Teams: halaman tanpa id rapat dan domain tiruan ditolak', () => {
  assert.equal(idOf('https://teams.microsoft.com/v2/'), null);
  assert.equal(idOf('https://teams.microsoft.com/v2/#/calendarv2'), null);
  assert.equal(idOf(`https://teams.microsoft.com.evil.com/v2/#/l/meetup-join/19:meeting_${TOKEN}@thread.v2/0`), null);
  assert.equal(idOf('https://teams.microsoft.com/v2/#/%E0%A4%A'), null);
});

const HEX = 'cb176734e58f4e2aa88f39694dc3c9a3';
const MTID = 'db62852d3a1e984e0ce1f68e9f610562';

test('Webex: MTID didahulukan, lalu hex di path', () => {
  assert.equal(idOf(`https://illinois.webex.com/wbxmjs/joinservice/sites/illinois/meeting/download/${HEX}?MTID=m${MTID}`), `webex-${MTID}`);
  assert.equal(idOf(`https://acme.webex.com/acme/j.php?MTID=m${MTID.toUpperCase()}`), `webex-${MTID}`);
  assert.equal(idOf(`https://acme.webex.com/wbxmjs/joinservice/sites/acme/meeting/download/${HEX}`), `webex-${HEX}`);
});

test('Webex: personal room per situs, halaman lain ditolak', () => {
  assert.equal(idOf('https://acme.webex.com/meet/John.Doe'), 'webex-acme-john.doe');
  assert.equal(idOf('https://acme.webex.com/join/jdoe'), 'webex-acme-jdoe');
  assert.equal(idOf('https://acme.webex.com/webappng/sites/acme/dashboard'), null);
  assert.equal(idOf(`https://webex.com.evil.com/meet/jdoe`), null);
});

test('Slack: huddle dan channel memberi id yang sama', () => {
  assert.equal(idOf('https://app.slack.com/huddle/T019QHUBYQ3/C034CBLMQ9G'), 'slack-T019QHUBYQ3-C034CBLMQ9G');
  assert.equal(idOf('https://app.slack.com/client/T019QHUBYQ3/C034CBLMQ9G'), 'slack-T019QHUBYQ3-C034CBLMQ9G');
  assert.equal(idOf('https://app.slack.com/client/T019QHUBYQ3/C034CBLMQ9G/thread/C034CBLMQ9G-1712345678.000100'),
    'slack-T019QHUBYQ3-C034CBLMQ9G');
  assert.equal(idOf('https://app.slack.com/client/E030G10V24F/D04ABCDEF12'), 'slack-E030G10V24F-D04ABCDEF12');
});

test('Slack: halaman tanpa channel ditolak', () => {
  assert.equal(idOf('https://app.slack.com/client/T019QHUBYQ3/unreads'), null);
  assert.equal(idOf('https://app.slack.com/client/E030G10V24F/dms'), null);
  assert.equal(idOf('https://slack.com/huddle/T019QHUBYQ3/C034CBLMQ9G'), null);
});

test('Tempel ke AI hanya menempel, tombol kirim tidak ditekan', async () => {
  const sw = loadSw({ offscreen: null });
  let clicks = 0;
  const reports = [];
  const editor = { tagName: 'DIV', lines: [], focus() {}, replaceChildren() { this.lines = []; },
    append(p) { this.lines.push(p.textContent); }, dispatchEvent() {} };
  const sendButton = { disabled: false, click() { clicks++; } };
  const page = vm.createContext({
    window: {},
    InputEvent: class { constructor(type) { this.type = type; } },
    document: { querySelector: (selector) => (selector.includes('button') ? sendButton : editor), createElement: () => ({}) },
    chrome: { runtime: { sendMessage: async (m) => { reports.push(m); } } },
    Date,
    setInterval: (f) => setInterval(f, 1),
    clearInterval,
    setTimeout: (f) => setTimeout(f, 1),
  });
  await sw.ask({ type: 'send-to-ai', target: 'chatgpt', text: 'prompt\nkedua', id: 'm' });
  await flush();
  for (const f of sw.tabUpdated) f(7, { status: 'complete' }, { url: 'https://chatgpt.com/' });
  await flush();
  const { func, args } = sw.scripts[0];
  vm.runInContext(`(${func})`, page)(...args);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(editor.lines, ['prompt', 'kedua']);
  assert.equal(clicks, 0);
  assert.equal(reports.at(-1).ok, true);
});

const twoMeetings = () => ({
  meetings: ['a', 'b'],
  'meeting:a': { id: 'a', title: 'A', segments: [] },
  'meeting:b': { id: 'b', title: 'B', segments: [] },
});

test('hapus meeting menghapus transkrip, daftar, dan rekamannya', async () => {
  const sw = loadSw({ offscreen: null, store: twoMeetings() });
  const res = await sw.ask({ type: 'delete-meeting', id: 'a' });
  assert.equal(res.ok, true);
  assert.equal(sw.store['meeting:a'], undefined);
  assert.deepEqual(sw.store.meetings, ['b']);
  assert.ok(sw.store['meeting:b']);
  assert.deepEqual(sw.removedAudio, ['a']);
  assert.ok(sw.sent.some((m) => m.type === 'meeting-updated' && m.id === 'a'));
});

test('hapus ditolak saat meeting itu sedang direkam', async () => {
  const sw = loadSw({ store: twoMeetings(), offscreen: { recording: true, transcribing: false, meetingId: 'a', tabId: 1, autoStt: false } });
  await sw.ask({ type: 'get-active' });
  const res = await sw.ask({ type: 'delete-meeting', id: 'a' });
  assert.equal(res.ok, false);
  assert.ok(sw.store['meeting:a']);
  assert.deepEqual(sw.removedAudio, []);
});

test('hapus ditolak saat meeting itu sedang berlangsung di Meet', async () => {
  const sw = loadSw({ offscreen: null, store: twoMeetings() });
  sw.connect(1).send({ type: 'status', meetingId: 'a', inCall: true, captionsOn: true });
  const res = await sw.ask({ type: 'delete-meeting', id: 'a' });
  assert.equal(res.ok, false);
  assert.ok(sw.store['meeting:a']);
});

test('rekaman gagal dihapus: transkrip tetap ada dan error dilaporkan', async () => {
  const sw = loadSw({ offscreen: null, store: twoMeetings(), removeRecordings: async () => { throw new Error('db rusak'); } });
  const res = await sw.ask({ type: 'delete-meeting', id: 'a' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'db rusak');
  assert.ok(sw.store['meeting:a']);
  assert.deepEqual(sw.store.meetings, ['a', 'b']);
});

test('tab lobi Meet tidak menghalangi hapus entri lama', async () => {
  const sw = loadSw({ offscreen: null, store: twoMeetings() });
  sw.connect(1).send({ type: 'status', meetingId: 'a', inCall: false, captionsOn: false });
  const res = await sw.ask({ type: 'delete-meeting', id: 'a' });
  assert.equal(res.ok, true);
  assert.equal(sw.store['meeting:a'], undefined);
});

test('hapus arsip ditolak selama rekaman ruang itu masih berjalan', async () => {
  const store = { meetings: ['a@5'], 'meeting:a@5': { id: 'a@5', title: 'A', segments: [] } };
  const sw = loadSw({ store, offscreen: { recording: false, transcribing: true, meetingId: 'a', tabId: null, autoStt: true } });
  await sw.ask({ type: 'get-active' });
  const res = await sw.ask({ type: 'delete-meeting', id: 'a@5' });
  assert.equal(res.ok, false);
  assert.ok(sw.store['meeting:a@5']);
  assert.deepEqual(sw.removedAudio, []);
});

const captionMeeting = () => ({ meetings: ['a'], 'meeting:a': { id: 'a', title: 'A', startedAt: 0, segments: [
  { id: 'cap-1', speaker: 'Ani', text: 'Halo semuanya, mari kita mulai', t: 1000 },
] } });
const finished = (text) => ({ type: 'audio-transcript', meetingId: 'a', baseTime: 500, segments: [{ t: 1500, speaker: '', text }] });

test('semua baris audio sama dengan caption: pengguna diberi tahu', async () => {
  const sw = loadSw({ offscreen: null, store: captionMeeting() });
  await sw.ask(finished('halo semuanya mari kita mulai'));
  await flush();
  await flush();
  assert.ok(sw.sent.some((m) => m.type === 'rec-state' && /matches the captions/.test(m.error ?? '')));
});

test('baris audio baru tersimpan tanpa pemberitahuan itu', async () => {
  const sw = loadSw({ offscreen: null, store: captionMeeting() });
  await sw.ask(finished('anggaran bulan depan naik sepuluh persen'));
  await flush();
  await flush();
  assert.equal(sw.store['meeting:a'].segments.length, 2);
  assert.ok(!sw.sent.some((m) => m.type === 'rec-state' && /matches the captions/.test(m.error ?? '')));
});

test('with captions + audio, an automatic run that adds nothing stays quiet', async () => {
  const sw = loadSw({ offscreen: null, withMenus: true, store: { ...captionMeeting(), settings: { transcriptSource: 'both' } } });
  await sw.ask(finished('halo semuanya mari kita mulai'));
  await flush();
  await flush();
  assert.ok(!sw.sent.some((m) => m.type === 'rec-state' && /matches the captions/.test(m.error ?? '')));
});

test('with captions + audio, pressing the button still tells you nothing was added', async () => {
  const sw = loadSw({ offscreen: null, withMenus: true, store: { ...captionMeeting(), settings: { transcriptSource: 'both' } } });
  await sw.ask({ ...finished('halo semuanya mari kita mulai'), replace: true });
  await flush();
  await flush();
  assert.ok(sw.sent.some((m) => m.type === 'rec-state' && /matches the captions/.test(m.error ?? '')));
});

const wait = () => new Promise((r) => setTimeout(r, 20));
const autoStore = (extra = {}) => ({
  settings: { apiKey: 'k', autoMom: true, ...extra },
  meetings: ['a'],
  'meeting:a': { id: 'a', title: 'A', startedAt: 0, segments: [{ id: 'cap-1', speaker: 'Ani', text: 'halo semua', t: 1 }], mom: null },
});

test('MoM otomatis setelah transkrip audio tersimpan', async () => {
  const sw = loadSw({ offscreen: null, store: autoStore() });
  await sw.ask({ type: 'audio-transcript', meetingId: 'a', baseTime: 500, segments: [{ t: 90000, speaker: '', text: 'isi baru' }] });
  await wait();
  assert.equal(sw.store['meeting:a'].mom, 'MOM OTOMATIS');
  assert.ok(sw.sent.some((m) => m.type === 'meeting-updated' && m.id === 'a'));
});

test('MoM otomatis setelah meeting caption berakhir', async () => {
  const sw = loadSw({ offscreen: null, store: autoStore() });
  const port = sw.connect(1);
  port.send({ type: 'status', meetingId: 'a', inCall: true, captionsOn: true });
  port.disconnect();
  await wait();
  assert.equal(sw.store['meeting:a'].mom, 'MOM OTOMATIS');
});

test('MoM otomatis tidak jalan bila dimatikan', async () => {
  const sw = loadSw({ offscreen: null, store: autoStore({ autoMom: false }) });
  await sw.ask({ type: 'audio-transcript', meetingId: 'a', baseTime: 500, segments: [{ t: 90000, speaker: '', text: 'isi baru' }] });
  await wait();
  assert.equal(sw.store['meeting:a'].mom, null);
});

test('MoM otomatis dilewati bila ada potongan gagal', async () => {
  const sw = loadSw({ offscreen: null, store: autoStore() });
  await sw.ask({ type: 'audio-transcript', meetingId: 'a', baseTime: 500, error: '1/2 parts failed', segments: [{ t: 90000, speaker: '', text: 'isi baru' }] });
  await wait();
  assert.equal(sw.store['meeting:a'].mom, null);
});

test('MoM otomatis gagal: pengguna diberi tahu', async () => {
  const sw = loadSw({ offscreen: null, store: autoStore(), generateMoM: async () => { throw new Error('LLM down'); } });
  await sw.ask({ type: 'audio-transcript', meetingId: 'a', baseTime: 500, segments: [{ t: 90000, speaker: '', text: 'isi baru' }] });
  await wait();
  assert.ok(sw.sent.some((m) => m.type === 'rec-state' && /LLM down/.test(m.error ?? '')));
});

test('the right-click menu follows the language setting', async () => {
  const store = { settings: { uiLang: 'id' } };
  const sw = loadSw({ offscreen: null, store, withMenus: true });
  sw.install();
  await wait();
  assert.equal(sw.menus['rec-start'], 'Rekam audio rapat');
  assert.equal(sw.menus['rec-stop'], 'Hentikan rekaman');
  sw.settingsChanged({ uiLang: 'en' });
  await wait();
  assert.equal(sw.menus['rec-start'], 'Record meeting audio');
});

const recordedMeeting = (source) => ({
  settings: { apiKey: 'k', autoMom: true, transcriptSource: source },
  meetings: ['abc-defg-hij'],
  'meeting:abc-defg-hij': { id: 'abc-defg-hij', title: 'A', startedAt: 0, source: 'audio', segments: [{ id: 'cap-1', speaker: 'Ani', text: 'halo semua', t: 1 }], mom: null },
});

const endCall = async (sw) => {
  const port = sw.connect(1);
  port.send({ type: 'status', meetingId: 'abc-defg-hij', inCall: true, captionsOn: true });
  port.disconnect();
  await wait();
};

test('automatic MoM runs from captions when a recording was only archived', async () => {
  const sw = loadSw({ offscreen: null, store: recordedMeeting('caption') });
  await endCall(sw);
  assert.equal(sw.store['meeting:abc-defg-hij'].mom, 'MOM OTOMATIS');
});

test('automatic MoM waits for the transcript when one is coming', async () => {
  const sw = loadSw({ offscreen: { recording: true, transcribing: false, meetingId: 'abc-defg-hij', tabId: null, autoStt: true }, withMenus: true, store: recordedMeeting('both') });
  await endCall(sw);
  assert.equal(sw.store['meeting:abc-defg-hij'].mom, null);
});

test('automatic MoM uses captions when the audio transcript comes back empty', async () => {
  const sw = loadSw({ offscreen: null, withMenus: true, store: recordedMeeting('both') });
  await sw.ask({ type: 'audio-transcript', meetingId: 'abc-defg-hij', baseTime: 500, segments: [] });
  await wait();
  assert.equal(sw.store['meeting:abc-defg-hij'].mom, 'MOM OTOMATIS');
});

test('a browser without tab capture cannot stay in audio mode', async () => {
  const sw = loadSw({ offscreen: null, store: { settings: { transcriptSource: 'audio', model: 'm' } } });
  await wait();
  assert.deepEqual(sw.store.settings, { transcriptSource: 'caption', model: 'm' });
  sw.store.settings = { transcriptSource: 'audio' };
  sw.settingsChanged(sw.store.settings);
  await wait();
  assert.equal(sw.store.settings.transcriptSource, 'caption');
});

test('Chrome keeps audio mode', async () => {
  const sw = loadSw({ offscreen: null, withMenus: true, store: { settings: { transcriptSource: 'audio' } } });
  await wait();
  assert.equal(sw.store.settings.transcriptSource, 'audio');
});

const editStore = () => ({
  meetings: ['a'],
  'meeting:a': { id: 'a', title: 'A', startedAt: 0, endedAt: 9, segments: [{ id: 'x', speaker: 'Ani', text: 'halo', t: 1 }], mom: null },
});

test('editing a finished meeting saves and refreshes the panel', async () => {
  const sw = loadSw({ offscreen: null, store: editStore() });
  const res = await sw.ask({ type: 'edit-transcript', id: 'a', change: { from: 'Ani', to: 'Budi' } });
  assert.equal(res.ok, true);
  assert.equal(sw.store['meeting:a'].segments[0].speaker, 'Budi');
  assert.ok(sw.sent.some((m) => m.type === 'meeting-updated' && m.id === 'a'));
});

test('a running meeting cannot be edited', async () => {
  const sw = loadSw({ offscreen: null, store: editStore() });
  const port = sw.connect(1);
  port.send({ type: 'status', meetingId: 'a', inCall: true, captionsOn: true });
  await wait();
  const res = await sw.ask({ type: 'edit-transcript', id: 'a', change: { segmentId: 'x', text: 'ubah' } });
  assert.equal(res.ok, false);
  assert.equal(sw.store['meeting:a'].segments[0].text, 'halo');
});

test('editing a missing meeting reports an error', async () => {
  const sw = loadSw({ offscreen: null, store: editStore() });
  const res = await sw.ask({ type: 'edit-transcript', id: 'nope', change: { segmentId: 'x', text: 'ubah' } });
  assert.equal(res.ok, false);
});

const inCall = async (sw, captionsOn) => {
  const port = sw.connect(1);
  port.send({ type: 'status', meetingId: 'abc-defg-hij', inCall: true, captionsOn });
  await wait();
  return port;
};

test('the icon warns when captions are off', async () => {
  const sw = loadSw({ offscreen: null, store: { settings: { transcriptSource: 'caption' } } });
  await wait();
  await inCall(sw, false);
  assert.equal(sw.badge(), '!');
  assert.match(sw.badgeTitle(), /Captions are off/);
});

test('the icon warns when captions + audio has no recording', async () => {
  const sw = loadSw({ offscreen: null, withMenus: true, store: { settings: { transcriptSource: 'both' } } });
  await wait();
  await inCall(sw, true);
  assert.equal(sw.badge(), '!');
  assert.match(sw.badgeTitle(), /Not recording/);
});

test('the icon shows no warning when captions are working', async () => {
  const sw = loadSw({ offscreen: null, store: { settings: { transcriptSource: 'caption' } } });
  await wait();
  await inCall(sw, true);
  assert.equal(sw.badge(), '●');
});

test('the icon warning follows a settings change', async () => {
  const store = { settings: { transcriptSource: 'caption' } };
  const sw = loadSw({ offscreen: null, store });
  await wait();
  const port = await inCall(sw, true);
  sw.settingsChanged({ transcriptSource: 'both' });
  await wait();
  port.send({ type: 'status', meetingId: 'abc-defg-hij', inCall: true, captionsOn: true });
  await wait();
  assert.equal(sw.badge(), '!');
});

test('a settings change during startup is not undone by the first read', async () => {
  const sw = loadSw({ offscreen: null, withMenus: true, store: { settings: { transcriptSource: 'caption' } } });
  sw.settingsChanged({ transcriptSource: 'both' });
  await wait();
  await inCall(sw, true);
  assert.equal(sw.badge(), '!');
  assert.match(sw.badgeTitle(), /Not recording/);
});

test('a moment can be marked during a call', async () => {
  const sw = loadSw({ offscreen: null, store: editStore() });
  const port = sw.connect(1);
  port.send({ type: 'status', meetingId: 'a', inCall: true, captionsOn: true });
  await wait();
  const res = await sw.ask({ type: 'mark-moment' });
  assert.equal(res.ok, true);
  assert.equal(sw.store['meeting:a'].marks.length, 1);
});

test('marking with no meeting running reports an error', async () => {
  const sw = loadSw({ offscreen: null, store: editStore() });
  const res = await sw.ask({ type: 'mark-moment' });
  assert.equal(res.ok, false);
  assert.match(res.error, /No meeting/);
});

test('asking about a meeting saves the answer and leaves the MoM alone', async () => {
  const prompts = [];
  const sw = loadSw({ offscreen: null, store: { ...editStore(), settings: { apiKey: 'k' } }, generateMoM: async ({ prompt }) => { prompts.push(prompt); return 'jawaban'; } });
  const res = await sw.ask({ type: 'ask-meeting', id: 'a', question: 'Apa?' });
  assert.deepEqual([res.ok, res.answer], [true, 'jawaban']);
  assert.ok(prompts[0].includes('Apa?'));
  assert.equal(sw.store['meeting:a'].mom, null);
  assert.equal(sw.store['meeting:a'].answers[0].question, 'Apa?');
  assert.equal(sw.store['meeting:a'].answers[0].answer, 'jawaban');
});

test('the newest answer comes first', async () => {
  const sw = loadSw({ offscreen: null, store: { ...editStore(), settings: { apiKey: 'k' } } });
  await sw.ask({ type: 'ask-meeting', id: 'a', question: 'Satu?' });
  await sw.ask({ type: 'ask-meeting', id: 'a', question: 'Dua?' });
  assert.equal(sw.store['meeting:a'].answers.map((a) => a.question).join(), 'Dua?,Satu?');
});

test('saving an answer keeps changes made while waiting for it', async () => {
  const sw = loadSw({ offscreen: null, store: { ...editStore(), settings: { apiKey: 'k' } }, generateMoM: async () => {
    sw.store['meeting:a'].title = 'Judul baru';
    return 'jawaban';
  } });
  await sw.ask({ type: 'ask-meeting', id: 'a', question: 'Apa?' });
  assert.equal(sw.store['meeting:a'].title, 'Judul baru');
  assert.equal(sw.store['meeting:a'].answers.length, 1);
});

test('an answer does not bring back a deleted meeting', async () => {
  const sw = loadSw({ offscreen: null, store: { ...editStore(), settings: { apiKey: 'k' } }, generateMoM: async () => {
    delete sw.store['meeting:a'];
    return 'jawaban';
  } });
  const res = await sw.ask({ type: 'ask-meeting', id: 'a', question: 'Apa?' });
  assert.equal(res.ok, false);
  assert.equal(sw.store['meeting:a'], undefined);
});

test('an answer does not land on a newer meeting with the same link', async () => {
  const sw = loadSw({ offscreen: null, store: { ...editStore(), settings: { apiKey: 'k' } }, generateMoM: async () => {
    sw.store['meeting:a'] = { id: 'a', startedAt: sw.store['meeting:a'].startedAt + 1, segments: [] };
    return 'jawaban';
  } });
  const res = await sw.ask({ type: 'ask-meeting', id: 'a', question: 'Apa?' });
  assert.equal(res.ok, false);
  assert.equal(sw.store['meeting:a'].answers, undefined);
});

test('asking needs an AI service', async () => {
  const sw = loadSw({ offscreen: null, store: editStore() });
  const res = await sw.ask({ type: 'ask-meeting', id: 'a', question: 'Apa?' });
  assert.equal(res.ok, false);
  assert.match(res.error, /API key/);
});

test('a meeting can be renamed, and the name stays when the call page sends its title', async () => {
  const store = editStore();
  store['meeting:a'].endedAt = Date.now();
  const sw = loadSw({ offscreen: null, store });
  const res = await sw.ask({ type: 'rename-meeting', id: 'a', title: '  Rapat anggaran  ' });
  assert.equal(res.ok, true);
  assert.equal(sw.store['meeting:a'].title, 'Rapat anggaran');
  await sw.saveSegments({ meetingId: 'a', title: 'Judul halaman', segs: [] });
  assert.equal(sw.store['meeting:a'].title, 'Rapat anggaran');
});

test('an empty name leaves the title alone', async () => {
  const sw = loadSw({ offscreen: null, store: editStore() });
  const before = sw.store['meeting:a'].title;
  await sw.ask({ type: 'rename-meeting', id: 'a', title: '   ' });
  assert.equal(sw.store['meeting:a'].title, before);
});

test('an answer and a MoM remember the transcript they came from', async () => {
  const sw = loadSw({ offscreen: null, store: { ...editStore(), settings: { apiKey: 'k' } } });
  await sw.ask({ type: 'ask-meeting', id: 'a', question: 'Apa?' });
  await sw.ask({ type: 'generate-mom', id: 'a' });
  const saved = sw.store['meeting:a'];
  assert.equal(typeof saved.answers[0].basedOn, 'number');
  assert.equal(saved.momBasedOn, saved.answers[0].basedOn);
});

test('with Record audio, a recording from another meeting site is transcribed when it stops', async () => {
  const sw = loadSw({ offscreen: null, withMenus: true, store: { settings: { transcriptSource: 'audio' } } });
  await sw.startRecording({ streamId: 's', meetingId: 'teams-123', title: 'x', tabId: 1 }).catch(() => {});
  assert.equal(sw.sent.find((m) => m.op === 'start')?.transcribe, true);
});

const openOtherSite = () => ({ meetings: ['teams-123'], 'meeting:teams-123': { id: 'teams-123', title: 'T', startedAt: 1, endedAt: null, segments: [], mom: null, source: 'audio' } });

test('a recording from another site is finished once its transcript arrives', async () => {
  const sw = loadSw({ offscreen: null, withMenus: true, store: openOtherSite() });
  await sw.ask({ type: 'audio-transcript', meetingId: 'teams-123', baseTime: 1, segments: [{ t: 1, speaker: '', text: 'halo' }], replace: false });
  await wait();
  assert.ok(sw.store['meeting:teams-123'].endedAt > 0);
});

test('a recording from another site is finished even if transcribing fails', async () => {
  const sw = loadSw({ offscreen: null, withMenus: true, store: openOtherSite() });
  await sw.ask({ type: 'audio-error', meetingId: 'teams-123', error: 'STT mati' });
  await wait();
  assert.ok(sw.store['meeting:teams-123'].endedAt > 0);
});

test('retranscribing a finished meeting keeps its end time', async () => {
  const store = openOtherSite();
  store['meeting:teams-123'].endedAt = 77;
  const sw = loadSw({ offscreen: null, withMenus: true, store });
  await sw.ask({ type: 'audio-transcript', meetingId: 'teams-123', baseTime: 1, segments: [{ t: 1, speaker: '', text: 'halo' }], replace: true });
  await wait();
  assert.equal(sw.store['meeting:teams-123'].endedAt, 77);
});

test('a Meet recording stays open for the call page to finish', async () => {
  const store = { meetings: ['abc-defg-hij'], 'meeting:abc-defg-hij': { id: 'abc-defg-hij', title: 'M', startedAt: 1, endedAt: null, segments: [], mom: null, source: 'audio' } };
  const sw = loadSw({ offscreen: null, withMenus: true, store });
  await sw.ask({ type: 'audio-transcript', meetingId: 'abc-defg-hij', baseTime: 1, segments: [{ t: 1, speaker: '', text: 'halo' }], replace: false });
  await wait();
  assert.equal(sw.store['meeting:abc-defg-hij'].endedAt, null);
});

test('an answer can be deleted while its meeting is still running', async () => {
  const store = editStore();
  store['meeting:a'].endedAt = Date.now();
  store['meeting:a'].answers = [{ question: 'Apa?', answer: 'x' }];
  const sw = loadSw({ offscreen: null, store });
  const port = sw.connect(1);
  port.send({ type: 'status', meetingId: 'a', inCall: true, captionsOn: true });
  await wait();
  const res = await sw.ask({ type: 'edit-transcript', id: 'a', change: { deleteAnswer: { question: 'Apa?', answer: 'x' } } });
  assert.equal(res.ok, true);
  assert.equal(sw.store['meeting:a'].answers.length, 0);
});

test('an imported file becomes a finished meeting, safe from auto-delete for now', async () => {
  const sw = loadSw({ offscreen: null, store: { meetings: ['lama'] } });
  const res = await sw.ask({ type: 'add-imported-meeting', title: 'Rapat', startedAt: 1000, endedAt: 5000 });
  assert.equal(res.ok, true);
  assert.match(res.id, /^import-\d+$/);
  const saved = sw.store[`meeting:${res.id}`];
  assert.equal(saved.title, 'Rapat');
  assert.equal(saved.startedAt, 1000);
  assert.equal(saved.endedAt, 5000);
  assert.equal(saved.source, 'audio');
  assert.ok(saved.keepFrom > 5000);
  assert.equal(sw.store.meetings[0], res.id);
});

test('the right-click menu is offered on every meeting site', () => {
  const sw = loadSw({ offscreen: null, withMenus: true });
  sw.install();
  for (const site of ['meet.google.com', 'discord.com/channels', 'teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft', '*.webex.com', 'app.slack.com', '*.zoom.us']) {
    assert.ok(sw.menuPatterns().some((pattern) => pattern.includes(site)), site);
  }
});

test('recording parts are 2 minutes, and the keep number reaches the recorder', async () => {
  const sw = loadSw({ offscreen: null, store: { settings: { keepRecordings: 12 } } });
  await sw.startRecording({ streamId: 's', meetingId: 'abc-defg-hij', title: 'x', tabId: 1 }).catch(() => {});
  const sentStart = sw.sent.find((m) => m.op === 'start');
  assert.equal(sentStart?.chunkMs, 120000);
  assert.equal(sentStart?.keepRecordings, 12);
});

test('Firefox can mark a moment with the keyboard', async () => {
  const sw = loadSw({ offscreen: null, store: editStore(), withCommands: true });
  const port = sw.connect(1);
  port.send({ type: 'status', meetingId: 'a', inCall: true, captionsOn: true });
  await wait();
  sw.pressCommand('mark-moment');
  await wait();
  assert.equal(sw.store['meeting:a'].marks.length, 1);
});

test('old meetings are deleted when the limit is set', async () => {
  const day = 86400000;
  const store = {
    settings: { deleteAfterDays: 10 },
    meetings: ['old', 'new'],
    'meeting:old': { id: 'old', endedAt: Date.now() - 20 * day, segments: [] },
    'meeting:new': { id: 'new', endedAt: Date.now() - day, segments: [] },
  };
  const sw = loadSw({ offscreen: null, store });
  await wait();
  assert.deepEqual(sw.store.meetings, ['new']);
  assert.equal(sw.store['meeting:old'], undefined);
  assert.deepEqual(sw.removedAudio, ['old']);
});

test('no limit deletes nothing', async () => {
  const store = { meetings: ['old'], 'meeting:old': { id: 'old', endedAt: 1, segments: [] } };
  const sw = loadSw({ offscreen: null, store });
  await sw.ask({ type: 'delete-old-meetings' });
  await wait();
  assert.deepEqual(sw.store.meetings, ['old']);
});

test('a mark in a recurring Meet code goes on the new meeting', async () => {
  const old = Date.now() - 7 * 86400000;
  const sw = loadSw({ offscreen: null, store: {
    meetings: ['abc-defg-hij'],
    'meeting:abc-defg-hij': { id: 'abc-defg-hij', title: 'Last week', startedAt: old, endedAt: old, segments: [{ id: 'x', speaker: 'Ani', text: 'lama', t: old }], mom: null },
  } });
  const port = sw.connect(1);
  port.send({ type: 'status', meetingId: 'abc-defg-hij', inCall: true, captionsOn: true });
  await wait();
  await sw.ask({ type: 'mark-moment' });
  await wait();
  const today = sw.store['meeting:abc-defg-hij'];
  assert.equal(today.marks.length, 1);
  assert.equal(today.segments.length, 0);
  assert.equal(sw.store.meetings.length, 2);
});

test('a meeting running in a second tab cannot be deleted or edited', async () => {
  const sw = loadSw({ offscreen: null, store: { meetings: ['aaa-aaaa-aaa', 'bbb-bbbb-bbb'],
    'meeting:aaa-aaaa-aaa': { id: 'aaa-aaaa-aaa', startedAt: Date.now(), segments: [] },
    'meeting:bbb-bbbb-bbb': { id: 'bbb-bbbb-bbb', startedAt: Date.now(), segments: [{ id: 'x', speaker: 'A', text: 'a', t: 1 }] } } });
  const first = sw.connect(1);
  first.send({ type: 'status', meetingId: 'aaa-aaaa-aaa', inCall: true, captionsOn: true });
  const second = sw.connect(2);
  second.send({ type: 'status', meetingId: 'bbb-bbbb-bbb', inCall: true, captionsOn: true });
  await wait();
  assert.equal((await sw.ask({ type: 'delete-meeting', id: 'bbb-bbbb-bbb' })).ok, false);
  assert.equal((await sw.ask({ type: 'edit-transcript', id: 'bbb-bbbb-bbb', change: { segmentId: 'x', text: 'y' } })).ok, false);
  second.disconnect();
  await wait();
  assert.equal((await sw.ask({ type: 'edit-transcript', id: 'bbb-bbbb-bbb', change: { segmentId: 'x', text: 'y' } })).ok, true);
});

test('new captions keep a name you chose', async () => {
  const sw = loadSw({ offscreen: null, store: { meetings: ['abc-defg-hij'],
    'meeting:abc-defg-hij': { id: 'abc-defg-hij', startedAt: Date.now(), speakerNames: { You: 'Dimas' }, segments: [] } } });
  const port = sw.connect(1);
  port.send({ type: 'segments', meetingId: 'abc-defg-hij', title: '', segs: [{ id: 'n', speaker: 'You', text: 'halo', t: Date.now() }] });
  await wait();
  assert.equal(sw.store['meeting:abc-defg-hij'].segments[0].speaker, 'Dimas');
});

test('Firefox leaves captions + audio too, since it cannot record', async () => {
  const sw = loadSw({ offscreen: null, store: { settings: { transcriptSource: 'both' } } });
  await wait();
  assert.equal(sw.store.settings.transcriptSource, 'caption');
});

test('a web page cannot use the messages meant for extension pages', async () => {
  const sw = loadSw({ offscreen: null, store: { settings: { apiKey: 'k' }, meetings: ['abc-defg-hij'], 'meeting:abc-defg-hij': { id: 'abc-defg-hij', title: 'Rapat', segments: [], mom: null } } });
  const meetPage = { id: 'ext', url: 'https://meet.google.com/abc-defg-hij', tab: { id: 3 } };
  assert.equal(await sw.ask({ type: 'get-active' }, meetPage), undefined);
  assert.equal(await sw.ask({ type: 'delete-meeting', id: 'abc-defg-hij' }, meetPage), undefined);
  assert.ok(sw.store['meeting:abc-defg-hij'], 'a web page deleted a meeting');
  assert.equal(await sw.ask({ type: 'get-active' }, { id: 'other-extension', url: 'chrome-extension://other/x.html' }), undefined);
  assert.ok((await sw.ask({ type: 'get-active' })).rec, 'the panel lost access');
  assert.ok((await sw.ask({ type: 'get-active' }, { id: 'ext', url: 'chrome-extension://ext/panel/mic.html', tab: { id: 9 } })).rec, 'the extension page in a tab lost access');
});

test('a meeting keeps the tags you give it', async () => {
  const sw = loadSw({ offscreen: null, store: editStore() });
  const res = await sw.ask({ type: 'tag-meeting', id: 'a', tags: 'sales, Q3, sales' });
  assert.equal(res.ok, true);
  assert.deepEqual(sw.store['meeting:a'].tags, ['sales', 'Q3']);
  await sw.ask({ type: 'tag-meeting', id: 'a', tags: '' });
  assert.deepEqual(sw.store['meeting:a'].tags, []);
});
