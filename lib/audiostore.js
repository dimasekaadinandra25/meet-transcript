(() => {
  const DB = 'meet-audio';
  const STORE = 'chunks';

  // Opens the recordings database, creating its store on first use.
  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // Runs fn in one transaction and resolves with the result of the request(s) it returned.
  function tx(db, mode, fn) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const out = fn(transaction.objectStore(STORE));
      transaction.oncomplete = () => {
        if (Array.isArray(out)) resolve(out.map((req) => req.result));
        else resolve(out?.result ?? null);
      };
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction was aborted.'));
    });
  }

  // Opens the database, runs one transaction and closes the database again.
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
  const MAX_KEEP_RECORDINGS = 100;

  // Turns the "recordings to keep" setting into a valid count.
  function keepCount(value) {
    const count = Math.floor(Number(value));
    return count >= 1 ? Math.min(count, MAX_KEEP_RECORDINGS) : KEEP_RECORDINGS;
  }

  // Groups the stored keys into recordings, newest first, with each kind of part in order.
  function groupRecordings(allKeys, metas) {
    const recs = new Map();
    const addRecording = (metaKey, meta, oldKeys) => {
      const recId = oldKeys ? Number(meta?.baseTime ?? 0) : Number(metaKey.slice(5));
      const rec = {
        ...meta,
        recId,
        oldKeys,
        legacy: false,
        keys: [metaKey],
        chunkKeys: [],
        videoKeys: [],
        systemKeys: [],
        micKeys: [],
        mixKeys: [],
      };
      recs.set(recId, rec);
      return rec;
    };
    for (const [key, meta] of metas) if (META_NEW.test(key)) addRecording(key, meta, false);
    const oldMeta = metas.get('meta');
    const old = oldMeta && !recs.has(Number(oldMeta.baseTime ?? 0))
      ? addRecording('meta', oldMeta, true)
      : null;
    for (const rawKey of allKeys) {
      const key = String(rawKey);
      if (key === 'meta' || META_NEW.test(key)) continue;
      if (key === 'blobs') {
        if (old) {
          old.keys.push(key);
          old.legacy = true;
        }
        continue;
      }
      const newPart = key.match(PART_NEW);
      if (newPart) {
        const rec = recs.get(Number(newPart[2]));
        if (!rec || rec.oldKeys) continue;
        rec.keys.push(key);
        rec[LIST_OF[newPart[1]]].push({ key, index: Number(newPart[3]) });
        continue;
      }
      const oldPart = key.match(PART_OLD);
      if (oldPart && old) {
        old.keys.push(key);
        const list = oldPart[1] === 'chunk' ? old.chunkKeys : old.videoKeys;
        list.push({ key, index: Number(oldPart[2]) });
      }
    }
    const byIndex = (a, b) => a.index - b.index;
    const out = [...recs.values()];
    for (const rec of out) for (const list of Object.values(LIST_OF)) rec[list].sort(byIndex);
    return out.sort((a, b) => b.recId - a.recId);
  }

  // Lists the keys of every recording beyond the newest keep ones, so they can be deleted.
  function pruneTargets(recordings, keep = KEEP_RECORDINGS) {
    const addedAt = (rec) => rec.addedAt ?? rec.recId;
    return recordings.slice()
      .sort((a, b) => addedAt(b) - addedAt(a))
      .slice(keep)
      .flatMap((rec) => rec.keys);
  }

  // Lists the keys of every recording that belongs to a meeting.
  const keysOfMeeting = (recordings, meetingId) => recordings
    .filter((rec) => rec.meetingId === meetingId)
    .flatMap((rec) => rec.keys);

  // Returns the key range that covers every "meta:<id>" key.
  const metaRange = () => IDBKeyRange.bound('meta:', 'meta:￿');

  // Starts the reads needed to build the recordings index inside a transaction.
  function indexRequests(store) {
    const allKeys = store.getAllKeys();
    const metaKeys = store.getAllKeys(metaRange());
    const metaVals = store.getAll(metaRange());
    const oldMeta = store.get('meta');
    return { allKeys, metaKeys, metaVals, oldMeta };
  }

  // Collects the finished meta reads into a map from key to recording details.
  function metasFrom({ metaKeys, metaVals, oldMeta }) {
    const metas = new Map(metaKeys.result.map((key, i) => [String(key), metaVals.result[i]]));
    if (oldMeta.result) metas.set('meta', oldMeta.result);
    return metas;
  }

  // Builds the recordings index from finished index reads.
  const indexFrom = (reqs) => groupRecordings(reqs.allKeys.result, metasFrom(reqs));

  // Saves the details of a new recording and deletes the oldest recordings beyond the keep limit.
  function beginAudio({ meetingId, chunkMs, baseTime, keep, imported }) {
    return withDb('readwrite', (store) => {
      const importedFields = imported ? { imported, addedAt: Date.now() } : {};
      store.put({ meetingId, chunkMs, baseTime, count: 0, videoCount: 0, ...importedFields }, `meta:${baseTime}`);
      const reqs = indexRequests(store);
      reqs.oldMeta.onsuccess = () => {
        for (const key of pruneTargets(indexFrom(reqs), keepCount(keep))) store.delete(key);
      };
      return reqs.oldMeta;
    });
  }

  // Lists every stored recording, newest first.
  async function listRecordings() {
    let out = [];
    await withDb('readonly', (store) => {
      const reqs = indexRequests(store);
      reqs.oldMeta.onsuccess = () => { out = indexFrom(reqs); };
      return reqs.oldMeta;
    });
    return out;
  }

  // Finds the first recording id at or after baseTime that is not taken yet.
  async function freeRecId(baseTime) {
    const taken = new Set((await listRecordings()).map((rec) => rec.recId));
    let recId = baseTime;
    while (taken.has(recId)) recId += 1;
    return recId;
  }

  // Stores one part of a recording and raises the recording's part count to match.
  function appendEntry(blob, recId, prefix, field, index) {
    let failure = null;
    return withDb('readwrite', (store) => {
      const metaKey = `meta:${recId}`;
      const metaRead = store.get(metaKey);
      metaRead.onsuccess = () => {
        const meta = metaRead.result;
        if (!meta) {
          failure = new Error('Recording details are missing, so the part could not be saved.');
          return;
        }
        const partIndex = index ?? meta[field] ?? 0;
        const put = store.put(blob, `${prefix}:${recId}:${partIndex}`);
        put.onerror = (e) => {
          failure = put.error ?? new Error('The part could not be written to IndexedDB.');
          e.preventDefault();
        };
        store.put({ ...meta, [field]: Math.max(meta[field] ?? 0, partIndex + 1) }, metaKey);
      };
      return metaRead;
    }).then((result) => {
      if (failure) throw failure;
      return result;
    });
  }

  // Stores one audio chunk of a recording.
  const appendChunk = (blob, recId, index) => appendEntry(blob, recId, 'chunk', 'count', index);
  // Stores one video part of a recording.
  const appendVideoPart = (blob, recId) => appendEntry(blob, recId, 'vchunk', 'videoCount');
  // Stores one computer-sound chunk of a recording.
  const appendSystemChunk = (blob, recId, index) => appendEntry(blob, recId, 'schunk', 'systemCount', index);
  // Stores one microphone chunk of a recording.
  const appendMicChunk = (blob, recId, index) => appendEntry(blob, recId, 'mchunk', 'micCount', index);
  // Stores one mixed-audio part of a recording.
  const appendMixPart = (blob, recId) => appendEntry(blob, recId, 'xpart', 'mixCount');

  // Strips the internal key lists from a recording, leaving its public details.
  const publicMeta = ({ keys, chunkKeys, videoKeys, systemKeys, micKeys, mixKeys, oldKeys, ...rest }) => rest;

  // Loads one kind of part of a recording, with its details, or null if there is none.
  async function loadParts(recId, listName) {
    const rec = (await listRecordings()).find((found) => found.recId === Number(recId));
    if (!rec) return null;
    if (listName === 'chunkKeys' && rec.legacy) {
      const old = await withDb('readonly', (store) => store.get('blobs'));
      if (!Array.isArray(old) || !old.length) return null;
      return { ...publicMeta(rec), legacy: true, blobs: old, indices: old.map((_, i) => i) };
    }
    const list = rec[listName];
    if (!list.length) return null;
    const values = await withDb('readonly', (store) => list.map((part) => store.get(part.key)));
    const kept = values.map((value, i) => [value, list[i].index]).filter(([value]) => value);
    if (!kept.length) return null;
    return {
      ...publicMeta(rec),
      legacy: false,
      blobs: kept.map(([value]) => value),
      indices: kept.map(([, index]) => index),
    };
  }

  // Loads the audio chunks of a recording.
  const loadAudio = (recId) => loadParts(recId, 'chunkKeys');
  // Loads the video parts of a recording.
  const loadVideo = (recId) => loadParts(recId, 'videoKeys');
  // Loads the computer-sound chunks of a recording.
  const loadSystem = (recId) => loadParts(recId, 'systemKeys');
  // Loads the microphone chunks of a recording.
  const loadMic = (recId) => loadParts(recId, 'micKeys');
  // Loads the mixed-audio parts of a recording.
  const loadMix = (recId) => loadParts(recId, 'mixKeys');

  // Moves a meeting's recordings up to maxBaseTime over to another meeting id.
  function retagAudioMeta(oldId, newId, maxBaseTime) {
    return withDb('readwrite', (store) => {
      const reqs = indexRequests(store);
      reqs.oldMeta.onsuccess = () => {
        for (const [key, meta] of metasFrom(reqs)) {
          if (meta && meta.meetingId === oldId && (meta.baseTime ?? 0) <= maxBaseTime) {
            store.put({ ...meta, meetingId: newId }, key);
          }
        }
      };
      return reqs.oldMeta;
    });
  }

  // Deletes every recording of a meeting.
  function removeRecordings(meetingId) {
    return withDb('readwrite', (store) => {
      const reqs = indexRequests(store);
      reqs.oldMeta.onsuccess = () => {
        for (const key of keysOfMeeting(indexFrom(reqs), meetingId)) store.delete(key);
      };
      return reqs.oldMeta;
    });
  }

  // Replaces all stored audio with the recording from a backup.
  function importAudio(meta, chunks) {
    return withDb('readwrite', (store) => {
      store.clear();
      if (meta) store.put(meta, `meta:${Number(meta.baseTime ?? 0)}`);
      for (const chunk of chunks) store.put(chunk.blob, chunk.key);
    });
  }

  globalThis.MeetAudioStore = {
    beginAudio, appendChunk, appendVideoPart, appendSystemChunk, appendMicChunk, appendMixPart,
    loadAudio, loadVideo, loadSystem, loadMic, loadMix,
    listRecordings, freeRecId, retagAudioMeta, removeRecordings, importAudio,
    groupRecordings, pruneTargets, keysOfMeeting, keepCount, KEEP_RECORDINGS,
  };
})();
