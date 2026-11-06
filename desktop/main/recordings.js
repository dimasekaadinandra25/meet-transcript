const { mkdir, writeFile, appendFile } = require('node:fs/promises');
const { join } = require('node:path');

const MAX_NAME_LENGTH = 150;
const KEPT_END_LENGTH = 40;
const EXTENSION = '.webm';

function safeRecordingName(name) {
  const flat = String(name);
  if (!flat.toLowerCase().endsWith(EXTENSION)) throw new Error('Only .webm recordings can be saved.');
  const stem = flat.slice(0, -EXTENSION.length).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/^[.\s]+/, '').trim();
  const room = MAX_NAME_LENGTH - EXTENSION.length;
  const fitted = stem.length > room ? stem.slice(0, room - KEPT_END_LENGTH) + stem.slice(-KEPT_END_LENGTH) : stem;
  return `${fitted || 'recording'}${EXTENSION}`;
}

function createRecordingFolder(dir) {
  return {
    dir,
    async write(name, bytes, first) {
      const path = join(dir, safeRecordingName(name));
      await mkdir(dir, { recursive: true });
      await (first ? writeFile : appendFile)(path, Buffer.from(bytes));
    },
    async ensure() {
      await mkdir(dir, { recursive: true });
      return dir;
    },
  };
}

module.exports = { createRecordingFolder, safeRecordingName };
