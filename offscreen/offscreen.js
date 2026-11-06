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
      'An audio part could not be saved for retranscribing: ');
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
    warn('No sound for 15 seconds. ' + (micStream
      ? 'The tab and microphone are both silent. Check your mic and whether anyone is speaking.'
      : 'Only tab audio (other people) is being recorded. Your own microphone is NOT '
        + 'included (tick "Record microphone" in Settings). If nobody else '
        + 'speaks, the recording and its transcript will be empty.'));
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
      'A video part could not be saved, so the video may be damaged from that minute: ');
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
    { meetingId: msg.meetingId, chunkMs: msg.chunkMs, baseTime: msg.baseTime, keep: msg.keepRecordings });
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
      warn('Video recording could not start (' + e.message + '). Audio and transcript keep running.');
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
    const errSummary = errs.length ? `${errs.length}/${blobs.length} parts failed to transcribe: ${errs[0]}` : null;
    if (replace && !results.some((r) => r && !r.error && r.segments?.length)) {
      throw new Error('Transcription returned no text, so the existing transcript was not changed.'
        + (errs.length ? ` STT error: ${errs[0]}` : ' Check the speech-to-text address and model in Settings.'));
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
      warn('The last part could not be finished, so the end of the recording may be lost.');
    }
    const vPending = videoRecorder;
    if (!await stopAndWait(vPending)) {
      vPending.ondataavailable = null;
      warn('The last video part could not be finished, so the end of the video may be lost.');
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
    if (!saved) throw new Error('The recording audio is no longer saved. Settings decides how many are kept.');
    if (saved.meetingId !== msg.meetingId) {
      throw new Error('The saved audio belongs to another meeting.');
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
        error: busy ? 'A transcript is still running, so the stop command was ignored.'
          : 'No active recording, so the stop command was ignored.' });
      return false;
    }
    sendResponse({ ok: true });
    stopAndTranscribe().catch((e) => toSW({ type: 'audio-error', meetingId: cfg?.meetingId, error: e.message }));
  } else if (msg.op === 'retranscribe') {
    if (busy || recorder) {
      sendResponse({ ok: false, error: 'A recording or transcript is still running.' });
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
