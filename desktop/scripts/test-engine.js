const { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { setTimeout: sleep } = require('node:timers/promises');
const { join, resolve } = require('node:path');
const { createEngine } = require('../main/engine');
const { createModels, MODELS } = require('../main/models');
const { loadLib } = require('../main/net');
const { createSpeakers } = require('../main/speakers');

const SAMPLE_URL = 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/d1be6fde11ac6e0407606b4e42fe72d34add8037/samples/jfk.wav';
const EXPECTED_WORDS = /ask not what your country/i;
const ACCENTED_FOLDER = 'José 日本';
const VOICES_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/';
const VOICE_SAMPLES = { '0-four-speakers-zh.wav': 4, '1-two-speakers-en.wav': 2, '2-two-speakers-en.wav': 2, '3-two-speakers-en.wav': 2 };
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

async function checkSpeakers(dir) {
  const speakers = createSpeakers({ dir });
  if (!speakers.available()) throw new Error('The speaker tool is not installed.');
  for (const [file, expected] of Object.entries(VOICE_SAMPLES)) {
    const res = await fetch(VOICES_URL + file);
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    const started = Date.now();
    const found = new Set((await speakers.find(await res.arrayBuffer())).map((turn) => turn.speaker)).size;
    console.log(`${file} (${Math.round((Date.now() - started) / 1000)} s): ${found} voices`);
    if (found !== expected) throw new Error(`${file} has ${expected} voices, but ${found} were found.`);
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
