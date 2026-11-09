const { mkdirSync } = require('node:fs');
const { readdir, readFile, rename, rm, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

const SECRET_FIELDS = ['apiKey', 'sttApiKey', 'slackWebhook', 'notionToken'];
const SUFFIX = '.json';

const fileName = (key) => encodeURIComponent(key).replace(/\*/g, '%2A') + SUFFIX;
const keyOf = (name) => decodeURIComponent(name.slice(0, -SUFFIX.length));

function createStore({ dir, cipher, onChange = (_changes) => {} }) {
  mkdirSync(dir, { recursive: true });
  let chain = Promise.resolve();
  let tempId = 0;
  const unreadable = {};

  const enqueue = (work) => {
    const run = chain.then(work);
    chain = run.catch(() => {});
    return run;
  };

  function serverOf(settings, field) {
    const address = { apiKey: settings.baseUrl, sttApiKey: settings.sttBaseUrl || settings.baseUrl }[field];
    if (field !== 'apiKey' && field !== 'sttApiKey') return 'fixed';
    try {
      return new URL(address).origin;
    } catch {
      return String(address ?? '');
    }
  }

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

  async function allKeys() {
    const names = await readdir(dir);
    return names.filter((n) => n.endsWith(SUFFIX)).map(keyOf);
  }

  async function writeKey(key, value) {
    const path = join(dir, fileName(key));
    const temp = `${path}.tmp-${++tempId}`;
    await writeFile(temp, JSON.stringify(seal(key, value)));
    await rename(temp, path);
  }

  const get = (keys) => enqueue(async () => {
    const wanted = keys == null ? await allKeys() : [].concat(keys);
    const out = {};
    for (const key of wanted) {
      const value = await readKey(key);
      if (value !== undefined) out[key] = value;
    }
    return out;
  });

  const set = (values) => enqueue(async () => {
    const changes = {};
    for (const [key, newValue] of Object.entries(values)) {
      const oldValue = await readKey(key);
      await writeKey(key, newValue);
      changes[key] = { newValue, oldValue };
    }
    onChange(changes);
  });

  const removeKeys = async (keys) => {
    const changes = {};
    for (const key of keys) {
      const oldValue = await readKey(key);
      await rm(join(dir, fileName(key)), { force: true });
      if (oldValue !== undefined) changes[key] = { newValue: undefined, oldValue };
    }
    if (Object.keys(changes).length) onChange(changes);
  };

  const remove = (keys) => enqueue(() => removeKeys([].concat(keys)));
  const clear = () => enqueue(async () => removeKeys(await allKeys()));

  return { get, set, remove, clear };
}

module.exports = { createStore };
