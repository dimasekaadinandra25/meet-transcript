const { cpSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { createEngine } = require('../main/engine');
const { createModels, MODELS } = require('../main/models');
const { loadLib } = require('../main/net');

const SAMPLE_URL = 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/d1be6fde11ac6e0407606b4e42fe72d34add8037/samples/jfk.wav';
const EXPECTED_WORDS = /ask not what your country/i;
const ACCENTED_FOLDER = 'José 日本';
const DOWNLOAD_TRIES = 3;

async function transcribe(engine, bytes) {
  const baseUrl = await engine.url();
  const blob = new Blob([bytes], { type: 'audio/wav' });
  const result = await globalThis.MeetOpenAI.transcribeAudio({ blob, baseUrl, model: 'whisper-1', language: '' });
  return (result.segments ?? []).map((segment) => segment.text).join(' ');
}

async function check(name, engine, bytes) {
  const started = Date.now();
  const text = await transcribe(engine, bytes);
  console.log(`${name} (${Math.round((Date.now() - started) / 1000)} s): ${text.trim()}`);
  if (!EXPECTED_WORDS.test(text)) throw new Error(`${name} did not transcribe the sample correctly.`);
}

async function downloadModel(models, id) {
  for (let tries = DOWNLOAD_TRIES; ; tries--) {
    try {
      return await models.download(id);
    } catch (e) {
      if (tries <= 1) throw e;
      console.log(`${id} download failed (${e.message}), trying again.`);
    }
  }
}

async function main() {
  loadLib(join(__dirname, '..', '..'));
  const res = await fetch(SAMPLE_URL);
  if (!res.ok) throw new Error(`Sample: HTTP ${res.status}`);
  const bytes = await res.arrayBuffer();
  const dir = mkdtempSync(join(tmpdir(), 'transcripables-models-'));
  const account = join(dir, ACCENTED_FOLDER);
  cpSync(resolve(process.argv[2] ?? join(__dirname, '..', 'engine')), join(account, 'engine'), { recursive: true });
  const engine = createEngine({ dir: join(account, 'engine') });
  const models = createModels({ dir: join(account, 'models'), onProgress: () => {} });
  try {
    if (!engine.available()) throw new Error('The speech engine is not installed.');
    await check('standard', engine, bytes);
    for (const id of Object.keys(MODELS)) {
      await downloadModel(models, id);
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
