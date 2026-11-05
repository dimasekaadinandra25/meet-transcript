(() => {
  const DB = 'meet-audio';
  const STORE = 'chunks';
  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function tx(db, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(Array.isArray(out) ? out.map((r) => r.result) : (out?.result ?? null));
      t.onerror = () => reject(t.error ?? new Error('Transaksi IndexedDB gagal.'));
      t.onabort = () => reject(t.error ?? new Error('Transaksi IndexedDB dibatalkan.'));
    });
  }
  const withDb = async (mode, fn) => {
    const db = await open();
    try {
      return await tx(db, mode, fn);
    } finally {
      db.close();
    }
  };
  const META_NEW = /^meta:(\d+)$/;
  const PART_NEW = /^(chunk|vchunk|schunk|mchunk|xpart):(\d+):(\d+)$/;
  const PART_OLD = /^(chunk|vchunk):(\d+)$/;
  const LIST_OF = { chunk: 'chunkKeys', vchunk: 'videoKeys', schunk: 'systemKeys', mchunk: 'micKeys', xpart: 'mixKeys' };
  const KEEP_RECORDINGS = 5;
  function groupRecordings(allKeys, metas) {
    const recs = new Map();
    const mk = (metaKey, meta, oldKeys) => {
      const recId = oldKeys ? Number(meta?.baseTime ?? 0) : Number(metaKey.slice(5));
      const rec = { ...meta, recId, oldKeys, legacy: false,
        keys: [metaKey], chunkKeys: [], videoKeys: [], systemKeys: [], micKeys: [], mixKeys: [] };
      recs.set(recId, rec);
      return rec;
    };
    for (const [key, meta] of metas) if (META_NEW.test(key)) mk(key, meta, false);
    const oldMeta = metas.get('meta');
    const old = oldMeta && !recs.has(Number(oldMeta.baseTime ?? 0))
      ? mk('meta', oldMeta, true) : null;
    for (const k of allKeys) {
      const key = String(k);
      if (key === 'meta' || META_NEW.test(key)) continue;
      if (key === 'blobs') {
        if (old) { old.keys.push(key); old.legacy = true; }
        continue;
      }
      const n = key.match(PART_NEW);
      if (n) {
        const rec = recs.get(Number(n[2]));
        if (!rec || rec.oldKeys) continue;
        rec.keys.push(key);
        rec[LIST_OF[n[1]]].push({ key, index: Number(n[3]) });
        continue;
      }
      const o = key.match(PART_OLD);
      if (o && old) {
        old.keys.push(key);
        (o[1] === 'chunk' ? old.chunkKeys : old.videoKeys)
          .push({ key, index: Number(o[2]) });
      }
    }
    const byIndex = (a, b) => a.index - b.index;
    const out = [...recs.values()];
    for (const r of out) for (const list of Object.values(LIST_OF)) r[list].sort(byIndex);
    return out.sort((a, b) => b.recId - a.recId);
  }
  function pruneTargets(recordings, keep = KEEP_RECORDINGS) {
    return recordings.slice()
      .sort((a, b) => b.recId - a.recId)
      .slice(keep)
      .flatMap((r) => r.keys);
  }
  const keysOfMeeting = (recordings, meetingId) => recordings
    .filter((r) => r.meetingId === meetingId)
    .flatMap((r) => r.keys);
  const metaRange = () => IDBKeyRange.bound('meta:', 'meta:￿');
  function indexRequests(s) {
    const allKeys = s.getAllKeys();
    const metaKeys = s.getAllKeys(metaRange());
    const metaVals = s.getAll(metaRange());
    const oldMeta = s.get('meta');
    return { allKeys, metaKeys, metaVals, oldMeta };
  }
  function metasFrom({ metaKeys, metaVals, oldMeta }) {
    const metas = new Map(metaKeys.result.map((k, i) => [String(k), metaVals.result[i]]));
    if (oldMeta.result) metas.set('meta', oldMeta.result);
    return metas;
  }
  const indexFrom = (reqs) => groupRecordings(reqs.allKeys.result, metasFrom(reqs));
  function beginAudio({ meetingId, chunkMs, baseTime }) {
    return withDb('readwrite', (s) => {
      s.put({ meetingId, chunkMs, baseTime, count: 0, videoCount: 0 }, `meta:${baseTime}`);
      const reqs = indexRequests(s);
      reqs.oldMeta.onsuccess = () => {
        for (const key of pruneTargets(indexFrom(reqs))) s.delete(key);
      };
      return reqs.oldMeta;
    });
  }
  async function listRecordings() {
    let out = [];
    await withDb('readonly', (s) => {
      const reqs = indexRequests(s);
      reqs.oldMeta.onsuccess = () => { out = indexFrom(reqs); };
      return reqs.oldMeta;
    });
    return out;
  }
  function appendEntry(blob, recId, prefix, field) {
    let failure = null;
    return withDb('readwrite', (s) => {
      const metaKey = `meta:${recId}`;
      const g = s.get(metaKey);
      g.onsuccess = () => {
        const meta = g.result;
        if (!meta) {
          failure = new Error('Meta rekaman hilang — potongan tidak bisa disimpan.');
          return;
        }
        const i = meta[field] ?? 0;
        const put = s.put(blob, `${prefix}:${recId}:${i}`);
        put.onerror = (e) => {
          failure = put.error ?? new Error('Potongan gagal ditulis ke IndexedDB.');
          e.preventDefault();
        };
        s.put({ ...meta, [field]: i + 1 }, metaKey);
      };
      return g;
    }).then((r) => {
      if (failure) throw failure;
      return r;
    });
  }
  const appendChunk = (blob, recId) => appendEntry(blob, recId, 'chunk', 'count');
  const appendVideoPart = (blob, recId) => appendEntry(blob, recId, 'vchunk', 'videoCount');
  const appendSystemChunk = (blob, recId) => appendEntry(blob, recId, 'schunk', 'systemCount');
  const appendMicChunk = (blob, recId) => appendEntry(blob, recId, 'mchunk', 'micCount');
  const appendMixPart = (blob, recId) => appendEntry(blob, recId, 'xpart', 'mixCount');
  const publicMeta = ({ keys, chunkKeys, videoKeys, systemKeys, micKeys, mixKeys, oldKeys, ...rest }) => rest;
  async function loadParts(recId, listName) {
    const rec = (await listRecordings()).find((r) => r.recId === Number(recId));
    if (!rec) return null;
    if (listName === 'chunkKeys' && rec.legacy) {
      const old = await withDb('readonly', (s) => s.get('blobs'));
      if (!Array.isArray(old) || !old.length) return null;
      return { ...publicMeta(rec), legacy: true,
        blobs: old, indices: old.map((_, i) => i) };
    }
    const list = rec[listName];
    if (!list.length) return null;
    const vals = await withDb('readonly', (s) => list.map((c) => s.get(c.key)));
    const kept = vals.map((v, i) => [v, list[i].index]).filter(([v]) => v);
    if (!kept.length) return null;
    return { ...publicMeta(rec), legacy: false,
      blobs: kept.map(([v]) => v), indices: kept.map(([, i]) => i) };
  }
  const loadAudio = (recId) => loadParts(recId, 'chunkKeys');
  const loadVideo = (recId) => loadParts(recId, 'videoKeys');
  const loadSystem = (recId) => loadParts(recId, 'systemKeys');
  const loadMic = (recId) => loadParts(recId, 'micKeys');
  const loadMix = (recId) => loadParts(recId, 'mixKeys');
  function retagAudioMeta(oldId, newId, maxBaseTime) {
    return withDb('readwrite', (s) => {
      const reqs = indexRequests(s);
      reqs.oldMeta.onsuccess = () => {
        for (const [key, m] of metasFrom(reqs)) {
          if (m && m.meetingId === oldId && (m.baseTime ?? 0) <= maxBaseTime) {
            s.put({ ...m, meetingId: newId }, key);
          }
        }
      };
      return reqs.oldMeta;
    });
  }
  function removeRecordings(meetingId) {
    return withDb('readwrite', (s) => {
      const reqs = indexRequests(s);
      reqs.oldMeta.onsuccess = () => {
        for (const key of keysOfMeeting(indexFrom(reqs), meetingId)) s.delete(key);
      };
      return reqs.oldMeta;
    });
  }
  function importAudio(meta, chunks) {
    return withDb('readwrite', (s) => {
      s.clear();
      if (meta) s.put(meta, `meta:${Number(meta.baseTime ?? 0)}`);
      for (const c of chunks) s.put(c.blob, c.key);
    });
  }
  globalThis.MeetAudioStore = { beginAudio, appendChunk, appendVideoPart,
    appendSystemChunk, appendMicChunk, appendMixPart,
    loadAudio, loadVideo, loadSystem, loadMic, loadMix, listRecordings, retagAudioMeta, removeRecordings, importAudio,
    groupRecordings, pruneTargets, keysOfMeeting, KEEP_RECORDINGS };
})();
