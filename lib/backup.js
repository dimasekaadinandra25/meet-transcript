(() => {
  const TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes, seed = 0xffffffff) {
    let c = seed;
    for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return c;
  }
  function dosDateTime(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }
  async function makeZip(entries) {
    const enc = new TextEncoder();
    const { time, date } = dosDateTime(new Date());
    const parts = [];
    const central = [];
    let offset = 0;
    for (const e of entries) {
      const blob = e.data instanceof Blob ? e.data : new Blob([e.data]);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const crc = (crc32(bytes) ^ 0xffffffff) >>> 0;
      const name = enc.encode(e.name);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(8, 0, true);
      lh.setUint16(10, time, true);
      lh.setUint16(12, date, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, bytes.length, true);
      lh.setUint32(22, bytes.length, true);
      lh.setUint16(26, name.length, true);
      parts.push(lh.buffer, name, blob);
      central.push({ name, crc, size: bytes.length, offset });
      offset += 30 + name.length + bytes.length;
    }
    const cdStart = offset;
    for (const c of central) {
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, time, true);
      ch.setUint16(14, date, true);
      ch.setUint32(16, c.crc, true);
      ch.setUint32(20, c.size, true);
      ch.setUint32(24, c.size, true);
      ch.setUint16(28, c.name.length, true);
      ch.setUint32(42, c.offset, true);
      parts.push(ch.buffer, c.name);
      offset += 46 + c.name.length;
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
  async function readZip(file) {
    const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 66000)).arrayBuffer());
    let p = tail.length - 22;
    while (p >= 0 && !(tail[p] === 0x50 && tail[p + 1] === 0x4b && tail[p + 2] === 0x05 && tail[p + 3] === 0x06)) p--;
    if (p < 0) throw new Error('Not a ZIP file (end of central directory not found).');
    const ev = new DataView(tail.buffer, p);
    const count = ev.getUint16(10, true);
    const cdSize = ev.getUint32(12, true);
    const cdStart = ev.getUint32(16, true);
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
      const lh = new DataView(await file.slice(localOff, localOff + 30).arrayBuffer());
      const dataStart = localOff + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      out.push({ name, blob: file.slice(dataStart, dataStart + size) });
      q += 46 + fnLen + extraLen + commentLen;
    }
    return out;
  }
  const AUDIO_RE = /^audio\/chunk-(\d+)\.webm$/;
  const VIDEO_RE = /^audio\/video-(\d+)\.webm$/;
  const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
  const KEY_SERVERS = { apiKey: 'baseUrl', sttApiKey: 'sttBaseUrl' };
  const FIXED_SERVER_SECRETS = ['slackWebhook', 'notionToken'];
  const SECRET_SETTINGS = [...Object.keys(KEY_SERVERS), ...FIXED_SERVER_SECRETS];
  function withoutKeys(storage) {
    if (!isPlainObject(storage.settings)) return storage;
    const settings = { ...storage.settings };
    for (const field of SECRET_SETTINGS) delete settings[field];
    return { ...storage, settings };
  }
  function keepCurrentKeys(storage, current) {
    if (!isPlainObject(storage.settings) || !isPlainObject(current)) return storage;
    const serverOf = (settings, field) => settings[KEY_SERVERS[field]] || settings.baseUrl;
    const sameServer = (field) => FIXED_SERVER_SECRETS.includes(field) || serverOf(storage.settings, field) === serverOf(current, field);
    const kept = SECRET_SETTINGS.filter((field) => !(field in storage.settings) && field in current && sameServer(field));
    const webhook = current.slackWebhook ? { slackWebhook: current.slackWebhook } : {};
    const notion = current.notionToken ? { notionToken: current.notionToken, notionPage: current.notionPage ?? '' } : {};
    return { ...storage, settings: { ...storage.settings, ...Object.fromEntries(kept.map((field) => [field, current[field]])), ...webhook, ...notion } };
  }
  const KEY_ROUNDS = 310000;
  const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const unb64 = (text) => Uint8Array.from(atob(String(text)), (c) => c.charCodeAt(0));
  async function passwordKey(password, salt) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: KEY_ROUNDS, hash: 'SHA-256' }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function lockKeys(settings, password) {
    const secrets = Object.fromEntries(SECRET_SETTINGS.filter((field) => field in settings).map((field) => [field, settings[field]]));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await passwordKey(password, salt), new TextEncoder().encode(JSON.stringify(secrets)));
    return { salt: b64(salt), iv: b64(iv), data: b64(data) };
  }
  async function unlockKeys(locked, password) {
    if (!password) throw new Error('This backup has API keys locked with a password. Type the backup password, then import again.');
    let secrets;
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(locked.iv) }, await passwordKey(password, unb64(locked.salt)), unb64(locked.data));
      secrets = JSON.parse(new TextDecoder().decode(plain));
    } catch {
      throw new Error('Wrong backup password.');
    }
    return Object.fromEntries(SECRET_SETTINGS.filter((field) => typeof secrets?.[field] === 'string').map((field) => [field, secrets[field]]));
  }
  async function exportBackup({ includeKeys = false, password = '' } = {}) {
    if (includeKeys && !password) throw new Error('Choose a password to protect the API keys in the backup.');
    const stored = await chrome.storage.local.get(null);
    const locked = includeKeys && isPlainObject(stored.settings) ? { lockedKeys: await lockKeys(stored.settings, password) } : {};
    return makeZip([{
      name: 'backup.json',
      data: JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), storage: withoutKeys(stored), ...locked }),
    }]);
  }
  const protectedFromCleanup = (storage) => Object.fromEntries(Object.entries(storage).map(([key, value]) => [
    key, key.startsWith('meeting:') && isPlainObject(value) ? { ...value, keepFrom: Date.now() } : value,
  ]));
  async function importBackup(file, { password = '' } = {}) {
    const entries = await readZip(file);
    const main = entries.find((e) => e.name === 'backup.json');
    if (!main) throw new Error('backup.json is missing from the zip, so this is not a backup from this extension.');
    let j;
    try { j = JSON.parse(await main.blob.text()); } catch { throw new Error('backup.json is damaged (not JSON).'); }
    if (j.version !== 1) throw new Error('Unknown backup format (different version?).');
    if (!isPlainObject(j.storage)) throw new Error('backup.json is damaged: "storage" is not an object.');
    if (j.audioMeta != null && !isPlainObject(j.audioMeta)) {
      throw new Error('backup.json is damaged: "audioMeta" is not an object.');
    }
    if (j.lockedKeys != null) {
      if (!isPlainObject(j.lockedKeys)) throw new Error('backup.json is damaged: "lockedKeys" is not an object.');
      const settings = isPlainObject(j.storage.settings) ? j.storage.settings : {};
      j.storage.settings = { ...settings, ...await unlockKeys(j.lockedKeys, password) };
    }
    const chunks = [];
    if (j.audioMeta) {
      const recId = Number(j.audioMeta.baseTime ?? 0);
      for (const e of entries) {
        const a = e.name.match(AUDIO_RE);
        const v = e.name.match(VIDEO_RE);
        if (a) chunks.push({ key: `chunk:${recId}:${Number(a[1])}`, blob: e.blob });
        else if (v) chunks.push({ key: `vchunk:${recId}:${Number(v[1])}`, blob: e.blob });
      }
    }
    const previous = await chrome.storage.local.get(null);
    await chrome.storage.local.clear();
    try {
      await chrome.storage.local.set(protectedFromCleanup(keepCurrentKeys(j.storage, previous.settings)));
    } catch (e) {
      await chrome.storage.local.clear();
      await chrome.storage.local.set(previous);
      throw e;
    }
    let audioError = null;
    await globalThis.MeetAudioStore.importAudio(j.audioMeta ?? null, chunks)
      .catch((e) => { audioError = e.message; });
    return {
      meetings: (j.storage.meetings ?? []).length,
      chunks: audioError ? 0 : chunks.length,
      audioError,
    };
  }
  globalThis.MeetBackup = { makeZip, readZip, exportBackup, importBackup, keepCurrentKeys };
})();
