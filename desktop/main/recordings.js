const { mkdir, writeFile, appendFile } = require('node:fs/promises');
const { join } = require('node:path');

const MAX_NAME_LENGTH = 150;
const KEPT_END_LENGTH = 40;
const EXTENSION = '.webm';

// Cleans a recording file name so it is safe to save, shortening it in the middle if it is too long.
function safeRecordingName(name) {
  const flat = String(name);
  if (!flat.toLowerCase().endsWith(EXTENSION)) throw new Error('Only .webm recordings can be saved.');
  const stem = flat
    .slice(0, -EXTENSION.length)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/^[.\s]+/, '')
    .trim();
  const room = MAX_NAME_LENGTH - EXTENSION.length;
  const fitted = stem.length > room
    ? stem.slice(0, room - KEPT_END_LENGTH) + stem.slice(-KEPT_END_LENGTH)
    : stem;
  return `${fitted || 'recording'}${EXTENSION}`;
}

// Creates the folder that recordings are saved into.
function createRecordingFolder(dir) {
  return {
    dir,
    // Writes the first chunk of a recording, or appends a later chunk to it.
    async write(name, bytes, first) {
      const path = join(dir, safeRecordingName(name));
      await mkdir(dir, { recursive: true });
      await (first ? writeFile : appendFile)(path, Buffer.from(bytes));
    },
    // Makes sure the folder exists and returns its path.
    async ensure() {
      await mkdir(dir, { recursive: true });
      return dir;
    },
  };
}

module.exports = { createRecordingFolder, safeRecordingName };
