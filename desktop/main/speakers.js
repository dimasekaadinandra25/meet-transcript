const { execFile } = require('node:child_process');
const { existsSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { availableParallelism, tmpdir } = require('node:os');
const { join, relative } = require('node:path');
const { promisify } = require('node:util');

const SEGMENTATION = 'segmentation.onnx';
const EMBEDDING = 'embedding.onnx';
const THRESHOLD = 0.85;
const TURN = /^(\d+(?:\.\d+)?) -- (\d+(?:\.\d+)?) speaker_(\d+)/;

// Returns the path of the speaker-diarization program for the given platform.
const programOf = (platform) => {
  const name = platform === 'win32'
    ? 'sherpa-onnx-offline-speaker-diarization.exe'
    : 'sherpa-onnx-offline-speaker-diarization';
  return join('bin', name);
};

// Reads the "start -- end speaker_N" lines the program prints into speaker turns.
const parseTurns = (stdout) => String(stdout).split(/\r?\n/).flatMap((line) => {
  const found = line.trim().match(TURN);
  return found ? [{ start: Number(found[1]), end: Number(found[2]), speaker: Number(found[3]) }] : [];
});

// Creates the helper that finds who spoke when in a recording.
function createSpeakers({ dir, platform = process.platform, run = promisify(execFile), exists = existsSync }) {
  const program = join(dir, programOf(platform));
  const threads = String(Math.max(1, Math.floor(availableParallelism() / 2)));
  // Tells whether the program and both of its models are installed.
  const available = () => [program, join(dir, SEGMENTATION), join(dir, EMBEDDING)]
    .every((path) => exists(path));

  // Writes the audio to a temporary file, runs the program on it, and returns the speaker turns.
  async function find(bytes) {
    const temp = mkdtempSync(join(tmpdir(), 'transcripables-speakers-'));
    const audio = join(temp, 'audio.wav');
    try {
      writeFileSync(audio, Buffer.from(bytes));
      const args = [
        `--segmentation.pyannote-model=${SEGMENTATION}`,
        `--embedding.model=${EMBEDDING}`,
        `--clustering.cluster-threshold=${THRESHOLD}`,
        `--segmentation.num-threads=${threads}`,
        `--embedding.num-threads=${threads}`,
        relative(dir, audio),
      ];
      const { stdout } = await run(program, args, { cwd: dir, windowsHide: true, maxBuffer: 64 * 1048576 });
      return parseTurns(stdout);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  return { available, find };
}

module.exports = { createSpeakers, parseTurns };
