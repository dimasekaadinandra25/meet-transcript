const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const OUTPUT = process.argv[2] ?? join(__dirname, '..', 'engine');
const SYSTEM_DIR = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const WINDOWS_TAR = join(SYSTEM_DIR, 'tar.exe');
const RUNTIME_FILES = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'vcomp140.dll'];
const SOURCE = {
  repo: 'https://github.com/ggml-org/whisper.cpp.git',
  commit: 'd1be6fde11ac6e0407606b4e42fe72d34add8037',
};
const MAC_BUILD_FLAGS = [
  '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_EXAMPLES=ON',
  '-DGGML_NATIVE=OFF', '-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON', '-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0',
];
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

function buildProgramForMac() {
  const server = join(OUTPUT, 'whisper-server');
  if (existsSync(server)) return;
  const temp = mkdtempSync(join(tmpdir(), 'transcripables-engine-'));
  const inSource = (command, ...args) => execFileSync(command, args, { cwd: temp, stdio: 'inherit' });
  try {
    inSource('git', 'init', '-q');
    inSource('git', 'fetch', '-q', '--depth', '1', SOURCE.repo, SOURCE.commit);
    inSource('git', 'checkout', '-q', 'FETCH_HEAD');
    inSource('cmake', '-S', '.', '-B', 'build', ...MAC_BUILD_FLAGS);
    inSource('cmake', '--build', 'build', '--target', 'whisper-server', '--parallel');
    copyFileSync(join(temp, 'build', 'bin', 'whisper-server'), server);
    chmodSync(server, 0o755);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function fetchModel() {
  const path = join(OUTPUT, MODEL.file);
  if (existsSync(path) && digestOf(readFileSync(path)) === MODEL.sha256) return;
  writeFileSync(path, await download(MODEL));
}

function copyRuntime() {
  for (const file of RUNTIME_FILES) {
    if (!existsSync(join(SYSTEM_DIR, file))) throw new Error(`${file} is missing on this computer. Install the Microsoft Visual C++ Redistributable, then build again.`);
    copyFileSync(join(SYSTEM_DIR, file), join(OUTPUT, file));
  }
}

async function main() {
  mkdirSync(OUTPUT, { recursive: true });
  if (process.platform === 'darwin') {
    buildProgramForMac();
  } else {
    await fetchProgram();
    copyRuntime();
  }
  await fetchModel();
  console.log(`Speech engine ready in ${OUTPUT}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
