import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

createRequire(import.meta.url)('../renderer/recorder.js');
const { createRecorder } = globalThis;

class FakeTrack {
  constructor(kind) {
    this.kind = kind;
    this.stopped = false;
    this.listeners = {};
  }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  emit(name) { this.listeners[name]?.(); }
  stop() { this.stopped = true; }
}

class FakeStream {
  constructor(tracks = []) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
}

let fake;
let warnings;
let deps;
let rec;
const opts = { baseTime: 1000, mic: true, video: false, chunkMs: 600000 };
const flush = () => new Promise((r) => setImmediate(r));

function makeFake() {
  const f = {
    connections: [],
    recorders: [],
    gains: [],
    intervals: [],
    tracks: [],
    analysers: [],
    level: 0,
    closed: false,
    store: { calls: { appendSystemChunk: [], appendMicChunk: [], appendMixPart: [], appendVideoPart: [] }, failures: {} },
  };
  const track = (kind) => {
    const t = new FakeTrack(kind);
    f.tracks.push(t);
    return t;
  };
  f.systemTrack = track('audio');
  f.videoTrack = track('video');
  f.micTrack = track('audio');
  for (const name of Object.keys(f.store.calls)) {
    f.store[name] = async (blob, recId) => {
      f.store.calls[name].push({ blob, recId });
      if (f.store.failures[name]) throw f.store.failures[name];
    };
  }
  const node = (extra) => ({ connect(to) { f.connections.push({ from: this, to }); }, ...extra });
  f.AudioContext = class {
    constructor() { f.ctx = this; this.destination = { speaker: true }; this.state = 'running'; this.sampleRate = f.sampleRate ?? 48000; }
    async resume() {}
    async close() { f.closed = true; }
    createMediaStreamSource(stream) { return node({ stream }); }
    createGain() { const g = node({ gain: { value: 1 } }); f.gains.push(g); return g; }
    createMediaStreamDestination() { return node({ stream: new FakeStream([track('audio')]) }); }
    createAnalyser() { const a = node({ fftSize: 2048, getFloatTimeDomainData: (b) => b.fill(f.level) }); f.analysers.push(a); return a; }
  };
  f.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor(stream, options) {
      if (f.rejectVideo && options.mimeType.startsWith('video')) throw new Error('codec ditolak');
      this.stream = stream;
      this.options = options;
      this.state = 'inactive';
      this.stopListeners = [];
      f.recorders.push(this);
    }
    start(timeslice) { this.state = 'recording'; this.timeslice = timeslice; }
    addEventListener(name, fn) { this.stopListeners.push(fn); }
    emitData(blob) { this.ondataavailable?.({ data: blob }); }
    stop() {
      this.state = 'inactive';
      this.emitData(new Blob(['x']));
      this.onstop?.();
      for (const fn of this.stopListeners) fn();
    }
  };
  f.targets = (from) => f.connections.filter((c) => c.from === from).map((c) => c.to);
  f.sourceOf = (t) => f.connections.map((c) => c.from).find((n) => n.stream?.getTracks().includes(t));
  f.parts = () => {
    const gain = f.gains[0];
    const system = f.sourceOf(f.systemTrack);
    const mix = f.targets(system).find((d) => f.targets(gain).includes(d));
    const micDest = f.targets(gain).find((d) => d !== mix);
    const systemDest = f.targets(system).find((d) => d !== mix);
    return { gain, system, mix, micDest, systemDest };
  };
  f.recorderFor = (dest) => f.recorders.filter((r) => r.stream === dest.stream).at(-1);
  f.running = () => f.recorders.filter((r) => r.state === 'recording');
  f.fire = (ms) => f.intervals.filter((i) => i.ms === ms && !i.cleared).forEach((i) => i.fn());
  return f;
}

beforeEach(() => {
  fake = makeFake();
  warnings = [];
  deps = {
    AudioContext: fake.AudioContext,
    MediaRecorder: fake.MediaRecorder,
    MediaStream: FakeStream,
    getDisplayMedia: async () => new FakeStream([fake.systemTrack, fake.videoTrack]),
    getUserMedia: async () => new FakeStream([fake.micTrack]),
    store: fake.store,
    warn: (m) => warnings.push(m),
    setInterval: (fn, ms) => { const i = { fn, ms }; fake.intervals.push(i); return i; },
    clearInterval: (i) => { i.cleared = true; },
  };
  rec = createRecorder(deps);
});

test('tidak menyambung sumber ke speaker', async () => {
  await rec.start(opts);
  assert.ok(!fake.connections.some((c) => c.to === fake.ctx.destination));
});

test('mute menutup gain mikrofon sebelum track mikrofon dan campuran', async () => {
  await rec.start(opts);
  const { gain, mix, micDest } = fake.parts();
  const micSource = fake.sourceOf(fake.micTrack);
  assert.ok(fake.targets(micSource).includes(gain));
  assert.ok(!fake.targets(micSource).includes(mix));
  assert.ok(!fake.targets(micSource).includes(micDest));
  rec.setMuted(true);
  assert.equal(gain.gain.value, 0);
  assert.equal(rec.isMuted(), true);
  assert.equal(fake.running().length, 3);
  rec.setMuted(false);
  assert.equal(gain.gain.value, 1);
  assert.equal(rec.isMuted(), false);
});

test('mute tidak terbawa ke rekaman berikutnya', async () => {
  await rec.start(opts);
  rec.setMuted(true);
  await rec.stop();
  assert.equal(rec.isMuted(), false);
  await rec.start({ ...opts, baseTime: 2000 });
  assert.equal(fake.gains.at(-1).gain.value, 1);
});

test('mute saat tidak merekam diabaikan', () => {
  rec.setMuted(true);
  assert.equal(rec.isMuted(), false);
});

test('STT berotasi, campuran tidak', async () => {
  await rec.start(opts);
  const { mix } = fake.parts();
  const mixRecorder = fake.recorderFor(mix);
  fake.fire(600000);
  assert.equal(mixRecorder.state, 'recording');
  assert.equal(mixRecorder.timeslice, 60000);
  assert.equal(fake.store.calls.appendSystemChunk.length, 1);
  assert.equal(fake.store.calls.appendMicChunk.length, 1);
  assert.equal(fake.store.calls.appendMixPart.length, 0);
  assert.equal(fake.running().length, 3);
  assert.equal(fake.store.calls.appendSystemChunk[0].recId, 1000);
});

test('track mikrofon sunyi sejak awal saat izin ditolak', async () => {
  deps.getUserMedia = async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); };
  await createRecorder(deps).start(opts);
  assert.match(warnings.at(-1), /microphone/i);
  assert.equal(fake.running().length, 3);
});

test('mikrofon dimatikan: tanpa track mikrofon dan tanpa meminta izin', async () => {
  deps.getUserMedia = async () => { throw new Error('tidak boleh dipanggil'); };
  await createRecorder(deps).start({ ...opts, mic: false });
  assert.equal(fake.running().length, 2);
  assert.deepEqual(warnings, []);
});

test('headset dicabut: peringatan dan track lain tetap jalan', async () => {
  await rec.start(opts);
  fake.micTrack.emit('ended');
  assert.match(warnings.at(-1), /microphone/i);
  assert.equal(fake.recorderFor(fake.parts().mix).state, 'recording');
  assert.equal(fake.running().length, 3);
});

test('kuota penuh: peringatan dan recorder tetap jalan', async () => {
  fake.store.failures.appendMixPart = new Error('QuotaExceededError');
  await rec.start(opts);
  const mixRecorder = fake.recorderFor(fake.parts().mix);
  mixRecorder.emitData(new Blob(['x']));
  await flush();
  assert.match(warnings.at(-1), /Quota/);
  assert.equal(mixRecorder.state, 'recording');
});

test('stop menunggu semua simpanan dan melepas track', async () => {
  let saved = false;
  fake.store.appendSystemChunk = async () => { await flush(); saved = true; };
  await rec.start(opts);
  await rec.stop();
  assert.equal(saved, true);
  assert.ok(fake.systemTrack.stopped && fake.micTrack.stopped && fake.videoTrack.stopped);
  assert.equal(fake.closed, true);
  assert.equal(fake.running().length, 0);
  assert.ok(fake.intervals.every((i) => i.cleared));
});

test('mode audio menghentikan track video', async () => {
  await rec.start(opts);
  assert.equal(fake.videoTrack.stopped, true);
  assert.equal(fake.systemTrack.stopped, false);
});

test('mode video memakai track video plus audio campuran', async () => {
  await rec.start({ ...opts, video: true });
  assert.equal(fake.videoTrack.stopped, false);
  const video = fake.recorders.find((r) => r.options.mimeType.startsWith('video'));
  assert.equal(video.timeslice, 60000);
  assert.equal(video.options.videoBitsPerSecond, 500000);
  assert.equal(video.options.audioBitsPerSecond, 48000);
  assert.ok(video.stream.getVideoTracks().includes(fake.videoTrack));
  assert.ok(video.stream.getAudioTracks().includes(fake.parts().mix.stream.getAudioTracks()[0]));
});

test('video gagal dimulai: peringatan dan audio tetap jalan', async () => {
  fake.rejectVideo = true;
  await rec.start({ ...opts, video: true });
  assert.match(warnings.at(-1), /video/i);
  assert.equal(fake.running().length, 3);
});

test('tanpa audio komputer rekaman gagal dimulai dengan jelas', async () => {
  deps.getDisplayMedia = async () => new FakeStream([fake.videoTrack]);
  await assert.rejects(createRecorder(deps).start(opts), /computer audio/i);
  assert.equal(fake.videoTrack.stopped, true);
});

test('prepare dipanggil setelah audio tersedia dan sebelum recorder mulai', async () => {
  const order = [];
  await rec.start({ ...opts, prepare: async () => { order.push(fake.recorders.length); } });
  assert.deepEqual(order, [0]);
});

test('prepare tidak dipanggil bila audio komputer tidak tersedia', async () => {
  deps.getDisplayMedia = async () => new FakeStream([fake.videoTrack]);
  let called = false;
  await assert.rejects(createRecorder(deps).start({ ...opts, prepare: async () => { called = true; } }));
  assert.equal(called, false);
});

test('start kedua saat merekam ditolak', async () => {
  await rec.start(opts);
  await assert.rejects(rec.start(opts), /still running/i);
  assert.equal(fake.running().length, 3);
});

test('puncak suara dicatat per potongan STT', async () => {
  await rec.start(opts);
  fake.level = 0.5;
  fake.fire(500);
  fake.fire(600000);
  fake.level = 0.1;
  fake.fire(500);
  const { peaks } = await rec.stop();
  assert.equal(peaks.system[0], 0.5);
  assert.ok(Math.abs(peaks.mic[1] - 0.1) < 1e-6);
});

test('pemeriksaan suara tidak menyisakan celah waktu', async () => {
  await rec.start(opts);
  const sampleMs = fake.intervals.map((i) => i.ms).find((ms) => ms < 1000);
  const windowMs = (fake.analysers[0].fftSize / 48000) * 1000;
  assert.ok(sampleMs, 'sampling interval');
  assert.ok(windowMs >= sampleMs, `window ${windowMs} ms, sampling every ${sampleMs} ms`);
});

test('audio komputer yang macet menggagalkan mulai rekam dengan pesan jelas', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  deps.getDisplayMedia = () => new Promise(() => {});
  const started = createRecorder(deps).start(opts);
  await flush();
  t.mock.timers.tick(15000);
  await assert.rejects(started, /did not start within 15 seconds/);
});

test('mikrofon yang macet tidak menahan rekaman, stream yang telat dihentikan', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let answer;
  deps.getUserMedia = () => new Promise((resolve) => { answer = resolve; });
  const started = rec.start(opts);
  await flush();
  await flush();
  t.mock.timers.tick(15000);
  await started;
  assert.match(warnings.at(-1), /microphone/i);
  assert.equal(fake.running().length, 3);
  let stopped = 0;
  answer({ getTracks: () => [{ stop() { stopped++; } }] });
  await flush();
  assert.equal(stopped, 1);
});

test('perangkat 96 kHz juga diperiksa tanpa celah waktu', async () => {
  fake.sampleRate = 96000;
  await rec.start(opts);
  const sampleMs = fake.intervals.map((i) => i.ms).find((ms) => ms < 1000);
  const windowMs = (fake.analysers[0].fftSize / 96000) * 1000;
  assert.ok(windowMs >= sampleMs, `window ${windowMs} ms, sampling every ${sampleMs} ms`);
});

const sampleFor = (ms) => {
  const sampleMs = fake.intervals.map((i) => i.ms).find((value) => value < 1000);
  for (let i = 0; i < ms / sampleMs; i++) fake.fire(sampleMs);
};

test('komputer tanpa suara selama semenit memberi satu peringatan', async () => {
  await rec.start(opts);
  fake.level = 0;
  sampleFor(59000);
  assert.ok(!warnings.some((w) => /No computer audio/.test(w)));
  sampleFor(120000);
  assert.equal(warnings.filter((w) => /No computer audio/.test(w)).length, 1);
});

test('komputer yang pernah bersuara tidak diperingatkan saat hening', async () => {
  await rec.start(opts);
  fake.level = 0.5;
  sampleFor(1000);
  fake.level = 0;
  sampleFor(120000);
  assert.ok(!warnings.some((w) => /No computer audio/.test(w)));
});

test('level suara dikirim tiap pemeriksaan', async () => {
  const levels = [];
  rec = createRecorder({ ...deps, onLevels: (l) => levels.push(l) });
  await rec.start(opts);
  fake.level = 0.25;
  sampleFor(500);
  assert.equal(levels.at(-1).system, 0.25);
  assert.equal(levels.at(-1).mic, 0.25);
});

test('recorder memberi tahu setelah potongan tersimpan', async () => {
  let saved = 0;
  rec = createRecorder({ ...deps, onChunkSaved: () => { saved++; } });
  await rec.start(opts);
  fake.fire(600000);
  await flush();
  assert.equal(saved, 2);
});

test('puncak suara yang berjalan bisa dibaca', async () => {
  await rec.start(opts);
  fake.level = 0.3;
  fake.fire(500);
  assert.ok(Math.abs(rec.currentPeaks().mic[0] - 0.3) < 1e-6);
});

const withApp = (over = {}) => {
  const opened = [];
  const closed = [];
  const appNode = { connect(to) { fake.connections.push({ from: appNode, to }); } };
  deps.chosenApp = () => 42;
  deps.openAppAudio = async (pid, ctx, onEnded) => {
    opened.push({ pid, ctx, onEnded });
    return { node: appNode, close: () => closed.push(pid) };
  };
  Object.assign(deps, over);
  return { opened, closed, appNode, rec: createRecorder(deps) };
};

test('recording one app does not ask for the whole computer sound', async () => {
  let asked = 0;
  const real = deps.getDisplayMedia;
  deps.getDisplayMedia = (...args) => { asked++; return real(...args); };
  const app = withApp();
  await app.rec.start({ ...opts, mic: false });
  assert.equal(asked, 0);
  assert.equal(app.opened[0].pid, 42);
  assert.ok(fake.connections.some((c) => c.from === app.appNode));
});

test('the helper stops when the recording stops', async () => {
  const app = withApp();
  await app.rec.start({ ...opts, mic: false });
  await app.rec.stop();
  assert.deepEqual(app.closed, [42]);
});

test('if the chosen app cannot be recorded, nothing starts', async () => {
  const app = withApp({ openAppAudio: async () => { throw new Error('That app could not be recorded.'); } });
  await assert.rejects(app.rec.start({ ...opts, mic: false }), /could not be recorded/);
  assert.equal(fake.store.calls.appendSystemChunk.length, 0);
});

test('video of one app takes the picture from the screen but not its sound', async () => {
  const app = withApp();
  await app.rec.start({ ...opts, mic: false, video: true });
  assert.equal(fake.systemTrack.stopped, true);
  assert.equal(fake.videoTrack.stopped, false);
  assert.ok(fake.connections.some((c) => c.from === app.appNode));
});

test('you are warned when the chosen app closes during a recording', async () => {
  const app = withApp();
  await app.rec.start({ ...opts, mic: false });
  app.opened[0].onEnded();
  assert.match(warnings.at(-1), /chosen app/);
});

test('with no app chosen, the whole computer sound is used as before', async () => {
  let asked = 0;
  const real = deps.getDisplayMedia;
  deps.getDisplayMedia = (...args) => { asked++; return real(...args); };
  const app = withApp({ chosenApp: () => null });
  await app.rec.start({ ...opts, mic: false });
  assert.equal(asked, 1);
  assert.equal(app.opened.length, 0);
});

test('a closed video window stops the recording instead of filming the whole screen', async () => {
  let filmed = false;
  deps.getDisplayMedia = async () => { filmed = true; return new FakeStream([fake.systemTrack, fake.videoTrack]); };
  deps.checkVideoSource = async () => { throw new Error('The window chosen for video is closed.'); };
  await assert.rejects(createRecorder(deps).start({ ...opts, video: true }), /is closed/);
  assert.equal(filmed, false);
});

test('audio-only recording does not care about the video window', async () => {
  deps.checkVideoSource = async () => { throw new Error('The window chosen for video is closed.'); };
  await createRecorder(deps).start({ ...opts, video: false });
});

test('each track part is saved with its own number', async () => {
  const seen = [];
  fake.store.appendSystemChunk = async (_blob, _recId, index) => { seen.push(index); };
  const recorder = createRecorder(deps);
  await recorder.start({ ...opts, mic: false });
  await recorder.stop();
  assert.deepEqual(seen, [0]);
});
