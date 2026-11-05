import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../background/service-worker.js', import.meta.url), 'utf8');
const SESSION = readFileSync(new URL('../content/session.js', import.meta.url), 'utf8');
const MERGE = readFileSync(new URL('../lib/merge.js', import.meta.url), 'utf8');

function loadSw({ offscreen, recordings = [], store = {}, removeRecordings = async () => {} }) {
  const sent = [];
  const scripts = [];
  const tabUpdated = [];
  const removedAudio = [];
  let badge = null;
  const chrome = {
    action: {
      setBadgeBackgroundColor() {}, setBadgeTextColor() {},
      setBadgeText(o) { badge = o.text; },
    },
    runtime: {
      onMessage: { addListener: (f) => handlers.push(f) },
      onConnect: { addListener: (f) => connects.push(f) },
      onInstalled: { addListener() {} },
      getContexts: async () => (offscreen ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []),
      async sendMessage(msg) {
        sent.push(msg);
        if (msg.target !== 'offscreen') return undefined;
        if (!offscreen) throw new Error('Could not establish connection.');
        return msg.op === 'state' ? { ok: true, ...offscreen } : { ok: true };
      },
      getURL: (p) => p,
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
    } },
    offscreen: { closeDocument: async () => {} },
    tabs: {
      create: async () => ({ id: 7 }),
      onUpdated: { addListener: (f) => tabUpdated.push(f), removeListener() {} },
      onRemoved: { addListener() {}, removeListener() {} },
    },
    scripting: { executeScript: async (options) => { scripts.push(options); } },
  };
  const handlers = [];
  const connects = [];
  const unrefTimeout = (f, ms) => {
    const timer = setTimeout(f, ms);
    timer.unref();
    return timer;
  };
  const ctx = vm.createContext({ chrome, console, URL, setTimeout: unrefTimeout, clearTimeout });
  vm.runInContext('globalThis.MeetAudioStore = {}; globalThis.MeetStt = {};', ctx);
  ctx.MeetAudioStore.listRecordings = async () => recordings;
  ctx.MeetAudioStore.removeRecordings = async (id) => {
    removedAudio.push(id);
    await removeRecordings(id);
  };
  ctx.MeetStt.sttEndpoint = () => ({ mode: 'api', baseUrl: 'http://localhost:1/v1',
    apiKey: '', model: 'whisper-1', language: '' });
  vm.runInContext(SESSION, ctx);
  vm.runInContext(MERGE, ctx);
  vm.runInContext(SRC, ctx);
  const ask = (msg) => new Promise((resolve) => {
    for (const f of handlers) if (f(msg, {}, resolve) === true) return;
    resolve(undefined);
  });
  const connect = (tabId) => {
    const port = { name: 'captions', sender: { tab: { id: tabId } }, msgFns: [], discFns: [],
      onMessage: { addListener: (f) => port.msgFns.push(f) },
      onDisconnect: { addListener: (f) => port.discFns.push(f) } };
    for (const f of connects) f(port);
    return { send: (m) => port.msgFns.forEach((f) => f(m)), disconnect: () => port.discFns.forEach((f) => f()) };
  };
  return { ask, sent, store, connect, scripts, tabUpdated, removedAudio, badge: () => badge, meetingIdFromUrl: ctx.meetingIdFromUrl,
    autoTranscribe: ctx.autoTranscribe };
}

const idOf = loadSw({ offscreen: null }).meetingIdFromUrl;

const flush = () => new Promise((r) => setTimeout(r, 0));

test('get-active memulihkan rekaman yang masih jalan di offscreen', async () => {
  const sw = loadSw({ offscreen: { recording: true, transcribing: false, meetingId: 'discord-1-2',
    tabId: 42, autoStt: false } });
  const a = await sw.ask({ type: 'get-active' });
  assert.deepEqual({ ...a.rec },
    { recording: true, transcribing: false, meetingId: 'discord-1-2', tabId: 42, autoStt: false });
  assert.equal(sw.badge(), '●');
  assert.ok(sw.sent.some((m) => m.target === 'offscreen' && m.op === 'state'));
});

test('transkrip yang masih jalan ikut dipulihkan', async () => {
  const sw = loadSw({ offscreen: { recording: false, transcribing: true, meetingId: 'abc-defg-hij',
    tabId: null, autoStt: true } });
  const a = await sw.ask({ type: 'get-active' });
  assert.deepEqual({ ...a.rec },
    { recording: false, transcribing: true, meetingId: 'abc-defg-hij', tabId: null, autoStt: true });
});

test('tanpa dokumen offscreen, rec tetap kosong', async () => {
  const sw = loadSw({ offscreen: null });
  const a = await sw.ask({ type: 'get-active' });
  assert.deepEqual({ ...a.rec }, { recording: false, transcribing: false, meetingId: null });
  assert.ok(!sw.sent.some((m) => m.target === 'offscreen'));
});

test('offscreen yang idle tidak memalsukan rekaman', async () => {
  const sw = loadSw({ offscreen: { recording: false, transcribing: false, meetingId: null } });
  const a = await sw.ask({ type: 'get-active' });
  assert.deepEqual({ ...a.rec }, { recording: false, transcribing: false, meetingId: null });
  assert.equal(sw.badge(), null);
});

test('STT otomatis hanya untuk Meet bermode audio', () => {
  const { autoTranscribe } = loadSw({ offscreen: null });
  const meet = idOf('https://meet.google.com/abc-defg-hij');
  assert.equal(autoTranscribe(meet, 'caption'), false);
  assert.equal(autoTranscribe(meet, 'audio'), true);
  assert.equal(autoTranscribe(idOf('https://discord.com/channels/123/456'), 'audio'), false);
  assert.equal(autoTranscribe(idOf('https://zoom.us/wc/84787201766/join'), 'audio'), false);
});

test('audio-saved melepas status transkrip', async () => {
  const sw = loadSw({ offscreen: { recording: false, transcribing: true, meetingId: 'abc-defg-hij' } });
  assert.equal((await sw.ask({ type: 'get-active' })).rec.transcribing, true);
  await sw.ask({ type: 'audio-saved', meetingId: 'abc-defg-hij' });
  const a = await sw.ask({ type: 'get-active' });
  assert.deepEqual({ ...a.rec }, { recording: false, transcribing: false, meetingId: null });
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
  assert.match(res.error, /last 5 recordings/);
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
