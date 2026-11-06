const { createHash } = require('node:crypto');
const { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } = require('node:fs');
const { once } = require('node:events');
const { join } = require('node:path');

const SOURCE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
const DOWNLOAD_TIMEOUT_MS = 3600000;
const MODELS = {
  small: { file: 'ggml-small-q5_1.bin', url: `${SOURCE}ggml-small-q5_1.bin`, bytes: 190085487, sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb' },
  medium: { file: 'ggml-medium-q5_0.bin', url: `${SOURCE}ggml-medium-q5_0.bin`, bytes: 539212467, sha256: '19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f' },
};

function createModels({ dir, onProgress, catalog = MODELS, request = fetch }) {
  const running = new Map();
  const known = (id) => Object.hasOwn(catalog, id);
  const fileOf = (id) => join(dir, catalog[id].file);
  const installed = (id) => existsSync(fileOf(id)) && statSync(fileOf(id)).size === catalog[id].bytes;
  const pathOf = (id) => (known(id) && installed(id) ? fileOf(id) : null);
  const list = () => Object.keys(catalog).map((id) => ({ id, bytes: catalog[id].bytes, installed: installed(id) }));

  async function fetchModel(id) {
    const { url, bytes, sha256 } = catalog[id];
    const res = await request(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`The model could not be downloaded (HTTP ${res.status}).`);
    mkdirSync(dir, { recursive: true });
    const temp = `${fileOf(id)}.part`;
    const out = createWriteStream(temp);
    const hash = createHash('sha256');
    let received = 0;
    let shown = -1;
    try {
      for await (const part of res.body ?? []) {
        hash.update(part);
        received += part.length;
        if (!out.write(part)) await once(out, 'drain');
        const percent = Math.min(100, Math.floor((received / bytes) * 100));
        if (percent !== shown) onProgress({ id, percent });
        shown = percent;
      }
      out.end();
      await once(out, 'finish');
      if (hash.digest('hex') !== sha256) throw new Error('The downloaded model failed its checksum, so it was not used.');
      renameSync(temp, fileOf(id));
    } catch (e) {
      out.destroy();
      rmSync(temp, { force: true });
      throw e;
    }
  }

  function download(id) {
    if (!known(id)) return Promise.reject(new Error('Unknown model.'));
    if (!running.has(id)) running.set(id, fetchModel(id).finally(() => running.delete(id)));
    return running.get(id);
  }

  return { list, pathOf, download };
}

module.exports = { createModels, MODELS };
