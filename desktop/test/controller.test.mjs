import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
await import('../../lib/merge.js');
await import('../../lib/stt.js');
require('../renderer/tracks.js');
require('../renderer/controller.js');
const { createController } = globalThis;

const NOW = 1700000000000;
const id = `desktop-${NOW}`;
const blob = (track) => ({ track });

let data;
let messages;
let openedUrls;
let fakeRecorder;
let fakeOpenAI;
let fakeStore;
let states;
let warned;
let probes;
let engineAnswer = { ok: true, value: 'http://127.0.0.1:1/v1' };
let probeAnswer;
let saved;
let failWrites;
let ctl;

const START = { type: 'start-recording', video: false };
const STOP = { type: 'stop-recording' };
const regenerate = (meetingId, recId) => ({ type: 'regenerate-transcript', id: meetingId, recId });
const meeting = () => data[`meeting:${id}`];
const recStates = () => messages.filter((m) => m.type === 'rec-state');
const runRecording = async () => {
  await ctl.handle(START);
  await ctl.handle(STOP);
};

beforeEach(() => {
  data = { settings: { mic: true, sttMode: 'api', sttBaseUrl: 'http://stt/v1', apiKey: 'k', baseUrl: 'http://llm/v1' } };
  messages = [];
  openedUrls = [];
  states = [];
  warned = 0;
  probes = [];
  probeAnswer = { ok: true, value: { ok: true, status: 200 } };
  saved = [];
  failWrites = false;
  fakeRecorder = {
    starts: 0,
    stops: 0,
    muted: false,
    peaks: { system: [0.5], mic: [0.5] },
    async start(options) {
      this.starts++;
      this.options = options;
      if (this.failStart) throw new Error(this.failStart);
      await options.prepare();
    },
    async stop() { this.stops++; return { peaks: this.peaks }; },
    setMuted(on) { this.muted = on; },
    currentPeaks() { return this.peaks; },
    isMuted() { return this.muted; },
  };
  fakeOpenAI = {
    DEFAULT_MODEL: 'default-model',
    fail: null,
    failFor: null,
    transcribeCalls: [],
    async transcribeAudio(args) {
      this.transcribeCalls.push(args);
      if (this.fail) throw this.fail;
      if (this.failFor === args.blob.track) throw new Error(`STT ${args.blob.track} mati`);
      return { segments: [{ start: 0, text: `teks ${args.blob.track}` }] };
    },
    async generateMoM(args) {
      this.momCalls = (this.momCalls ?? 0) + 1;
      this.momArgs = args;
      return 'MOM HASIL';
    },
  };
  const loaded = (track) => async (recId) => ({
    meetingId: id, chunkMs: 600000, baseTime: recId, blobs: [blob(track)], indices: [0],
  });
  fakeStore = {
    removed: [],
    began: [],
    async beginAudio(meta) { this.began.push(meta); },
    async removeRecordings(meetingId) {
      if (this.failRemove) throw new Error(this.failRemove);
      this.removed.push(meetingId);
    },
    async listRecordings() { return this.began.map((m) => ({ ...m, recId: m.baseTime })); },
    loadSystem: loaded('system'),
    loadMic: loaded('mic'),
    loadMix: async (recId) => ({ meetingId: id, baseTime: recId, blobs: [blob('mix-0'), blob('mix-1')], indices: [0, 1] }),
    loadVideo: async () => fakeStore.video ?? null,
  };
  ctl = createController({
    recorder: fakeRecorder,
    audioStore: fakeStore,
    storage: {
      get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
      set: async (values) => {
        if (failWrites) throw new Error('disk penuh');
        Object.assign(data, structuredClone(values));
      },
      remove: async (key) => { delete data[key]; },
    },
    merge: globalThis.MeetMerge,
    stt: globalThis.MeetStt,
    tracks: globalThis.MeetTracks,
    openai: fakeOpenAI,
    notify: (m) => messages.push(m),
    openExternal: (url) => openedUrls.push(url),
    onState: (s) => states.push(s),
    onWarning: () => { warned++; },
    probeStt: async (url, key) => { probes.push({ url, key }); return probeAnswer; },
    startEngine: async () => engineAnswer,
    saveFile: async (name, blob, first) => {
      if (fakeStore.failSave) throw new Error(fakeStore.failSave);
      saved.push({ name, blob, first });
    },
    now: () => NOW,
  });
});

test('rekaman membuat entri desktop-<baseTime> dengan judul tanggal', async () => {
  const res = await ctl.handle(START);
  assert.deepEqual(res, { ok: true });
  const m = meeting();
  assert.equal(m.source, 'audio');
  assert.match(m.title, /\d/);
  assert.equal(m.endedAt, null);
  assert.deepEqual(data.meetings, [id]);
  assert.deepEqual(fakeStore.began[0], { meetingId: id, chunkMs: 120000, baseTime: NOW });
  assert.equal(fakeRecorder.options.chunkMs, 120000);
  assert.equal(fakeRecorder.options.mic, true);
});

test('get-active melaporkan rekaman dan meeting yang berjalan', async () => {
  await ctl.handle(START);
  const a = await ctl.handle({ type: 'get-active' });
  assert.equal(a.id, id);
  assert.equal(a.rec.recording, true);
  assert.equal(a.rec.transcribing, false);
  assert.equal(a.inCall, false);
});

test('klik ganda Rekam dan Stop hanya menghasilkan satu rekaman dan satu transkrip', async () => {
  const started = await Promise.all([ctl.handle(START), ctl.handle(START)]);
  assert.equal(fakeRecorder.starts, 1);
  assert.equal(started.filter((r) => r.ok).length, 1);
  await Promise.all([ctl.handle(STOP), ctl.handle(STOP)]);
  assert.equal(fakeRecorder.stops, 1);
  assert.equal(fakeOpenAI.transcribeCalls.length, 2);
});

test('gagal mulai merekam: state kembali idle dan entri tidak dibuat', async () => {
  fakeRecorder.failStart = 'tidak ada audio';
  const res = await ctl.handle(START);
  assert.deepEqual(res, { ok: false, error: 'tidak ada audio' });
  assert.equal(meeting(), undefined);
  assert.equal((await ctl.handle({ type: 'get-active' })).rec.recording, false);
  assert.equal(fakeStore.began.length, 0);
  fakeRecorder.failStart = null;
  assert.equal((await ctl.handle(START)).ok, true);
});

test('Stop mentranskrip kedua track dan memberi label', async () => {
  await runRecording();
  const m = meeting();
  assert.deepEqual(m.segments.map((s) => [s.speaker, s.text]).sort(), [['Others', 'teks system'], ['You', 'teks mic']]);
  assert.ok(m.endedAt);
  assert.ok(String(m.segments[0].id).startsWith(`audio:${NOW}:`));
  assert.equal(recStates().at(-1).transcribing, false);
  assert.equal(recStates().at(-1).error, null);
});

test('endpoint STT dari settings dipakai', async () => {
  await runRecording();
  assert.equal(fakeOpenAI.transcribeCalls[0].baseUrl, 'http://stt/v1');
  assert.ok(fakeOpenAI.transcribeCalls[0].model);
});

test('progres dilaporkan tanpa menghapus error', async () => {
  await runRecording();
  const progress = recStates().filter((m) => m.total);
  assert.equal(progress.at(0).total, 2);
  assert.ok(progress.every((m) => !('error' in m)));
});

test('STT mati saat Stop: audio utuh, error terlihat, transkrip ulang berhasil', async () => {
  fakeOpenAI.fail = new Error('Tidak bisa terhubung');
  await runRecording();
  assert.match(recStates().at(-1).error, /Tidak bisa terhubung/);
  assert.equal(fakeStore.removed.length, 0);
  assert.ok(meeting().segments.every((s) => s.text === '[transcript failed]'));
  fakeOpenAI.fail = null;
  assert.equal((await ctl.handle(regenerate(id, NOW))).ok, true);
  assert.ok(meeting().segments.some((s) => s.speaker === 'Others' && s.text === 'teks system'));
  assert.ok(!meeting().segments.some((s) => s.text === '[transcript failed]'));
});

test('transkrip ulang yang diblokir tidak mengubah baris lama', async () => {
  await runRecording();
  const before = structuredClone(meeting().segments);
  fakeOpenAI.failFor = 'system';
  const res = await ctl.handle(regenerate(id, NOW));
  assert.equal(res.ok, false);
  assert.match(res.error, /STT system mati/);
  assert.deepEqual(meeting().segments, before);
});

test('transkrip ulang ditolak saat sedang merekam', async () => {
  await ctl.handle(START);
  assert.equal((await ctl.handle(regenerate(id, NOW))).ok, false);
});

test('transkrip ulang menolak rekaman yang sudah tidak ada', async () => {
  await runRecording();
  const res = await ctl.handle(regenerate(id, 123));
  assert.equal(res.ok, false);
  assert.match(res.error, /no longer saved/);
});

test('potongan mikrofon sunyi dilewati, juga saat transkrip ulang', async () => {
  fakeRecorder.peaks = { system: [0.5], mic: [0.005] };
  await runRecording();
  assert.deepEqual(fakeOpenAI.transcribeCalls.map((c) => c.blob.track), ['system']);
  await ctl.handle(regenerate(id, NOW));
  assert.deepEqual(fakeOpenAI.transcribeCalls.map((c) => c.blob.track), ['system', 'system']);
});

test('mute diteruskan ke recorder dan state', async () => {
  await ctl.handle(START);
  await ctl.handle({ type: 'set-muted', on: true });
  assert.equal(fakeRecorder.muted, true);
  assert.equal((await ctl.handle({ type: 'get-active' })).rec.muted, true);
  assert.deepEqual(states.at(-1), { recording: true, transcribing: false, muted: true });
});

test('ubah judul tersimpan, judul kosong diabaikan', async () => {
  await ctl.handle(START);
  await ctl.handle({ type: 'rename-meeting', id, title: '  Rapat tim  ' });
  assert.equal(meeting().title, 'Rapat tim');
  await ctl.handle({ type: 'rename-meeting', id, title: '   ' });
  assert.equal(meeting().title, 'Rapat tim');
});

test('MoM tersimpan dan klik ganda hanya memanggil sekali', async () => {
  await runRecording();
  const results = await Promise.all([ctl.handle({ type: 'generate-mom', id }), ctl.handle({ type: 'generate-mom', id })]);
  assert.deepEqual(results[0], { ok: true, mom: 'MOM HASIL' });
  assert.equal(fakeOpenAI.momCalls, 1);
  assert.equal(meeting().mom, 'MOM HASIL');
  assert.ok(fakeOpenAI.momArgs.prompt.includes('teks system'));
});

test('MoM ditolak tanpa API key', async () => {
  await runRecording();
  data.settings.apiKey = '';
  const res = await ctl.handle({ type: 'generate-mom', id });
  assert.equal(res.ok, false);
  assert.match(res.error, /API key/);
});

test('recover menutup entri dari crash dan mempertahankan rekamannya', async () => {
  data['meeting:desktop-5'] = { id: 'desktop-5', title: 't', startedAt: 5, endedAt: null, segments: [], mom: null, source: 'audio' };
  data.meetings = ['desktop-5'];
  await ctl.recover();
  assert.ok(data['meeting:desktop-5'].endedAt);
  assert.equal(fakeStore.removed.length, 0);
});

test('recover menyalakan mikrofon bawaan hanya bila belum pernah diatur', async () => {
  data.settings = {};
  await ctl.recover();
  assert.equal(data.settings.mic, true);
  data.settings.mic = false;
  await ctl.recover();
  assert.equal(data.settings.mic, false);
});

test('send-to-ai membuka situs di browser default tanpa injeksi', async () => {
  await ctl.handle({ type: 'send-to-ai', target: 'gemini', text: 'p', id });
  await ctl.handle({ type: 'send-to-ai', target: 'chatgpt', text: 'p', id });
  await ctl.handle({ type: 'send-to-ai', target: 'lain', text: 'p', id });
  assert.deepEqual(openedUrls, ['https://gemini.google.com/app', 'https://chatgpt.com/']);
});

test('stop saat keluar aplikasi menyimpan rekaman tanpa menunggu STT', async () => {
  await ctl.handle(START);
  await ctl.handle({ type: 'stop-recording', transcribe: false });
  assert.equal(fakeRecorder.stops, 1);
  assert.equal(fakeOpenAI.transcribeCalls.length, 0);
  assert.ok(meeting().endedAt);
  assert.equal((await ctl.handle({ type: 'get-active' })).rec.transcribing, false);
});

test('peringatan recorder tampil tanpa mengubah state', async () => {
  await ctl.handle(START);
  ctl.warn('Mikrofon terputus.');
  assert.equal(recStates().at(-1).error, 'Mikrofon terputus.');
  assert.equal(recStates().at(-1).recording, true);
});

test('pesan tidak dikenal diabaikan', async () => {
  assert.equal(await ctl.handle({ type: 'constructor' }), undefined);
  assert.equal(await ctl.handle({ type: 'panel-tab-consumed' }), undefined);
});

test('main process tahu transkrip sedang berjalan setelah Stop', async () => {
  await runRecording();
  assert.ok(states.some((s) => !s.recording && s.transcribing));
  assert.deepEqual(states.at(-1), { recording: false, transcribing: false, muted: false });
});

test('main process tahu transkrip ulang sedang berjalan', async () => {
  await runRecording();
  states.length = 0;
  await ctl.handle(regenerate(id, NOW));
  assert.ok(states.some((s) => s.transcribing));
  assert.equal(states.at(-1).transcribing, false);
});

test('entri meeting gagal ditulis: recorder berhenti dan bisa merekam lagi', async () => {
  failWrites = true;
  const res = await ctl.handle(START);
  assert.deepEqual(res, { ok: false, error: 'disk penuh' });
  assert.equal(fakeRecorder.stops, 1);
  assert.equal((await ctl.handle({ type: 'get-active' })).rec.recording, false);
  failWrites = false;
  assert.equal((await ctl.handle(START)).ok, true);
});

test('Stop kedua menunggu rekaman selesai disimpan', async () => {
  let finishStop;
  const recorderStop = fakeRecorder.stop;
  fakeRecorder.stop = async function stop() {
    await new Promise((resolve) => { finishStop = resolve; });
    return recorderStop.call(this);
  };
  await ctl.handle(START);
  const first = ctl.handle(STOP);
  await new Promise((resolve) => setImmediate(resolve));
  let secondDone = false;
  const second = ctl.handle({ type: 'stop-recording', transcribe: false }).then(() => { secondDone = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondDone, false);
  finishStop();
  await second;
  assert.ok(meeting().endedAt);
  await first;
});

test('peringatan memberi tahu main process', async () => {
  ctl.warn('Mikrofon terputus.');
  assert.equal(warned, 1);
  assert.equal(recStates().at(-1).error, 'Mikrofon terputus.');
});

const DELETE = { type: 'delete-meeting', id };

test('hapus meeting menghapus transkrip, daftar, dan rekamannya', async () => {
  await runRecording();
  const res = await ctl.handle(DELETE);
  assert.deepEqual(res, { ok: true });
  assert.equal(meeting(), undefined);
  assert.deepEqual(data.meetings, []);
  assert.deepEqual(fakeStore.removed, [id]);
  assert.equal((await ctl.handle({ type: 'get-active' })).id, null);
  assert.ok(messages.some((m) => m.type === 'meeting-updated' && m.id === id));
});

test('hapus ditolak saat meeting itu sedang direkam', async () => {
  await ctl.handle(START);
  const res = await ctl.handle(DELETE);
  assert.equal(res.ok, false);
  assert.ok(meeting());
  assert.deepEqual(fakeStore.removed, []);
});

test('rekaman gagal dihapus: transkrip tetap ada dan error dilaporkan', async () => {
  await runRecording();
  fakeStore.failRemove = 'db rusak';
  assert.deepEqual(await ctl.handle(DELETE), { ok: false, error: 'db rusak' });
  assert.ok(meeting());
  assert.deepEqual(data.meetings, [id]);
});

test('settings tanpa nilai mic merekam dengan mikrofon', async () => {
  delete data.settings.mic;
  await ctl.handle(START);
  assert.equal(fakeRecorder.options.mic, true);
});

test('mic yang sengaja dimatikan tetap mati', async () => {
  data.settings.mic = false;
  await ctl.handle(START);
  assert.equal(fakeRecorder.options.mic, false);
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('STT tidak bisa dihubungi: peringatan setelah rekaman mulai, rekaman tetap jalan', async () => {
  probeAnswer = { ok: false, error: 'connection refused' };
  const res = await ctl.handle(START);
  await settle();
  assert.deepEqual(res, { ok: true });
  assert.equal(probes[0].url, 'http://stt/v1/models');
  assert.match(recStates().at(-1).error, /could not be reached/);
  assert.equal(recStates().at(-1).recording, true);
  assert.equal(warned, 1);
});

test('STT menolak key: peringatan menyebut key', async () => {
  probeAnswer = { ok: true, value: { ok: false, status: 401 } };
  await ctl.handle(START);
  await settle();
  assert.match(recStates().at(-1).error, /API key/);
});

test('STT server yang menjawab 404 tetap dianggap ada', async () => {
  probeAnswer = { ok: true, value: { ok: false, status: 404 } };
  await ctl.handle(START);
  await settle();
  assert.equal(warned, 0);
});

test('Stop menyimpan rekaman ke folder berurutan', async () => {
  await ctl.handle(START);
  await ctl.handle(STOP);
  assert.deepEqual(saved.map((s) => [s.blob.track, s.first]), [['mix-0', true], ['mix-1', false]]);
  assert.match(saved[0].name, new RegExp(`${NOW}\\.webm$`));
});

test('video ikut tersimpan sebagai file sendiri', async () => {
  fakeStore.video = { meetingId: id, baseTime: NOW, blobs: [blob('v-0')], indices: [0] };
  await ctl.handle(START);
  await ctl.handle(STOP);
  assert.ok(saved.some((s) => s.blob.track === 'v-0' && /-video\.webm$/.test(s.name)));
});

test('simpan otomatis bisa dimatikan', async () => {
  data.settings.autoSave = false;
  await ctl.handle(START);
  await ctl.handle(STOP);
  assert.deepEqual(saved, []);
});

test('gagal menyimpan ke folder: transkrip tetap jalan dan pengguna diberi tahu', async () => {
  fakeStore.failSave = 'disk full';
  await ctl.handle(START);
  await ctl.handle(STOP);
  assert.equal(warned, 1);
  assert.ok(messages.some((m) => m.type === 'rec-state' && /disk full/.test(m.error ?? '')));
  assert.ok(meeting().segments.length > 0);
});

test('keluar saat merekam tetap menyimpan ke folder', async () => {
  await ctl.handle(START);
  await ctl.handle({ type: 'stop-recording', transcribe: false });
  assert.equal(saved.length, 2);
});

test('potongan yang tersimpan saat merekam langsung masuk ke transkrip', async () => {
  await ctl.handle(START);
  ctl.chunkSaved();
  await settle();
  assert.equal(fakeOpenAI.transcribeCalls.length, 2);
  assert.equal(meeting().segments.length, 2);
  assert.ok(String(meeting().segments[0].id).startsWith(`audio:${NOW}:`));
});

test('Stop tidak mengirim ulang potongan yang sudah ditranskrip', async () => {
  await ctl.handle(START);
  ctl.chunkSaved();
  await settle();
  await ctl.handle(STOP);
  assert.equal(fakeOpenAI.transcribeCalls.length, 2);
  assert.equal(meeting().segments.length, 2);
  assert.equal(recStates().at(-1).error, null);
});

test('transkrip saat merekam bisa dimatikan', async () => {
  data.settings.liveTranscript = false;
  await ctl.handle(START);
  ctl.chunkSaved();
  await settle();
  assert.equal(fakeOpenAI.transcribeCalls.length, 0);
  await ctl.handle(STOP);
  assert.equal(fakeOpenAI.transcribeCalls.length, 2);
});

test('potongan mikrofon yang sunyi tidak dikirim saat merekam', async () => {
  fakeRecorder.peaks = { system: [0.5], mic: [0.001] };
  await ctl.handle(START);
  ctl.chunkSaved();
  await settle();
  assert.deepEqual(fakeOpenAI.transcribeCalls.map((c) => c.blob.track), ['system']);
});

test('STT mati saat merekam: diberi tahu, dan Stop mencoba lagi', async () => {
  fakeOpenAI.fail = new Error('STT mati');
  await ctl.handle(START);
  ctl.chunkSaved();
  await settle();
  assert.match(recStates().at(-1).error, /paused/);
  assert.equal(recStates().at(-1).recording, true);
  fakeOpenAI.fail = null;
  await ctl.handle(STOP);
  assert.deepEqual(meeting().segments.map((s) => s.text).sort(), ['teks mic', 'teks system']);
});

test('keluar saat merekam tidak menunggu transkrip berjalan', async () => {
  await ctl.handle(START);
  let answer;
  fakeOpenAI.transcribeAudio = () => new Promise((resolve) => { answer = resolve; });
  ctl.chunkSaved();
  await settle();
  await ctl.handle({ type: 'stop-recording', transcribe: false });
  assert.equal(recStates().at(-1).transcribing, false);
  answer({ segments: [] });
  await settle();
});

test('potongan dari rekaman yang sudah berhenti diabaikan', async () => {
  await ctl.handle(START);
  await ctl.handle(STOP);
  const calls = fakeOpenAI.transcribeCalls.length;
  ctl.chunkSaved();
  await settle();
  assert.equal(fakeOpenAI.transcribeCalls.length, calls);
});

test('MoM otomatis dibuat setelah transkrip selesai', async () => {
  data.settings.autoMom = true;
  await runRecording();
  await settle();
  assert.equal(meeting().mom, 'MOM HASIL');
});

test('MoM otomatis mati secara bawaan', async () => {
  await runRecording();
  await settle();
  assert.equal(fakeOpenAI.momCalls ?? 0, 0);
});

test('MoM otomatis dilewati bila transkrip gagal sebagian', async () => {
  data.settings.autoMom = true;
  fakeOpenAI.failFor = 'mic';
  await runRecording();
  await settle();
  assert.equal(fakeOpenAI.momCalls ?? 0, 0);
});

test('MoM otomatis gagal: pengguna diberi tahu', async () => {
  data.settings.autoMom = true;
  fakeOpenAI.generateMoM = async () => { throw new Error('LLM down'); };
  await runRecording();
  await settle();
  assert.match(recStates().at(-1).error, /LLM down/);
});

async function startWithEngine(answer) {
  globalThis.desktop = {};
  engineAnswer = answer;
  data.settings = { sttMode: 'builtin' };
  try {
    await ctl.handle(START);
    await settle();
  } finally {
    delete globalThis.desktop;
    engineAnswer = { ok: true, value: 'http://127.0.0.1:1/v1' };
  }
}

test('built-in engine starts with the recording, and no address is probed', async () => {
  await startWithEngine({ ok: true, value: 'http://127.0.0.1:1/v1' });
  assert.equal(probes.length, 0);
  assert.equal(warned, 0);
});

test('a built-in engine that cannot start warns and recording continues', async () => {
  await startWithEngine({ ok: false, error: 'The built-in speech engine is not installed.' });
  assert.equal(warned, 1);
  assert.ok(messages.some((m) => m.error?.startsWith('The built-in speech engine is not installed. Recording continues')));
  assert.equal(meeting().endedAt, null);
});

test('a folder warning at stop stays on screen', async () => {
  fakeStore.failSave = 'disk full';
  await ctl.handle(START);
  await ctl.handle({ type: 'stop-recording' });
  assert.match(recStates().at(-1).error, /could not be saved to your folder/);
});

test('a warning from before stop does not come back', async () => {
  await ctl.handle(START);
  ctl.warn('Microphone disconnected.');
  await ctl.handle({ type: 'stop-recording' });
  assert.equal(recStates().at(-1).error, null);
});

test('the live pause message clears after a later part succeeds', async () => {
  await ctl.handle(START);
  await settle();
  fakeOpenAI.fail = new Error('STT off');
  ctl.chunkSaved();
  await settle();
  assert.match(recStates().at(-1).error, /paused/);
  fakeOpenAI.fail = null;
  ctl.chunkSaved();
  await settle();
  assert.equal(recStates().at(-1).error, null);
});

test('a newer warning is not cleared by a later live success', async () => {
  await ctl.handle(START);
  await settle();
  fakeOpenAI.fail = new Error('STT off');
  ctl.chunkSaved();
  await settle();
  ctl.warn('Microphone disconnected.');
  fakeOpenAI.fail = null;
  ctl.chunkSaved();
  await settle();
  assert.equal(recStates().filter((s) => 'error' in s).at(-1).error, 'Microphone disconnected.');
});
