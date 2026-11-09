const { createHash } = require('node:crypto');
const { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { join } = require('node:path');

const SOURCE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
const STALL_MS = 120000;
const MODELS = {
  small: {
    file: 'ggml-small-q5_1.bin',
    url: `${SOURCE}ggml-small-q5_1.bin`,
    bytes: 190085487,
    sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
  },
  medium: {
    file: 'ggml-medium-q5_0.bin',
    url: `${SOURCE}ggml-medium-q5_0.bin`,
    bytes: 539212467,
    sha256: '19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f',
  },
};

// Creates the manager that lists, locates and downloads the larger speech models.
function createModels({ dir, onProgress, catalog = MODELS, request = fetch, stallMs = STALL_MS }) {
  const running = new Map();
  // Tells whether the id names a model in the catalog.
  const known = (id) => Object.hasOwn(catalog, id);
  // Returns where the model's file is stored on disk.
  const fileOf = (id) => join(dir, catalog[id].file);
  // Tells whether the model file exists and has its full expected size.
  const installed = (id) => existsSync(fileOf(id)) && statSync(fileOf(id)).size === catalog[id].bytes;
  // Returns the model's file path if it is installed, otherwise null.
  const pathOf = (id) => (known(id) && installed(id) ? fileOf(id) : null);
  // Lists every model with its size and whether it is installed.
  const list = () => Object.keys(catalog).map((id) => ({
    id,
    bytes: catalog[id].bytes,
    installed: installed(id),
  }));

  // Downloads a model and cancels it if no data arrives for too long.
  async function fetchModel(id) {
    const stopped = new AbortController();
    let watchdog;
    // Restarts the stall timer each time more data arrives.
    const stillReceiving = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(
        () => stopped.abort(new Error('The model stopped downloading. Check your connection and try again.')),
        stallMs,
      );
    };
    stillReceiving();
    try {
      await saveModel(id, stopped.signal, stillReceiving);
    } catch (e) {
      throw stopped.signal.aborted ? stopped.signal.reason : e;
    } finally {
      clearTimeout(watchdog);
    }
  }

  // Streams a model to a temporary file, checks its hash, then moves it into place.
  async function saveModel(id, signal, stillReceiving) {
    const { url, bytes, sha256 } = catalog[id];
    const res = await request(url, { signal });
    if (!res.ok) throw new Error(`The model could not be downloaded (HTTP ${res.status}).`);
    mkdirSync(dir, { recursive: true });
    const temp = `${fileOf(id)}.part`;
    const hash = createHash('sha256');
    let received = 0;
    let shown = -1;
    // Passes each chunk through while hashing it and reporting download progress.
    async function* counted(source) {
      for await (const part of source) {
        stillReceiving();
        hash.update(part);
        received += part.length;
        const percent = Math.min(100, Math.floor((received / bytes) * 100));
        if (percent !== shown) onProgress({ id, percent });
        shown = percent;
        yield part;
      }
    }
    const out = createWriteStream(temp);
    try {
      await pipeline(res.body ?? [], counted, out);
      if (hash.digest('hex') !== sha256) {
        throw new Error('The downloaded model failed its checksum, so it was not used.');
      }
      renameSync(temp, fileOf(id));
    } catch (e) {
      if (!out.closed) await new Promise((resolve) => out.once('close', () => resolve(null)));
      rmSync(temp, { recursive: true, force: true });
      throw e;
    }
  }

  // Starts a model download, or returns the one already in progress for that model.
  function download(id) {
    if (!known(id)) return Promise.reject(new Error('Unknown model.'));
    if (!running.has(id)) running.set(id, fetchModel(id).finally(() => running.delete(id)));
    return running.get(id);
  }

  return { list, pathOf, download };
}

module.exports = { createModels, MODELS };
