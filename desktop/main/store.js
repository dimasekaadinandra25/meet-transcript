const { mkdirSync } = require('node:fs');
const { readdir, readFile, rename, rm, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

const SECRET_FIELDS = ['apiKey', 'sttApiKey', 'slackWebhook', 'notionToken'];
const SUFFIX = '.json';

// Turns a storage key into a safe file name.
const fileName = (key) => encodeURIComponent(key).replace(/\*/g, '%2A') + SUFFIX;
// Turns a stored file name back into its storage key.
const keyOf = (name) => decodeURIComponent(name.slice(0, -SUFFIX.length));

// Creates a key-value store kept as JSON files, with API keys and tokens encrypted on disk.
function createStore({ dir, cipher, onChange = (_changes) => {} }) {
  mkdirSync(dir, { recursive: true });
  let chain = Promise.resolve();
  let tempId = 0;
  const unreadable = {};

  // Runs work after all earlier store operations have finished, one at a time.
  const enqueue = (work) => {
    const run = chain.then(work);
    chain = run.catch(() => {});
    return run;
  };

  // Returns the server a secret belongs to, so an unreadable secret is only kept for the same server.
  function serverOf(settings, field) {
    if (field !== 'apiKey' && field !== 'sttApiKey') return 'fixed';
    const address = field === 'apiKey' ? settings.baseUrl : settings.sttBaseUrl || settings.baseUrl;
    try {
      return new URL(address).origin;
    } catch {
      return String(address ?? '');
    }
  }

  // Encrypts the secret fields of the settings before they are written to disk.
  function seal(key, value) {
    if (key !== 'settings' || !value) return value;
    const sealed = { ...value };
    const secrets = {};
    for (const field of SECRET_FIELDS) {
      if (!sealed[field]) {
        if (unreadable[field]?.server === serverOf(sealed, field)) secrets[field] = unreadable[field].data;
        continue;
      }
      delete unreadable[field];
      if (!cipher.available()) throw new Error('API key encryption is not available on this computer.');
      secrets[field] = cipher.encrypt(sealed[field]);
      delete sealed[field];
    }
    return Object.keys(secrets).length ? { ...sealed, secrets } : sealed;
  }

  // Decrypts the secret fields of stored settings, remembering any that cannot be decrypted.
  function unseal(key, value) {
    if (key !== 'settings' || !value?.secrets) return value;
    const { secrets, ...open } = value;
    for (const [field, data] of Object.entries(secrets)) {
      try {
        open[field] = cipher.decrypt(data);
        delete unreadable[field];
      } catch {
        open[field] = '';
        unreadable[field] = { data, server: serverOf(open, field) };
      }
    }
    return open;
  }

  // Reads one key from disk, setting a corrupt file aside instead of failing.
  async function readKey(key) {
    const path = join(dir, fileName(key));
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return undefined;
      throw e;
    }
    try {
      return unseal(key, JSON.parse(text));
    } catch {
      await rename(path, `${path}.corrupt-${Date.now()}`);
      return undefined;
    }
  }

  // Lists every key that has a file in the store folder.
  async function allKeys() {
    const names = await readdir(dir);
    return names.filter((name) => name.endsWith(SUFFIX)).map(keyOf);
  }

  // Writes one key to a temporary file and then renames it into place.
  async function writeKey(key, value) {
    const path = join(dir, fileName(key));
    const temp = `${path}.tmp-${++tempId}`;
    await writeFile(temp, JSON.stringify(seal(key, value)));
    await rename(temp, path);
  }

  // Reads the given keys, or every key when none are given.
  const get = (keys) => enqueue(async () => {
    const wanted = keys == null ? await allKeys() : [].concat(keys);
    const out = {};
    for (const key of wanted) {
      const value = await readKey(key);
      if (value !== undefined) out[key] = value;
    }
    return out;
  });

  // Saves the given values and reports what changed.
  const set = (values) => enqueue(async () => {
    const changes = {};
    for (const [key, newValue] of Object.entries(values)) {
      const oldValue = await readKey(key);
      await writeKey(key, newValue);
      changes[key] = { newValue, oldValue };
    }
    onChange(changes);
  });

  // Deletes the given keys and reports the ones that existed.
  const removeKeys = async (keys) => {
    const changes = {};
    for (const key of keys) {
      const oldValue = await readKey(key);
      await rm(join(dir, fileName(key)), { force: true });
      if (oldValue !== undefined) changes[key] = { newValue: undefined, oldValue };
    }
    if (Object.keys(changes).length) onChange(changes);
  };

  // Deletes one key or a list of keys.
  const remove = (keys) => enqueue(() => removeKeys([].concat(keys)));
  // Deletes every key in the store.
  const clear = () => enqueue(async () => removeKeys(await allKeys()));

  return { get, set, remove, clear };
}

module.exports = { createStore };
