let audioCtx = null;
let stream = null;
let micStream = null;
let micJoining = false;
let mixNode = null;
let tabGate = null;
let paused = false;
let currentChunk = { heard: true };
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

// Sends a message to the service worker, ignoring the error when nobody listens.
function toSW(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// Shows a warning in the panel without stopping the recording.
const warn = (error) => toSW({ type: 'audio-warn', meetingId: cfg?.meetingId, error });

// Stops every track of a media stream, if there is one.
const stopTracks = (mediaStream) => mediaStream?.getTracks().forEach((track) => track.stop());

// Remembers a pending save so stopping can wait for it, and warns if it fails.
const trackSave = (save, failText) => pendingSaves.push(save.catch((e) => warn(failText + e.message)));

// Stops the tab and microphone streams and closes the audio graph.
async function releaseMedia() {
  stopTracks(stream);
  stopTracks(micStream);
  micStream = null;
  mixNode = null;
  recStream = null;
  await audioCtx?.close().catch(() => {});
}

// Starts recording a new audio part and saves it when the part ends.
function startChunkRecorder() {
  const data = [];
  const recId = cfg.baseTime;
  const chunk = { heard: !paused };
  currentChunk = chunk;
  recorder = new MediaRecorder(recStream, { mimeType: MIME });
  recorder.ondataavailable = (e) => {
    if (e.data.size) data.push(e.data);
  };
  recorder.onstop = () => {
    const blob = new Blob(data, { type: MIME });
    const index = chunkBlobs.length;
    chunkBlobs.push(chunk.heard ? blob : null);
    if (!chunk.heard) return;
    trackSave(globalThis.MeetAudioStore.appendChunk(blob, recId, index),
      'An audio part could not be saved for retranscribing: ');
  };
  recorder.start();
}

// Stops checking the recording for silence.
function stopSilenceWatch() {
  if (silenceTimer) {
    clearInterval(silenceTimer);
    silenceTimer = null;
  }
}

// Warns once if the recording stays silent for its first 15 seconds.
function watchSilence(source) {
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let quietSeconds = 0;
  silenceTimer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    if (Math.max(...samples.map(Math.abs)) > 0.01) return stopSilenceWatch();
    if (++quietSeconds < 15) return;
    stopSilenceWatch();
    warn('No sound for 15 seconds. ' + (micStream
      ? 'The tab and microphone are both silent. Check your mic and whether anyone is speaking.'
      : 'Only tab audio (other people) is being recorded. Your own microphone is NOT '
        + 'included (tick "Record microphone" in Settings). If nobody else '
        + 'speaks, the recording and its transcript will be empty.'));
  }, 1000);
}

// Adds the user's microphone to the recording mix.
async function joinMic() {
  if (micStream || micJoining || !audioCtx) return;
  micJoining = true;
  let mic;
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    toSW({ type: 'mic-denied', meetingId: cfg?.meetingId, name: e.name, error: e.message });
    return;
  } finally {
    micJoining = false;
  }
  try {
    audioCtx.createMediaStreamSource(mic).connect(mixNode);
    micStream = mic;
    setTracksOn(mic, !paused);
  } catch {
    stopTracks(mic);
  }
}

// Turns every track of a stream on or off.
function setTracksOn(source, on) {
  for (const track of source?.getTracks() ?? []) track.enabled = on;
}

// Pauses or resumes recording by muting the tab, microphone and video.
function setPaused(on) {
  if (!recorder) return;
  paused = on;
  if (tabGate) tabGate.gain.value = on ? 0 : 1;
  setTracksOn(micStream, !on);
  for (const track of stream?.getVideoTracks() ?? []) track.enabled = !on;
  if (on) stopSilenceWatch();
  else currentChunk.heard = true;
}

// Ends the current audio part and starts the next one.
function rotateChunk() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  startChunkRecorder();
}

// Starts recording tab video with the mixed audio, saving a part every minute.
function startVideoRecorder() {
  const recId = cfg.baseTime;
  const videoStream = new MediaStream([...stream.getVideoTracks(), ...recStream.getAudioTracks()]);
  videoRecorder = new MediaRecorder(videoStream, {
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

// Captures the tab (and optionally the microphone and video) and starts recording.
async function start(msg) {
  if (rotateTimer) {
    clearInterval(rotateTimer);
    rotateTimer = null;
  }
  stopSilenceWatch();
  if (recorder && recorder.state !== 'inactive') {
    recorder.onstop = null;
    recorder.stop();
  }
  if (videoRecorder && videoRecorder.state !== 'inactive') {
    videoRecorder.ondataavailable = null;
    videoRecorder.stop();
  }
  videoRecorder = null;
  await releaseMedia();
  cfg = msg;
  paused = false;
  chunkBlobs = [];
  pendingSaves = [];
  const constraints = {
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: msg.streamId } },
  };
  if (msg.video) {
    constraints.video = {
      mandatory: {
        chromeMediaSource: 'tab', chromeMediaSourceId: msg.streamId,
        maxWidth: 1280, maxHeight: 720, maxFrameRate: 10,
      },
    };
  }
  stream = await navigator.mediaDevices.getUserMedia(constraints);
  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) videoTrack.contentHint = 'detail';
  stream.getAudioTracks()[0]?.addEventListener('ended', () => toSW({ type: 'stop-recording' }));
  await globalThis.MeetAudioStore.beginAudio({
    meetingId: msg.meetingId, chunkMs: msg.chunkMs, baseTime: msg.baseTime, keep: msg.keepRecordings,
  });
  audioCtx = new AudioContext();
  const tabSource = audioCtx.createMediaStreamSource(stream);
  tabSource.connect(audioCtx.destination);
  mixNode = audioCtx.createGain();
  tabGate = audioCtx.createGain();
  tabSource.connect(tabGate);
  tabGate.connect(mixNode);
  const destination = audioCtx.createMediaStreamDestination();
  mixNode.connect(destination);
  recStream = destination.stream;
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

// Sends one audio part to speech-to-text, matching voices across parts when the model names speakers.
function transcribeOne(blob, config, voices) {
  const send = (knownSpeakers) => globalThis.MeetOpenAI.transcribeAudio({
    blob, baseUrl: config.baseUrl, apiKey: config.apiKey,
    model: config.sttModel, language: config.sttLanguage, knownSpeakers, prompt: config.sttVocabulary,
  });
  if (!globalThis.MeetStt.isDiarizeModel(config.sttModel)) return send();
  return globalThis.MeetStt.sendWithVoices({ send, blob, voices, makeClip: globalThis.MeetWav.clipDataUrl });
}

// Transcribes every audio part in order and sends the merged transcript to the service worker.
async function transcribeChunks(blobs, config, replace) {
  sttRunning = true;
  try {
    const results = [];
    const voices = globalThis.MeetStt.createVoiceMemory();
    for (let i = 0; i < blobs.length; i++) {
      toSW({ type: 'audio-progress', meetingId: config.meetingId, done: i, total: blobs.length });
      if (!blobs[i]) {
        results.push({ segments: [] });
        continue;
      }
      try {
        results.push(await transcribeOne(blobs[i], config, voices));
      } catch (e) {
        results.push({ error: e.message });
      }
    }
    const errors = results.filter((result) => result?.error).map((result) => result.error);
    const errorSummary = errors.length
      ? `${errors.length}/${blobs.length} parts failed to transcribe: ${errors[0]}`
      : null;
    const gotText = results.some((result) => result && !result.error && result.segments?.length);
    if (replace && !gotText) {
      const hint = errors.length
        ? ` STT error: ${errors[0]}`
        : ' Check the speech-to-text address and model in Settings.';
      throw new Error('Transcription returned no text, so the existing transcript was not changed.' + hint);
    }
    const segments = globalThis.MeetStt.mergeSttChunks(
      results, config.chunkMs, config.baseTime, config.indices);
    toSW({
      type: 'audio-transcript', meetingId: config.meetingId, segments, baseTime: config.baseTime,
      replace: !!replace, legacy: !!config.legacy, error: errorSummary,
    });
  } finally {
    sttRunning = false;
  }
}

// Stops a recorder and waits up to 5 seconds for it; resolves false if it never stopped.
function stopAndWait(rec) {
  return Promise.race([
    new Promise((resolve) => {
      if (!rec || rec.state === 'inactive') return resolve(true);
      rec.addEventListener('stop', () => resolve(true), { once: true });
      rec.stop();
    }),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
}

// Stops recording, waits for every part to be saved, then transcribes or just reports it saved.
async function stopAndTranscribe() {
  if (!cfg) return;
  busy = true;
  try {
    clearInterval(rotateTimer);
    rotateTimer = null;
    stopSilenceWatch();
    const pending = recorder;
    if (!await stopAndWait(pending)) {
      if (pending) pending.onstop = null;
      warn('The last part could not be finished, so the end of the recording may be lost.');
    }
    const videoPending = videoRecorder;
    if (!await stopAndWait(videoPending)) {
      videoPending.ondataavailable = null;
      warn('The last video part could not be finished, so the end of the video may be lost.');
    }
    await Promise.all(pendingSaves);
    pendingSaves = [];
    await releaseMedia();
    audioCtx = null;
    stream = null;
    recorder = null;
    videoRecorder = null;
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

// Transcribes a saved recording again, replacing its earlier transcript.
async function retranscribe(msg) {
  busy = true;
  try {
    const saved = await globalThis.MeetAudioStore.loadAudio(msg.recId);
    if (!saved) throw new Error('The recording audio is no longer saved. Settings decides how many are kept.');
    if (saved.meetingId !== msg.meetingId) {
      throw new Error('The saved audio belongs to another meeting.');
    }
    const config = {
      ...msg, chunkMs: saved.chunkMs, baseTime: saved.baseTime, indices: saved.indices, legacy: saved.legacy,
    };
    await transcribeChunks(saved.blobs, config, true);
  } finally {
    busy = false;
  }
}

// Handles recorder commands sent by the service worker.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;
  if (msg.op === 'start') {
    start(msg).then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  } else if (msg.op === 'stop') {
    if (busy || !recorder) {
      const error = busy
        ? 'A transcript is still running, so the stop command was ignored.'
        : 'No active recording, so the stop command was ignored.';
      sendResponse({ ok: false, busy, error });
      return false;
    }
    sendResponse({ ok: true });
    stopAndTranscribe().catch((e) =>
      toSW({ type: 'audio-error', meetingId: cfg?.meetingId, error: e.message }));
  } else if (msg.op === 'retranscribe') {
    if (busy || recorder) {
      sendResponse({ ok: false, error: 'A recording or transcript is still running.' });
      return false;
    }
    sendResponse({ ok: true });
    retranscribe(msg).catch((e) =>
      toSW({ type: 'audio-error', meetingId: msg.meetingId, error: e.message }));
  } else if (msg.op === 'state') {
    sendResponse({
      ok: true, recording: !!recorder, transcribing: busy,
      meetingId: cfg?.meetingId ?? null, tabId: cfg?.tabId ?? null,
      autoStt: sttRunning || !!cfg?.transcribe, paused: !!recorder && paused,
    });
    return false;
  } else if (msg.op === 'pause') {
    setPaused(!!msg.on);
    sendResponse({ ok: true, paused });
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
