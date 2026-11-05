import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const { createRecordingFolder, safeRecordingName } = createRequire(import.meta.url)('../main/recordings.js');

const withFolder = async (run) => {
  const dir = mkdtempSync(join(tmpdir(), 'tx-rec-'));
  try {
    await run(createRecordingFolder(join(dir, 'Transcripables')), join(dir, 'Transcripables'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('bagian pertama membuat file, bagian berikut menambah', () => withFolder(async (folder, dir) => {
  await folder.write('Rapat.webm', new TextEncoder().encode('ab').buffer, true);
  await folder.write('Rapat.webm', new TextEncoder().encode('cd').buffer, false);
  assert.equal(readFileSync(join(dir, 'Rapat.webm'), 'utf8'), 'abcd');
  await folder.write('Rapat.webm', new TextEncoder().encode('x').buffer, true);
  assert.equal(readFileSync(join(dir, 'Rapat.webm'), 'utf8'), 'x');
}));

test('nama file tidak bisa keluar dari folder', () => withFolder(async (folder, dir) => {
  await folder.write('..\\..\\keluar.webm', new ArrayBuffer(1), true);
  await folder.write('../../keluar2.webm', new ArrayBuffer(1), true);
  assert.equal(readdirSync(dir).length, 2);
  assert.deepEqual(readdirSync(dirname(dir)), ['Transcripables']);
}));

test('hanya file rekaman yang boleh ditulis', () => withFolder(async (folder) => {
  await assert.rejects(folder.write('virus.exe', new ArrayBuffer(1), true), /webm/);
}));

test('karakter terlarang di judul diganti', () => {
  assert.equal(safeRecordingName('5/11/2026, 14:00: rapat? 123.webm'), '5-11-2026, 14-00- rapat- 123.webm');
  assert.equal(safeRecordingName('..hidden.webm'), 'hidden.webm');
  assert.ok(safeRecordingName(`${'a'.repeat(400)}.webm`).length <= 150);
  assert.ok(safeRecordingName(`${'a'.repeat(400)}.webm`).endsWith('.webm'));
});
