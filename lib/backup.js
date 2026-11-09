(() => {
  // Precomputed lookup table for the CRC-32 checksum.
  const TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  // Runs the CRC-32 checksum over bytes, starting from seed.
  function crc32(bytes, seed = 0xffffffff) {
    let c = seed;
    for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return c;
  }

  // Packs a date into the time and date numbers a ZIP file stores.
  function dosDateTime(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  // Builds an uncompressed ZIP file from a list of { name, data } entries.
  async function makeZip(entries) {
    const enc = new TextEncoder();
    const { time, date } = dosDateTime(new Date());
    const parts = [];
    const central = [];
    let offset = 0;
    for (const entry of entries) {
      const blob = entry.data instanceof Blob ? entry.data : new Blob([entry.data]);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const crc = (crc32(bytes) ^ 0xffffffff) >>> 0;
      const name = enc.encode(entry.name);
      const localHeader = new DataView(new ArrayBuffer(30));
      localHeader.setUint32(0, 0x04034b50, true);
      localHeader.setUint16(4, 20, true);
      localHeader.setUint16(8, 0, true);
      localHeader.setUint16(10, time, true);
      localHeader.setUint16(12, date, true);
      localHeader.setUint32(14, crc, true);
      localHeader.setUint32(18, bytes.length, true);
      localHeader.setUint32(22, bytes.length, true);
      localHeader.setUint16(26, name.length, true);
      parts.push(localHeader.buffer, name, blob);
      central.push({ name, crc, size: bytes.length, offset });
      offset += 30 + name.length + bytes.length;
    }
    const cdStart = offset;
    for (const file of central) {
      const centralHeader = new DataView(new ArrayBuffer(46));
      centralHeader.setUint32(0, 0x02014b50, true);
      centralHeader.setUint16(4, 20, true);
      centralHeader.setUint16(6, 20, true);
      centralHeader.setUint16(10, 0, true);
      centralHeader.setUint16(12, time, true);
      centralHeader.setUint16(14, date, true);
      centralHeader.setUint32(16, file.crc, true);
      centralHeader.setUint32(20, file.size, true);
      centralHeader.setUint32(24, file.size, true);
      centralHeader.setUint16(28, file.name.length, true);
      centralHeader.setUint32(42, file.offset, true);
      parts.push(centralHeader.buffer, file.name);
      offset += 46 + file.name.length;
    }
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, central.length, true);
    eocd.setUint16(10, central.length, true);
    eocd.setUint32(12, offset - cdStart, true);
    eocd.setUint32(16, cdStart, true);
    parts.push(eocd.buffer);
    return new Blob(parts, { type: 'application/zip' });
  }

  // Reads the entries of an uncompressed ZIP file as { name, blob } pairs.
  async function readZip(file) {
    const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 66000)).arrayBuffer());
    let p = tail.length - 22;
    const isEndRecord = (at) => tail[at] === 0x50 && tail[at + 1] === 0x4b
      && tail[at + 2] === 0x05 && tail[at + 3] === 0x06;
    while (p >= 0 && !isEndRecord(p)) p--;
    if (p < 0) throw new Error('Not a ZIP file (end of central directory not found).');
    const endRecord = new DataView(tail.buffer, p);
    const count = endRecord.getUint16(10, true);
    const cdSize = endRecord.getUint32(12, true);
    const cdStart = endRecord.getUint32(16, true);
    const cd = new DataView(await file.slice(cdStart, cdStart + cdSize).arrayBuffer());
    const dec = new TextDecoder();
    const out = [];
    let q = 0;
    for (let i = 0; i < count; i++) {
      if (cd.getUint32(q, true) !== 0x02014b50) throw new Error('The ZIP central directory is damaged.');
      const method = cd.getUint16(q + 10, true);
      const size = cd.getUint32(q + 20, true);
      const fnLen = cd.getUint16(q + 28, true);
      const extraLen = cd.getUint16(q + 30, true);
      const commentLen = cd.getUint16(q + 32, true);
      const localOff = cd.getUint32(q + 42, true);
      const name = dec.decode(new Uint8Array(cd.buffer, q + 46, fnLen));
      if (method !== 0) throw new Error(`Entry "${name}" is compressed, so this is not a backup from this extension.`);
      const localHeader = new DataView(await file.slice(localOff, localOff + 30).arrayBuffer());
      const dataStart = localOff + 30 + localHeader.getUint16(26, true) + localHeader.getUint16(28, true);
      out.push({ name, blob: file.slice(dataStart, dataStart + size) });
      q += 46 + fnLen + extraLen + commentLen;
    }
    return out;
  }

  const AUDIO_RE = /^audio\/chunk-(\d+)\.webm$/;
  const VIDEO_RE = /^audio\/video-(\d+)\.webm$/;
  const KEY_SERVERS = { apiKey: 'baseUrl', sttApiKey: 'sttBaseUrl' };
  const FIXED_SERVER_SECRETS = ['slackWebhook', 'notionToken'];
  const SECRET_SETTINGS = [...Object.keys(KEY_SERVERS), ...FIXED_SERVER_SECRETS];
  const KEY_ROUNDS = 310000;

  // Says whether a value is a plain object (not null and not an array).
  const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

  // Returns a copy of the stored data with the API keys and other secrets removed from settings.
  function withoutKeys(storage) {
    if (!isPlainObject(storage.settings)) return storage;
    const settings = { ...storage.settings };
    for (const field of SECRET_SETTINGS) delete settings[field];
    return { ...storage, settings };
  }

  // Keeps this computer's secrets when a backup without them is imported, if they fit its servers.
  function keepCurrentKeys(storage, current) {
    if (!isPlainObject(storage.settings) || !isPlainObject(current)) return storage;
    const serverOf = (settings, field) => settings[KEY_SERVERS[field]] || settings.baseUrl;
    const sameServer = (field) => FIXED_SERVER_SECRETS.includes(field)
      || serverOf(storage.settings, field) === serverOf(current, field);
    const kept = SECRET_SETTINGS
      .filter((field) => !(field in storage.settings) && field in current && sameServer(field));
    const keptKeys = Object.fromEntries(kept.map((field) => [field, current[field]]));
    const webhook = current.slackWebhook ? { slackWebhook: current.slackWebhook } : {};
    const notion = current.notionToken
      ? { notionToken: current.notionToken, notionPage: current.notionPage ?? '' }
      : {};
    return { ...storage, settings: { ...storage.settings, ...keptKeys, ...webhook, ...notion } };
  }

  // Encodes bytes as base64 text.
  const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

  // Decodes base64 text into bytes.
  const unb64 = (text) => Uint8Array.from(atob(String(text)), (c) => c.charCodeAt(0));

  // Derives an AES key from the backup password and salt.
  async function passwordKey(password, salt) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: KEY_ROUNDS, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  // Encrypts the secrets in settings with the backup password.
  async function lockKeys(settings, password) {
    const fields = SECRET_SETTINGS.filter((field) => field in settings);
    const secrets = Object.fromEntries(fields.map((field) => [field, settings[field]]));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await passwordKey(password, salt);
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(secrets)));
    return { salt: b64(salt), iv: b64(iv), data: b64(data) };
  }

  // Decrypts the secrets of a backup with its password.
  async function unlockKeys(locked, password) {
    if (!password) {
      throw new Error('This backup has API keys locked with a password. Type the backup password, then import again.');
    }
    let secrets;
    try {
      const key = await passwordKey(password, unb64(locked.salt));
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(locked.iv) }, key, unb64(locked.data));
      secrets = JSON.parse(new TextDecoder().decode(plain));
    } catch {
      throw new Error('Wrong backup password.');
    }
    const fields = SECRET_SETTINGS.filter((field) => typeof secrets?.[field] === 'string');
    return Object.fromEntries(fields.map((field) => [field, secrets[field]]));
  }

  // Builds the backup ZIP of all stored data, with the secrets locked by a password if asked.
  async function exportBackup({ includeKeys = false, password = '' } = {}) {
    if (includeKeys && !password) throw new Error('Choose a password to protect the API keys in the backup.');
    const stored = await chrome.storage.local.get(null);
    const locked = includeKeys && isPlainObject(stored.settings)
      ? { lockedKeys: await lockKeys(stored.settings, password) }
      : {};
    const backup = { version: 1, exportedAt: new Date().toISOString(), storage: withoutKeys(stored), ...locked };
    return makeZip([{ name: 'backup.json', data: JSON.stringify(backup) }]);
  }

  // Marks every imported meeting as fresh so the cleanup of old meetings does not delete it at once.
  const protectedFromCleanup = (storage) => Object.fromEntries(Object.entries(storage).map(([key, value]) => [
    key, key.startsWith('meeting:') && isPlainObject(value) ? { ...value, keepFrom: Date.now() } : value,
  ]));

  // Restores all stored data and audio from a backup ZIP and reports what was imported.
  async function importBackup(file, { password = '' } = {}) {
    const entries = await readZip(file);
    const main = entries.find((entry) => entry.name === 'backup.json');
    if (!main) throw new Error('backup.json is missing from the zip, so this is not a backup from this extension.');
    let backup;
    try {
      backup = JSON.parse(await main.blob.text());
    } catch {
      throw new Error('backup.json is damaged (not JSON).');
    }
    if (backup.version !== 1) throw new Error('Unknown backup format (different version?).');
    if (!isPlainObject(backup.storage)) throw new Error('backup.json is damaged: "storage" is not an object.');
    if (backup.audioMeta != null && !isPlainObject(backup.audioMeta)) {
      throw new Error('backup.json is damaged: "audioMeta" is not an object.');
    }
    if (backup.lockedKeys != null) {
      if (!isPlainObject(backup.lockedKeys)) throw new Error('backup.json is damaged: "lockedKeys" is not an object.');
      const settings = isPlainObject(backup.storage.settings) ? backup.storage.settings : {};
      backup.storage.settings = { ...settings, ...await unlockKeys(backup.lockedKeys, password) };
    }
    const chunks = [];
    if (backup.audioMeta) {
      const recId = Number(backup.audioMeta.baseTime ?? 0);
      for (const entry of entries) {
        const audio = entry.name.match(AUDIO_RE);
        const video = entry.name.match(VIDEO_RE);
        if (audio) chunks.push({ key: `chunk:${recId}:${Number(audio[1])}`, blob: entry.blob });
        else if (video) chunks.push({ key: `vchunk:${recId}:${Number(video[1])}`, blob: entry.blob });
      }
    }
    const previous = await chrome.storage.local.get(null);
    await chrome.storage.local.clear();
    try {
      await chrome.storage.local.set(protectedFromCleanup(keepCurrentKeys(backup.storage, previous.settings)));
    } catch (e) {
      await chrome.storage.local.clear();
      await chrome.storage.local.set(previous);
      throw e;
    }
    let audioError = null;
    await globalThis.MeetAudioStore.importAudio(backup.audioMeta ?? null, chunks)
      .catch((e) => { audioError = e.message; });
    return {
      meetings: (backup.storage.meetings ?? []).length,
      chunks: audioError ? 0 : chunks.length,
      audioError,
    };
  }

  globalThis.MeetBackup = { makeZip, readZip, exportBackup, importBackup, keepCurrentKeys };
})();
