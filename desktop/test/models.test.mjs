import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createModels, MODELS } = require('../main/models.js');

const BYTES = Buffer.from('isi model suara');
const catalog = { small: { file: 'small.bin', url: 'https://example.test/small.bin', bytes: BYTES.length, sha256: createHash('sha256').update(BYTES).digest('hex') } };

function setup(body = BYTES, init = { status: 200 }) {
  const dir = mkdtempSync(join(tmpdir(), 'tx-models-'));
  const asked = [];
  const progress = [];
  const models = createModels({
    dir,
    catalog,
    onProgress: (p) => progress.push(p),
    request: async (url) => {
      asked.push(url);
      return new Response(body, init);
    },
  });
  return { dir, asked, progress, models, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('models come from one pinned place, each with a checksum', () => {
  assert.deepEqual(Object.keys(MODELS), ['small', 'medium']);
  for (const model of Object.values(MODELS)) {
    assert.ok(model.url.startsWith('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/'));
    assert.match(model.sha256, /^[0-9a-f]{64}$/);
    assert.ok(model.bytes > 100000000);
  }
});

test('a download is saved after its checksum matches, and reports progress', async () => {
  const { dir, models, progress, done } = setup();
  try {
    assert.equal(models.list()[0].installed, false);
    assert.equal(models.pathOf('small'), null);
    await models.download('small');
    assert.deepEqual(readFileSync(join(dir, 'small.bin')), BYTES);
    assert.deepEqual(readdirSync(dir), ['small.bin']);
    assert.equal(models.list()[0].installed, true);
    assert.equal(models.pathOf('small'), join(dir, 'small.bin'));
    assert.deepEqual(progress.at(-1), { id: 'small', percent: 100 });
  } finally {
    done();
  }
});

test('a file with the wrong checksum is thrown away', async () => {
  const { dir, models, done } = setup(Buffer.from('isi model palsu'));
  try {
    await assert.rejects(models.download('small'), /checksum/);
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(models.pathOf('small'), null);
  } finally {
    done();
  }
});

test('a failed request leaves nothing behind', async () => {
  const { dir, models, done } = setup('gagal', { status: 503 });
  try {
    await assert.rejects(models.download('small'), /503/);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    done();
  }
});

test('a failed disk write ends the download, and it can be tried again', async () => {
  const { dir, asked, models, done } = setup();
  try {
    mkdirSync(join(dir, 'small.bin.part'));
    await assert.rejects(models.download('small'));
    assert.deepEqual(readdirSync(dir), []);
    await models.download('small');
    assert.equal(asked.length, 2);
    assert.deepEqual(readFileSync(join(dir, 'small.bin')), BYTES);
  } finally {
    done();
  }
});

test('only known models can be downloaded or used', async () => {
  const { asked, models, done } = setup();
  try {
    await assert.rejects(models.download('../../jahat'), /Unknown/);
    await assert.rejects(models.download('__proto__'), /Unknown/);
    assert.equal(models.pathOf('../../jahat'), null);
    assert.equal(asked.length, 0);
  } finally {
    done();
  }
});

test('asking twice at once downloads once', async () => {
  const { asked, models, done } = setup();
  try {
    await Promise.all([models.download('small'), models.download('small')]);
    assert.equal(asked.length, 1);
  } finally {
    done();
  }
});

test('a file of the wrong size does not count as installed', () => {
  const { dir, models, done } = setup();
  try {
    writeFileSync(join(dir, 'small.bin'), 'pendek');
    assert.equal(existsSync(join(dir, 'small.bin')), true);
    assert.equal(models.pathOf('small'), null);
  } finally {
    done();
  }
});

test('a download that stops sending data fails and leaves nothing behind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tx-models-'));
  const models = createModels({
    dir, catalog, stallMs: 30, onProgress: () => {},
    request: async (_url, { signal }) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(BYTES.subarray(0, 1));
          signal.addEventListener('abort', () => controller.error(signal.reason));
        },
      });
      return new Response(body);
    },
  });
  try {
    await assert.rejects(models.download('small'), /stopped downloading/);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a slow download that keeps sending data is not cut off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tx-models-'));
  let signalSeen;
  const models = createModels({
    dir, catalog: { small: { ...catalog.small, sha256: createHash('sha256').update(Buffer.from([BYTES[0], BYTES[0], BYTES[0], BYTES[0], BYTES[0]])).digest('hex') } }, stallMs: 60, onProgress: () => {},
    request: async (_url, { signal }) => {
      signalSeen = signal;
      const gaps = [40, 40, 40, 40, 40];
      const body = new ReadableStream({
        async start(controller) {
          for (const gap of gaps) {
            await new Promise((done) => setTimeout(done, gap));
            controller.enqueue(BYTES.subarray(0, 1));
          }
          controller.close();
        },
      });
      return new Response(body);
    },
  });
  try {
    await models.download('small');
    assert.equal(signalSeen.aborted, false);
    await new Promise((done) => setTimeout(done, 90));
    assert.equal(signalSeen.aborted, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
