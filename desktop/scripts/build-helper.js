const { execFileSync } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');

const SOURCE = join(__dirname, '..', 'native', 'app-audio.cpp');
const OUTPUT_DIR = join(__dirname, '..', 'native', 'bin');

// Compiles the Windows app-audio helper with g++; does nothing on other systems.
function main() {
  if (process.platform !== 'win32') return;
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const output = join(OUTPUT_DIR, 'app-audio.exe');
  execFileSync('g++', ['-std=c++17', '-O2', '-Wall', '-static', '-o', output, SOURCE, '-lole32', '-luuid'], {
    stdio: 'inherit',
  });
  console.log(`App audio helper ready in ${OUTPUT_DIR}`);
}

main();
