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
    if (p < 0) throw new Error('Bukan file ZIP (end of central directory tidak ketemu).');
    const ev = new DataView(tail.buffer, p);
    const count = ev.getUint16(10, true);
    const cdSize = ev.getUint32(12, true);
    const cdStart = ev.getUint32(16, true);
    const cd = new DataView(await file.slice(cdStart, cdStart + cdSize).arrayBuffer());
    const dec = new TextDecoder();
    const out = [];
    let q = 0;
    for (let i = 0; i < count; i++) {
      if (cd.getUint32(q, true) !== 0x02014b50) throw new Error('Central directory ZIP rusak.');
      const method = cd.getUint16(q + 10, true);
      const size = cd.getUint32(q + 20, true);
      const fnLen = cd.getUint16(q + 28, true);
      const extraLen = cd.getUint16(q + 30, true);
      const commentLen = cd.getUint16(q + 32, true);
      const localOff = cd.getUint32(q + 42, true);
      const name = dec.decode(new Uint8Array(cd.buffer, q + 46, fnLen));
      if (method !== 0) throw new Error(`Entry "${name}" terkompresi — bukan zip backup buatan extension ini.`);
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
  async function exportBackup() {
    const storage = await chrome.storage.local.get(null);
    return makeZip([{
      name: 'backup.json',
      data: JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), storage }),
    }]);
  }
  async function importBackup(file) {
    const entries = await readZip(file);
    const main = entries.find((e) => e.name === 'backup.json');
    if (!main) throw new Error('backup.json tidak ada di dalam zip — bukan file backup extension ini.');
    let j;
    try { j = JSON.parse(await main.blob.text()); } catch { throw new Error('backup.json rusak (bukan JSON).'); }
    if (j.version !== 1) throw new Error('Format backup tidak dikenal (versi beda?).');
    if (!isPlainObject(j.storage)) throw new Error('backup.json rusak: bagian "storage" bukan objek.');
    if (j.audioMeta != null && !isPlainObject(j.audioMeta)) {
      throw new Error('backup.json rusak: bagian "audioMeta" bukan objek.');
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
    await chrome.storage.local.clear();
    await chrome.storage.local.set(j.storage);
    let audioError = null;
    await globalThis.MeetAudioStore.importAudio(j.audioMeta ?? null, chunks)
      .catch((e) => { audioError = e.message; });
    return {
      meetings: (j.storage.meetings ?? []).length,
      chunks: audioError ? 0 : chunks.length,
      audioError,
    };
  }
  globalThis.MeetBackup = { makeZip, readZip, exportBackup, importBackup };
})();
