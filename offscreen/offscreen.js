let audioCtx = null;
let stream = null;
let micStream = null;
let micJoining = false;
let mixNode = null;
let recStream = null;
let recorder = null;
let videoRecorder = null;
let rotateTimer = null;
let silenceTimer = null;
let chunkBlobs = [];
let pendingSaves = [];
let cfg = null;

let busy = false;
let sttRunning = false;
const MIME = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
  ? 'audio/webm;codecs=opus' : 'audio/webm';
const VIDEO_MIME = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
  ? 'video/webm;codecs=vp9,opus' : 'video/webm';

function toSW(msg) { chrome.runtime.sendMessage(msg).catch(() => {}); }
const warn = (error) => toSW({ type: 'audio-warn', meetingId: cfg?.meetingId, error });
const stopTracks = (s) => s?.getTracks().forEach((t) => t.stop());
const trackSave = (save, failText) => pendingSaves.push(save.catch((e) => warn(failText + e.message)));

async function releaseMedia() {
  stopTracks(stream);
  stopTracks(micStream);
  micStream = null; mixNode = null; recStream = null;
  await audioCtx?.close().catch(() => {});
}

function startChunkRecorder() {
  const data = [];
  const recId = cfg.baseTime;
  recorder = new MediaRecorder(recStream, { mimeType: MIME });
  recorder.ondataavailable = (e) => { if (e.data.size) data.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(data, { type: MIME });
    chunkBlobs.push(blob);
    trackSave(globalThis.MeetAudioStore.appendChunk(blob, recId),
      'Satu potongan audio gagal disimpan untuk transkrip ulang: ');
  };
  recorder.start();
}

function stopSilenceWatch() {
  if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = null; }
}

function watchSilence(source) {
  const an = audioCtx.createAnalyser();
  an.fftSize = 2048;
  source.connect(an);
  const buf = new Float32Array(an.fftSize);
  let quiet = 0;
  silenceTimer = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    if (Math.max(...buf.map(Math.abs)) > 0.01) return stopSilenceWatch();
    if (++quiet < 15) return;
    stopSilenceWatch();
    warn('Belum ada suara masuk 15 detik. ' + (micStream
      ? 'Tab dan mikrofon sama-sama sunyi — cek mic dan apakah ada yang bicara.'
      : 'Yang direkam hanya audio tab (peserta lain) — suara mikrofonmu sendiri TIDAK '
        + 'ikut terekam (centang "Rekam mikrofon" di Settings). Kalau tak ada peserta '
        + 'lain yang bersuara, rekaman akan kosong dan transkripnya juga.'));
  }, 1000);
}

async function joinMic() {
  if (micStream || micJoining || !audioCtx) return;
  micJoining = true;
  let s;
  try {
    s = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    toSW({ type: 'mic-denied', meetingId: cfg?.meetingId, name: e.name, error: e.message });
    return;
  } finally {
    micJoining = false;
  }
  try {
    audioCtx.createMediaStreamSource(s).connect(mixNode);
    micStream = s;
  } catch {
    stopTracks(s);
  }
}

function rotateChunk() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  startChunkRecorder();
}

function startVideoRecorder() {
  const recId = cfg.baseTime;
  videoRecorder = new MediaRecorder(
    new MediaStream([...stream.getVideoTracks(), ...recStream.getAudioTracks()]), {
    mimeType: VIDEO_MIME,
    videoBitsPerSecond: 500_000,
    audioBitsPerSecond: 48_000,
  });
  videoRecorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    trackSave(globalThis.MeetAudioStore.appendVideoPart(e.data, recId),
      'Satu potongan video gagal disimpan — file video bisa rusak mulai menit itu: ');
  };
  videoRecorder.start(60000);
}

async function start(msg) {
  if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
  stopSilenceWatch();
  if (recorder && recorder.state !== 'inactive') { recorder.onstop = null; recorder.stop(); }
  if (videoRecorder && videoRecorder.state !== 'inactive') {
    videoRecorder.ondataavailable = null;
    videoRecorder.stop();
  }
  videoRecorder = null;
  await releaseMedia();
  cfg = msg;
  chunkBlobs = [];
  pendingSaves = [];
  const constraints = {
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: msg.streamId } },
  };
  if (msg.video) {
    constraints.video = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: msg.streamId,
      maxWidth: 1280, maxHeight: 720, maxFrameRate: 10 } };
  }
  stream = await navigator.mediaDevices.getUserMedia(constraints);
  const vTrack = stream.getVideoTracks()[0];
  if (vTrack) vTrack.contentHint = 'detail';
  stream.getAudioTracks()[0]?.addEventListener('ended', () => toSW({ type: 'stop-recording' }));
  await globalThis.MeetAudioStore.beginAudio(
    { meetingId: msg.meetingId, chunkMs: msg.chunkMs, baseTime: msg.baseTime });
  audioCtx = new AudioContext();
  const src = audioCtx.createMediaStreamSource(stream);
  src.connect(audioCtx.destination);
  mixNode = audioCtx.createGain();
  src.connect(mixNode);
  const dest = audioCtx.createMediaStreamDestination();
  mixNode.connect(dest);
  recStream = dest.stream;
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  watchSilence(mixNode);
  if (msg.mic) joinMic();
  startChunkRecorder();
  if (msg.video) {
    try {
      startVideoRecorder();
    } catch (e) {
      videoRecorder = null;
      warn('Rekaman video gagal dimulai (' + e.message + ') — rekaman audio & transkrip jalan terus.');
    }
  }
  rotateTimer = setInterval(rotateChunk, msg.chunkMs);
}

function transcribeOne(blob, c) {
  return globalThis.MeetOpenAI.transcribeAudio({
    blob, baseUrl: c.baseUrl, apiKey: c.apiKey,
    model: c.sttModel, language: c.sttLanguage,
  });
}

async function transcribeChunks(blobs, c, replace) {
  sttRunning = true;
  try {
    const results = [];
    for (let i = 0; i < blobs.length; i++) {
      toSW({ type: 'audio-progress', meetingId: c.meetingId, done: i, total: blobs.length });
      try {
        results.push(await transcribeOne(blobs[i], c));
      } catch (e) {
        results.push({ error: e.message });
      }
    }
    const errs = results.filter((r) => r?.error).map((r) => r.error);
    const errSummary = errs.length ? `${errs.length}/${blobs.length} potongan gagal ditranskrip: ${errs[0]}` : null;
    if (replace && !results.some((r) => r && !r.error && r.segments?.length)) {
      throw new Error('Transkrip tidak menghasilkan teks — transkrip yang ada tidak diubah.'
        + (errs.length ? ` Error STT: ${errs[0]}` : ' Cek endpoint/model STT di Settings.'));
    }
    const segments = globalThis.MeetStt.mergeSttChunks(results, c.chunkMs, c.baseTime, c.indices);
    toSW({ type: 'audio-transcript', meetingId: c.meetingId, segments, baseTime: c.baseTime,
      replace: !!replace, legacy: !!c.legacy, error: errSummary });
  } finally {
    sttRunning = false;
  }
}

async function stopAndTranscribe() {
  if (!cfg) return;
  busy = true;
  try {
    clearInterval(rotateTimer);
    rotateTimer = null;
    stopSilenceWatch();
    const stopAndWait = (rec) => Promise.race([
      new Promise((resolve) => {
        if (!rec || rec.state === 'inactive') return resolve(true);
        rec.addEventListener('stop', () => resolve(true), { once: true });
        rec.stop();
      }),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    const pending = recorder;
    if (!await stopAndWait(pending)) {
      if (pending) pending.onstop = null;
      warn('Potongan terakhir gagal difinalisasi — bagian akhir rekaman mungkin hilang.');
    }
    const vPending = videoRecorder;
    if (!await stopAndWait(vPending)) {
      vPending.ondataavailable = null;
      warn('Potongan video terakhir gagal difinalisasi — ujung video mungkin hilang.');
    }
    await Promise.all(pendingSaves);
    pendingSaves = [];
    await releaseMedia();
    audioCtx = null; stream = null; recorder = null; videoRecorder = null;
    if (!cfg.transcribe) {
      chunkBlobs = [];
      toSW({ type: 'audio-saved', meetingId: cfg.meetingId });
      return;
    }
    const blobs = chunkBlobs;
    chunkBlobs = [];
    await transcribeChunks(blobs, cfg, false);
  } finally {
    busy = false;
  }
}

async function retranscribe(msg) {
  busy = true;
  try {
    const saved = await globalThis.MeetAudioStore.loadAudio(msg.recId);
    if (!saved) throw new Error('Audio rekaman tidak tersimpan lagi — hanya 5 rekaman terakhir yang disimpan.');
    if (saved.meetingId !== msg.meetingId) {
      throw new Error('Audio tersimpan milik meeting lain.');
    }
    await transcribeChunks(
      saved.blobs,
      { ...msg, chunkMs: saved.chunkMs, baseTime: saved.baseTime, indices: saved.indices, legacy: saved.legacy },
      true);
  } finally {
    busy = false;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;
  if (msg.op === 'start') {
    start(msg).then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  } else if (msg.op === 'stop') {
    if (busy || !recorder) {
      sendResponse({ ok: false, busy,
        error: busy ? 'Transkrip masih berjalan — perintah stop diabaikan.'
          : 'Tidak ada rekaman aktif — perintah stop diabaikan.' });
      return false;
    }
    sendResponse({ ok: true });
    stopAndTranscribe().catch((e) => toSW({ type: 'audio-error', meetingId: cfg?.meetingId, error: e.message }));
  } else if (msg.op === 'retranscribe') {
    if (busy || recorder) {
      sendResponse({ ok: false, error: 'Rekaman/transkrip masih berjalan.' });
      return false;
    }
    sendResponse({ ok: true });
    retranscribe(msg).catch((e) =>
      toSW({ type: 'audio-error', meetingId: msg.meetingId, error: e.message }));
  } else if (msg.op === 'state') {
    sendResponse({ ok: true, recording: !!recorder, transcribing: busy,
      meetingId: cfg?.meetingId ?? null, tabId: cfg?.tabId ?? null,
      autoStt: sttRunning || !!cfg?.transcribe });
    return false;
  } else if (msg.op === 'mic-enable') {
    sendResponse({ ok: true });
    if (cfg) cfg.mic = true;
    joinMic();
  } else if (msg.op === 'mic-join') {
    sendResponse({ ok: true });
    if (cfg?.mic) joinMic();
  }
  return false;
});
