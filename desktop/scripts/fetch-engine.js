const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const OUTPUT = process.argv[2] ?? join(__dirname, '..', 'engine');
const WINDOWS_TAR = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
const ZIP = {
  url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',
  sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
};
const MODEL = {
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin',
  sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898',
  file: 'ggml-base-q5_1.bin',
};
const PROGRAM_FILES = [
  'whisper-server.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll',
  'ggml-cpu-alderlake.dll', 'ggml-cpu-cannonlake.dll', 'ggml-cpu-cascadelake.dll', 'ggml-cpu-haswell.dll',
  'ggml-cpu-icelake.dll', 'ggml-cpu-sandybridge.dll', 'ggml-cpu-skylakex.dll', 'ggml-cpu-sse42.dll', 'ggml-cpu-x64.dll',
];

const digestOf = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function download({ url, sha256 }) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const digest = digestOf(bytes);
  if (digest !== sha256) throw new Error(`${url}: expected SHA-256 ${sha256}, got ${digest}`);
  return bytes;
}

async function fetchProgram() {
  if (PROGRAM_FILES.every((file) => existsSync(join(OUTPUT, file)))) return;
  const temp = mkdtempSync(join(tmpdir(), 'transcripables-engine-'));
  try {
    const zip = join(temp, 'engine.zip');
    writeFileSync(zip, await download(ZIP));
    execFileSync(WINDOWS_TAR, ['-xf', zip, '-C', OUTPUT, '--strip-components=1', ...PROGRAM_FILES.map((file) => `Release/${file}`)]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function fetchModel() {
  const path = join(OUTPUT, MODEL.file);
  if (existsSync(path) && digestOf(readFileSync(path)) === MODEL.sha256) return;
  writeFileSync(path, await download(MODEL));
}

async function main() {
  mkdirSync(OUTPUT, { recursive: true });
  await fetchProgram();
  await fetchModel();
  console.log(`Speech engine ready in ${OUTPUT}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
