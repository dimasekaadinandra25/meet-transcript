const { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { setTimeout: sleep } = require('node:timers/promises');
const { join, resolve } = require('node:path');
const { createEngine } = require('../main/engine');
const { createModels, MODELS } = require('../main/models');
const { loadLib } = require('../main/net');
const { createSpeakers } = require('../main/speakers');
require('../../lib/wav.js');
require('../renderer/tracks.js');

const SAMPLE_URL = 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/d1be6fde11ac6e0407606b4e42fe72d34add8037/samples/jfk.wav';
const EXPECTED_WORDS = /ask not what your country/i;
const ACCENTED_FOLDER = 'José 日本';
const VOICES_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/';
const VOICE_SAMPLES = { '0-four-speakers-zh.wav': 4, '1-two-speakers-en.wav': 2, '2-two-speakers-en.wav': 2, '3-two-speakers-en.wav': 2 };
const VOICE_MATCH_SAMPLE = '1-two-speakers-en.wav';
const VOICE_CLIP_SECONDS = 6;
const VOICE_MATCH_SHARE = 0.8;
const SPEECH_RATE = 16000;
const DOWNLOAD_TRIES = 4;
const DOWNLOAD_WAIT_MS = 30000;

async function transcribe(engine, bytes, prompt) {
  const baseUrl = await engine.url();
  const blob = new Blob([bytes], { type: 'audio/wav' });
  const result = await globalThis.MeetOpenAI.transcribeAudio({ blob, baseUrl, model: 'whisper-1', language: '', prompt });
  return (result.segments ?? []).map((segment) => segment.text).join(' ');
}

async function check(name, engine, bytes, prompt) {
  const started = Date.now();
  const text = await transcribe(engine, bytes, prompt);
  console.log(`${name} (${Math.round((Date.now() - started) / 1000)} s): ${text.trim()}`);
  if (!EXPECTED_WORDS.test(text)) throw new Error(`${name} did not transcribe the sample correctly.`);
}

function pcmOf(bytes) {
  const view = new DataView(bytes);
  let format = { channels: 0, rate: 0, bits: 0 };
  for (let at = 12; at + 8 <= view.byteLength;) {
    const id = String.fromCharCode(...new Uint8Array(bytes, at, 4));
    const size = view.getUint32(at + 4, true);
    if (id === 'fmt ') format = { channels: view.getUint16(at + 10, true), rate: view.getUint32(at + 12, true), bits: view.getUint16(at + 22, true) };
    if (id === 'data') {
      if (format.channels !== 1 || format.rate !== SPEECH_RATE || format.bits !== 16) throw new Error('The voice sample is not 16 kHz mono.');
      return new Int16Array(bytes.slice(at + 8, at + 8 + size));
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('The voice sample has no audio.');
}

async function checkVoiceMatch(speakers, bytes) {
  const turns = await speakers.find(bytes);
  const pcm = pcmOf(bytes);
  const sources = [...new Set(turns.map((turn) => turn.speaker))]
    .map((id) => turns.filter((turn) => turn.speaker === id).sort((a, b) => (b.end - b.start) - (a.end - a.start))[0]);
  const clips = sources.map((turn) => pcm.subarray(Math.round(turn.start * SPEECH_RATE), Math.round(Math.min(turn.end, turn.start + VOICE_CLIP_SECONDS) * SPEECH_RATE)));
  const references = [];
  let offset = 0;
  for (const [i, clip] of clips.entries()) {
    references.push({ name: `voice ${sources[i].speaker}`, start: offset, end: offset + clip.length / SPEECH_RATE });
    offset += clip.length / SPEECH_RATE;
  }
  const joined = Float32Array.from([...clips.flatMap((clip) => [...clip]), ...pcm], (sample) => sample / 32768);
  const found = await speakers.find(globalThis.MeetWav.encodeWav(joined, SPEECH_RATE));
  const lines = turns.filter((turn) => !sources.includes(turn)).map((turn) => ({ start: turn.start, end: turn.end, text: 'x', truth: `voice ${turn.speaker}` }));
  const named = globalThis.MeetTracks.labelSpeakers({ indices: [0], results: [{ segments: lines }] }, { starts: [offset], turns: found, references });
  const seconds = (list) => list.reduce((sum, s) => sum + s.end - s.start, 0);
  const segments = named.results[0].segments;
  const agreement = seconds(segments.filter((s) => s.speaker === s.truth)) / seconds(segments);
  console.log(`saved voices named ${Math.round(agreement * 100)}% of the other lines correctly`);
  if (!(agreement >= VOICE_MATCH_SHARE)) throw new Error(`Saved voices named only ${Math.round(agreement * 100)}% of lines correctly.`);
}

async function checkSpeakers(dir) {
  const speakers = createSpeakers({ dir });
  if (!speakers.available()) throw new Error('The speaker tool is not installed.');
  for (const [file, expected] of Object.entries(VOICE_SAMPLES)) {
    const res = await fetch(VOICES_URL + file);
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    const started = Date.now();
    const found = new Set((await speakers.find(bytes)).map((turn) => turn.speaker)).size;
    console.log(`${file} (${Math.round((Date.now() - started) / 1000)} s): ${found} voices`);
    if (found !== expected) throw new Error(`${file} has ${expected} voices, but ${found} were found.`);
    if (file === VOICE_MATCH_SAMPLE) await checkVoiceMatch(speakers, bytes);
  }
}

function copyFolder(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (statSync(join(from, name)).isDirectory()) copyFolder(join(from, name), join(to, name));
    else copyFileSync(join(from, name), join(to, name));
  }
}

async function downloadWithRetries(models, id) {
  for (let tries = DOWNLOAD_TRIES; ; tries--) {
    try {
      return await models.download(id);
    } catch (e) {
      if (tries <= 1) throw e;
      console.log(`${id} download failed (${e.cause?.code ?? e.message}), trying again.`);
      await sleep(DOWNLOAD_WAIT_MS);
    }
  }
}

async function fetchModel(models, id, modelsDir) {
  const file = MODELS[id].file;
  const cacheDir = process.env.MODEL_CACHE ?? '';
  const cached = cacheDir && join(cacheDir, file);
  if (cached && existsSync(cached)) {
    mkdirSync(modelsDir, { recursive: true });
    copyFileSync(cached, join(modelsDir, file));
    return;
  }
  await downloadWithRetries(models, id);
  if (!cached) return;
  mkdirSync(cacheDir, { recursive: true });
  copyFileSync(join(modelsDir, file), cached);
}

async function main() {
  loadLib(join(__dirname, '..', '..'));
  const res = await fetch(SAMPLE_URL);
  if (!res.ok) throw new Error(`Sample: HTTP ${res.status}`);
  const bytes = await res.arrayBuffer();
  const dir = mkdtempSync(join(tmpdir(), 'transcripables-models-'));
  const account = join(dir, ACCENTED_FOLDER);
  copyFolder(resolve(process.argv[2] ?? join(__dirname, '..', 'engine')), join(account, 'engine'));
  const engine = createEngine({ dir: join(account, 'engine') });
  const models = createModels({ dir: join(account, 'models'), onProgress: () => {} });
  try {
    if (!engine.available()) throw new Error('The speech engine is not installed.');
    await check('standard', engine, bytes);
    await check('standard with vocabulary', engine, bytes, 'Kennedy, Americans');
    await checkSpeakers(join(account, 'engine', 'speakers'));
    for (const id of Object.keys(MODELS)) {
      await fetchModel(models, id, join(account, 'models'));
      engine.useModel(models.pathOf(id));
      await check(id, engine, bytes);
    }
  } finally {
    engine.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

main().then(() => process.exit(0), (e) => {
  console.error(e.message);
  process.exit(1);
});
