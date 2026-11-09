(() => {
  const CHUNK_MS = 120000;
  const IMPORT_PART_MS = 120000;
  const SILENT_PEAK = 0.01;
  const AI_URLS = { gemini: 'https://gemini.google.com/app', chatgpt: 'https://chatgpt.com/' };
  const IDLE = { recording: false, transcribing: false, meetingId: null, baseTime: null };

  // Builds the desktop stand-in for the extension's service worker: recording, transcripts and meetings.
  function createController(deps) {
    const {
      recorder, audioStore, storage, merge, stt, tracks, openai, notify, openExternal, onState, onWarning,
      probeStt, startEngine, splitAudio, clipAudio, saveFile, speakers, now,
    } = deps;
    let rec = { ...IDLE };
    let activeId = null;
    let starting = null;
    let finishing = null;
    let stopWarning = null;
    let importRun = null;
    let live = null;
    let writes = Promise.resolve();
    const momInFlight = new Map();

    // Tells whether a recording or transcript is in progress.
    const busy = () => rec.recording || rec.transcribing;
    // Returns the storage key that holds one meeting.
    const meetingKey = (id) => `meeting:${id}`;
    // Loads the saved settings, or an empty object.
    const readSettings = async () => (await storage.get('settings')).settings ?? {};
    // Loads one meeting from storage.
    const readMeeting = async (id) => (await storage.get(meetingKey(id)))[meetingKey(id)];
    // Reports the recording state to the main process (tray icon and menu).
    const publishState = () => onState({
      recording: rec.recording,
      transcribing: rec.transcribing,
      muted: recorder.isMuted(),
      paused: !!recorder.isPaused?.(),
    });

    // Runs storage writes one after another so they never overwrite each other.
    function enqueue(work) {
      const run = writes.then(work);
      writes = run.catch(() => {});
      return run;
    }

    // Changes a stored meeting in place and tells the panel it changed.
    const updateMeeting = (id, change) => enqueue(async () => {
      const meeting = await readMeeting(id);
      if (!meeting) throw new Error('Meeting not found.');
      change(meeting);
      await storage.set({ [meetingKey(id)]: meeting });
      notify({ type: 'meeting-updated', id });
    });

    // Sends the current recording state to the panel, plus any extra fields such as an error.
    function broadcast(extra = {}) {
      publishState();
      notify({
        type: 'rec-state',
        recording: rec.recording,
        transcribing: rec.transcribing,
        saving: false,
        muted: recorder.isMuted(),
        paused: !!recorder.isPaused?.(),
        importing: !!importRun,
        ...extra,
      });
    }

    // Stores a new meeting at the top of the meeting list.
    const addMeeting = (meeting) => enqueue(async () => {
      const { meetings = [] } = await storage.get('meetings');
      await storage.set({ [meetingKey(meeting.id)]: meeting, meetings: [meeting.id, ...meetings] });
      notify({ type: 'meeting-updated', id: meeting.id });
    });

    // Makes a meeting the one shown live in the panel.
    function setActive(id) {
      activeId = id;
      notify({ type: 'status', id, inCall: false, captionsOn: false, lastSegmentAt: 0, captionsOnAt: 0 });
    }

    // Shows a warning in the panel and brings the window forward.
    function warn(error) {
      stopWarning = error;
      if (live) live.paused = false;
      broadcast({ error });
      onWarning();
    }

    // Checks that speech-to-text is set up and reachable, warning if it is not.
    async function checkStt(settings) {
      const { baseUrl, apiKey } = stt.sttEndpoint(settings);
      if (baseUrl === stt.BUILTIN_URL) {
        const engine = await startEngine();
        if (!engine.ok) warn(`${engine.error} Recording continues, and you can make the transcript later from History.`);
        return;
      }
      if (!baseUrl) {
        warn('Speech-to-text is not set up, so this recording will have no transcript. Add it in Settings.');
        return;
      }
      const answer = await probeStt(`${baseUrl.replace(/\/+$/, '')}/models`, apiKey);
      const status = answer.value?.status;
      if (!answer.ok) {
        warn(`Speech-to-text at ${baseUrl} could not be reached. Recording continues, and you can make the transcript later from History.`);
      } else if (status === 401 || status === 403) {
        warn('Speech-to-text rejected the API key. Recording continues, and you can make the transcript later from History.');
      }
    }

    // Starts recording a new meeting and creates its entry in History.
    async function startRecording({ video }) {
      if (busy()) return { ok: false, error: 'A recording is still running.' };
      const baseTime = now();
      const meetingId = `desktop-${baseTime}`;
      rec = { recording: true, transcribing: false, meetingId, baseTime };
      publishState();
      // Starts the recorder, then stores the meeting, stopping the recorder if that fails.
      const begin = async () => {
        const settings = await readSettings();
        await recorder.start({
          baseTime,
          mic: settings.mic !== false,
          video: !!video,
          chunkMs: CHUNK_MS,
          prepare: () => audioStore.beginAudio({
            meetingId,
            chunkMs: CHUNK_MS,
            baseTime,
            keep: settings.keepRecordings,
          }),
        });
        const meeting = {
          id: meetingId,
          title: new Date(baseTime).toLocaleString(),
          startedAt: baseTime,
          endedAt: null,
          segments: [],
          mom: null,
          source: 'audio',
        };
        await addMeeting(meeting).catch(async (e) => {
          await recorder.stop().catch(() => {});
          throw e;
        });
      };
      starting = begin();
      try {
        await starting;
      } catch (e) {
        rec = { ...IDLE };
        broadcast({ error: e.message });
        onWarning();
        return { ok: false, error: e.message };
      } finally {
        starting = null;
      }
      live = {
        meetingId,
        baseTime,
        done: { system: new Map(), mic: new Map() },
        voices: stt.createVoiceMemory(),
        run: Promise.resolve(),
        stopped: false,
      };
      setActive(meetingId);
      broadcast({ error: null });
      readSettings().then(checkStt).catch((e) => console.error(e));
      return { ok: true };
    }

    // Tells whether the microphone was silent during the chunk at `index`.
    const isSilent = (peaks, index) =>
      peaks[index] !== undefined && peaks[index] !== null && peaks[index] < SILENT_PEAK;

    // Transcribes one audio blob, using remembered voices when the model can tell speakers apart.
    function sendToStt(blob, endpoint, voices) {
      // Sends the blob once, optionally naming the speakers already heard.
      const send = (knownSpeakers) => openai.transcribeAudio({
        blob,
        baseUrl: endpoint.baseUrl,
        apiKey: endpoint.apiKey,
        model: endpoint.model,
        language: endpoint.language,
        ...(endpoint.vocabulary ? { prompt: endpoint.vocabulary } : {}),
        ...(knownSpeakers ? { knownSpeakers } : {}),
      });
      if (!voices || !stt.isDiarizeModel(endpoint.model)) return send();
      return stt.sendWithVoices({ send, blob, voices, makeClip: clipAudio });
    }

    // Turns a map of finished chunk results into a track sorted by chunk index.
    function finishedTrack(done) {
      const indices = [...done.keys()].sort((a, b) => a - b);
      return { results: indices.map((index) => done.get(index)), indices };
    }

    // Transcribes the chunks saved so far during a recording and updates the live transcript.
    async function catchUpLive(session) {
      const settings = await readSettings();
      if (settings.liveTranscript === false) return;
      const endpoint = stt.sttEndpoint(settings);
      if (!endpoint.baseUrl) return;
      const [system, mic] = await Promise.all([
        audioStore.loadSystem(session.baseTime),
        audioStore.loadMic(session.baseTime),
      ]);
      const micPeaks = recorder.currentPeaks()?.mic ?? [];
      const jobs = [
        [system, session.done.system, () => false, session.voices],
        [mic, session.done.mic, (index) => isSilent(micPeaks, index)],
      ];
      let changed = false;
      for (const [loaded, done, skip, voices] of jobs) {
        for (const [i, index] of (loaded?.indices ?? []).entries()) {
          if (done.has(index) || session.stopped) continue;
          if (skip(index)) {
            done.set(index, { segments: [] });
            continue;
          }
          try {
            const result = await sendToStt(loaded.blobs[i], endpoint, voices);
            if (result.error) throw new Error(result.error);
            done.set(index, result);
            changed = true;
          } catch (e) {
            if (!session.stopped) {
              session.paused = true;
              broadcast({ error: `Live transcript paused (${e.message}). The recording continues, and missing parts are tried again when you stop.` });
            }
            if (changed) await saveLive(session, system ?? mic);
            return;
          }
        }
      }
      if (changed) {
        await saveLive(session, system ?? mic);
        if (system) liveSpeakers(session, system).catch((e) => console.error(e));
      }
      if (session.paused && !session.stopped) {
        session.paused = false;
        broadcast({ error: null });
      }
    }

    // Tells speakers apart in the live transcript on this computer, one run at a time.
    async function liveSpeakers(session, loaded) {
      const track = finishedTrack(session.done.system);
      if (session.diarizing || !speakers || !unlabeledTrack(track)) return;
      if ((await readSettings()).localSpeakers === false || !await speakers.available()) return;
      const blobByIndex = new Map(loaded.indices.map((index, i) => [index, loaded.blobs[i]]));
      const blobs = track.indices.map((index) => blobByIndex.get(index));
      if (blobs.some((b) => !b)) return;
      session.diarizing = true;
      try {
        const found = await speakers.find(blobs, await savedVoices());
        session.found = {
          starts: new Map(track.indices.map((index, i) => [index, found.starts[i]])),
          turns: found.turns,
          references: found.references,
        };
        if (!session.stopped) await saveLive(session, loaded);
      } catch (e) {
        console.error(e);
      } finally {
        session.diarizing = false;
      }
    }

    // Writes the live transcript so far into the meeting, with speaker labels if found.
    async function saveLive(session, source) {
      const done = finishedTrack(session.done.system);
      let system = done;
      if (session.found) {
        const starts = done.indices.map((index) => session.found.starts.get(index));
        const { turns, references } = session.found;
        system = tracks.labelSpeakers(done, { starts, turns, references });
      }
      const segments = tracks.mergeTracks({
        system,
        mic: finishedTrack(session.done.mic),
        chunkMs: source.chunkMs,
        baseTime: source.baseTime,
      });
      await updateMeeting(session.meetingId, (meeting) => {
        merge.replaceMeetingAudio(meeting, segments, { baseTime: source.baseTime });
      });
    }

    // Queues a live-transcript catch-up after the recorder saves a chunk.
    function chunkSaved() {
      const session = live;
      if (!session || session.stopped) return;
      session.run = session.run.then(() => catchUpLive(session)).catch((e) => console.error(e));
    }

    // Tells whether a track has text but no speaker labels yet.
    const unlabeledTrack = (track) => {
      const hasText = track.results.some((r) => r?.segments?.length);
      const hasSpeaker = track.results.some((r) => r?.segments?.some((s) => s.speaker));
      return hasText && !hasSpeaker;
    };

    const MAX_VOICES = 8;
    // Loads the saved voices of named speakers, unless remembering voices is turned off.
    async function savedVoices() {
      if ((await readSettings()).rememberVoices === false) return [];
      return (await storage.get('voices')).voices ?? [];
    }

    // Saves a short clip of a named speaker's voice for later meetings.
    async function rememberVoice(meetingId, name) {
      if (!speakers) return;
      if ((await readSettings()).rememberVoices === false || !await speakers.available()) return;
      const meeting = await readMeeting(meetingId);
      const sample = tracks.voicePieces(meeting?.segments ?? [], name);
      const system = sample && await audioStore.loadSystem(sample.baseTime);
      if (!system) return;
      const clips = [];
      for (const { t, until } of sample.pieces) {
        const index = Math.floor((t - sample.baseTime) / system.chunkMs);
        const blob = system.blobs[system.indices.indexOf(index)];
        const start = sample.baseTime + index * system.chunkMs;
        if (blob) {
          const fromSeconds = (t - start) / 1000;
          const toSeconds = Math.min(until - start, system.chunkMs) / 1000;
          clips.push(await clipAudio(blob, fromSeconds, toSeconds));
        }
      }
      if (!clips.length) return;
      const { voices = [] } = await storage.get('voices');
      const otherVoices = voices.filter((voice) => voice.name !== name);
      await storage.set({ voices: [...otherVoices, { name, clips, savedAt: now() }].slice(-MAX_VOICES) });
    }

    // Labels speakers in a finished recording on this computer, when that is available and turned on.
    async function nameSpeakers(blobs, track) {
      if (!speakers || !blobs?.length || !unlabeledTrack(track)) return { track };
      if ((await readSettings()).localSpeakers === false || !await speakers.available()) return { track };
      broadcast({ speakers: true });
      try {
        const found = await speakers.find(blobs, await savedVoices());
        return { track: tracks.labelSpeakers(track, found) };
      } catch (e) {
        return { track, error: `Speakers could not be told apart (${e.message}).` };
      }
    }

    // Transcribes every chunk of a track, reusing finished results and skipping silent chunks.
    async function sendChunks(loaded, skip, endpoint, progress, known, voices) {
      if (!loaded) return { results: [], indices: [] };
      const results = [];
      for (let i = 0; i < loaded.blobs.length; i++) {
        const index = loaded.indices[i];
        if (known?.has(index)) {
          results.push(known.get(index));
          continue;
        }
        if (skip(index)) {
          results.push({ segments: [] });
          continue;
        }
        progress();
        try {
          results.push(await sendToStt(loaded.blobs[i], endpoint, voices));
        } catch (e) {
          results.push({ error: e.message });
        }
      }
      return { results, indices: loaded.indices };
    }

    // Makes the transcript for one saved recording and returns a warning text, or null.
    async function transcribe(meetingId, recId, replace, known, voices = stt.createVoiceMemory()) {
      const endpoint = stt.sttEndpoint(await readSettings());
      const [system, mic] = await Promise.all([audioStore.loadSystem(recId), audioStore.loadMic(recId)]);
      const source = system ?? mic;
      if (!source) throw new Error('The recording audio is no longer saved.');
      const micPeaks = (await readMeeting(meetingId))?.audioPeaks?.[recId] ?? [];
      // Tells whether the microphone chunk at `index` was silent.
      const silent = (index) => isSilent(micPeaks, index);
      // Counts the chunks of a track that still need to go to speech-to-text.
      const countToSend = (loaded, skip, finished) =>
        (loaded?.indices ?? []).filter((index) => !skip(index) && !finished?.has(index)).length;
      const total = countToSend(system, () => false, known?.system) + countToSend(mic, silent, known?.mic);
      let sent = 0;
      // Reports transcription progress to the panel.
      const progress = () => broadcast({ done: sent++, total });
      const systemTrack = await sendChunks(system, () => false, endpoint, progress, known?.system, voices);
      const micTrack = await sendChunks(mic, silent, endpoint, progress, known?.mic);
      if (replace) {
        const blocked = tracks.replaceBlocker({ system: systemTrack, mic: micTrack });
        if (blocked) throw new Error(blocked);
      }
      const named = await nameSpeakers(system?.blobs, systemTrack);
      const segments = tracks.mergeTracks({
        system: named.track,
        mic: micTrack,
        chunkMs: source.chunkMs,
        baseTime: source.baseTime,
        imported: source.imported,
      });
      await updateMeeting(meetingId, (meeting) => {
        merge.replaceMeetingAudio(meeting, segments, { baseTime: source.baseTime, replace });
      });
      if (!segments.length) {
        return 'Empty transcript. STT returned no text, so check the speech-to-text address and model in Settings.';
      }
      const failures = [...systemTrack.results, ...micTrack.results].filter((r) => r.error);
      const failed = failures.length
        ? `${failures.length}/${total} parts failed to transcribe: ${failures[0].error}`
        : null;
      return [failed, named.error].filter(Boolean).join(' ') || null;
    }

    // Copies the recording (and video, if any) into the user's recordings folder.
    async function saveToFolder(meetingId, baseTime) {
      if ((await readSettings()).autoSave === false) return;
      const { title } = await readMeeting(meetingId);
      const files = [[audioStore.loadMix, ''], [audioStore.loadVideo, '-video']];
      for (const [load, suffix] of files) {
        const saved = await load(baseTime);
        for (const [i, blob] of (saved?.blobs ?? []).entries()) {
          await saveFile(`${title} ${baseTime}${suffix}.webm`, blob, i === 0);
        }
      }
    }

    // Makes the minutes of meeting automatically when that setting is on.
    async function autoMom(id) {
      const settings = await readSettings();
      if (!settings.autoMom || !merge.canMakeMom(settings)) return;
      const result = await generateMomOnce(id);
      if (!result.ok) broadcast({ error: `MoM could not be made automatically: ${result.error}` });
    }

    // Saves the recording to the folder, turning a failure into a warning.
    const keepInFolder = (meetingId, baseTime) => saveToFolder(meetingId, baseTime).catch((e) => {
      warn(`The recording could not be saved to your folder (${e.message}). It is still available in History.`);
    });

    // Stops the recorder, stores the end time and mic peaks, then copies the files to the folder.
    async function finishRecording(meetingId, baseTime) {
      const { peaks } = await recorder.stop();
      await updateMeeting(meetingId, (meeting) => {
        meeting.endedAt = now();
        meeting.audioPeaks = { ...meeting.audioPeaks, [baseTime]: peaks.mic };
      });
      await keepInFolder(meetingId, baseTime);
    }

    // Stops the running recording and, unless told not to, makes its transcript.
    async function stopRecording({ transcribe: runStt = true } = {}) {
      if (starting) await starting.catch(() => {});
      if (!rec.recording) {
        await finishing?.catch(() => {});
        return;
      }
      const { meetingId, baseTime } = rec;
      const session = live;
      live = null;
      if (session) session.stopped = true;
      rec = { ...rec, recording: false, transcribing: true };
      stopWarning = null;
      broadcast();
      finishing = finishRecording(meetingId, baseTime);
      try {
        await finishing;
        if (runStt) await session?.run;
        const error = runStt ? await transcribe(meetingId, baseTime, false, session?.done, session?.voices) : null;
        rec = { ...IDLE };
        broadcast({ error: [error, stopWarning].filter(Boolean).join(' ') || null });
        if (runStt && !error) autoMom(meetingId).catch((e) => console.error(e));
      } catch (e) {
        rec = { ...IDLE };
        broadcast({ error: e.message });
      }
    }

    // Makes a fresh transcript of a saved recording, replacing the meeting's old one.
    async function regenerate({ id, recId }) {
      if (busy()) return { ok: false, error: 'A recording or transcript is still running.' };
      rec = { ...rec, transcribing: true, meetingId: id };
      broadcast({ error: null });
      try {
        const target = (await audioStore.listRecordings()).find((r) => r.recId === Number(recId));
        if (!target) throw new Error('That recording is no longer saved. Settings decides how many are kept.');
        if (target.meetingId !== id) throw new Error('That recording belongs to another meeting.');
        const error = await transcribe(id, target.recId, true);
        rec = { ...IDLE };
        broadcast({ error });
        return { ok: true };
      } catch (e) {
        rec = { ...IDLE };
        broadcast({ error: e.message });
        return { ok: false, error: e.message };
      }
    }

    // Asks the AI for the minutes of meeting and stores them with the transcript they came from.
    async function generateMom(id) {
      const settings = await readSettings();
      if (!merge.canMakeMom(settings)) throw new Error('Add an API key in the Settings tab first.');
      const meeting = await readMeeting(id);
      if (!meeting?.segments.length) throw new Error('The transcript is empty.');
      const prompt = merge.momPrompt(meeting, settings);
      const momBasedOn = merge.transcriptStamp(meeting);
      const mom = await openai.generateMoM({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        prompt,
        model: settings.model || openai.DEFAULT_MODEL,
      });
      await updateMeeting(id, (fresh) => {
        fresh.mom = mom;
        fresh.momBasedOn = momBasedOn;
      });
      return mom;
    }

    // Makes the minutes of meeting, sharing one request when asked again while it runs.
    function generateMomOnce(id) {
      if (!momInFlight.has(id)) {
        momInFlight.set(id, generateMom(id).then(
          (mom) => ({ ok: true, mom }),
          (e) => ({ ok: false, error: e.message }),
        ).finally(() => momInFlight.delete(id)));
      }
      return momInFlight.get(id);
    }

    // Deletes a meeting and its recordings, unless it is still being recorded.
    async function deleteMeeting({ id }) {
      if (rec.meetingId === id) return { ok: false, error: 'This meeting is still running. Stop it before deleting.' };
      try {
        await audioStore.removeRecordings(id);
        await enqueue(async () => {
          const { meetings = [] } = await storage.get('meetings');
          await storage.set({ meetings: meetings.filter((m) => m !== id) });
          await storage.remove(meetingKey(id));
        });
        if (activeId === id) setActive(null);
        notify({ type: 'meeting-updated', id });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    // Applies a transcript edit and, when a guessed speaker gets a real name, remembers their voice.
    async function editTranscript({ id, change }) {
      const changesTranscript = change.deleteAnswer === undefined && change.toggleItem === undefined;
      if (changesTranscript && rec.meetingId === id) {
        return { ok: false, error: 'This meeting is still running. Stop it before editing.' };
      }
      try {
        const renamesSpeaker = change.segmentId === undefined;
        const wasMatched = renamesSpeaker
          && !!(await readMeeting(id))?.segments.some((s) => s.speaker === change.from && s.matched);
        await updateMeeting(id, (meeting) => merge.editMeeting(meeting, change));
        const to = String(change.to ?? '').trim();
        const namesGuessedSpeaker = renamesSpeaker && (wasMatched || merge.isGuessedSpeaker(change.from));
        if (namesGuessedSpeaker && to && !merge.isGuessedSpeaker(to)) {
          await rememberVoice(id, to).catch((e) => console.error(e));
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    // Transcribes the parts of an imported file one by one until done or cancelled.
    async function transcribeParts(parts, endpoint, run) {
      const results = [];
      const voices = stt.createVoiceMemory();
      for (const [i, part] of parts.entries()) {
        if (run.cancelled) break;
        broadcast({ done: i, total: parts.length });
        try {
          results.push(await sendToStt(part, endpoint, voices));
        } catch (e) {
          results.push({ error: e.message });
        }
      }
      return results;
    }

    // Saves an imported file's audio so it can be played and retranscribed; returns a warning or null.
    async function keepImportedAudio(meetingId, baseTime, parts) {
      try {
        const { keepRecordings } = await readSettings();
        await audioStore.beginAudio({
          meetingId,
          chunkMs: IMPORT_PART_MS,
          baseTime,
          keep: keepRecordings,
          imported: true,
        });
        for (const part of parts) await audioStore.appendSystemChunk(part, baseTime);
        return null;
      } catch (e) {
        await audioStore.removeRecordings(meetingId).catch(() => {});
        return `The audio could not be kept (${e.message}), so this file cannot be played or retranscribed here.`;
      }
    }

    // Transcribes an audio file the user picked and saves it as a new meeting.
    async function importAudio({ file }) {
      if (busy()) return { ok: false, error: 'A recording or transcript is still running.' };
      const meetingId = `desktop-${now()}`;
      const run = { cancelled: false };
      importRun = run;
      // Ends the import and shows `error` (or nothing) in the panel.
      const finish = (error) => {
        rec = { ...IDLE };
        importRun = null;
        broadcast({ error });
      };
      // Ends the import quietly if the user cancelled it, and says whether they did.
      const stopIfCancelled = () => {
        if (run.cancelled) finish(null);
        return run.cancelled;
      };
      rec = { ...rec, transcribing: true, meetingId };
      broadcast({ error: null });
      try {
        const { parts, durationMs } = await splitAudio(file, IMPORT_PART_MS / 1000);
        if (stopIfCancelled()) return { ok: false, cancelled: true };
        if (!parts.length) throw new Error('This file has no audio to transcribe.');
        const results = await transcribeParts(parts, stt.sttEndpoint(await readSettings()), run);
        if (stopIfCancelled()) return { ok: false, cancelled: true };
        const failures = results.filter((r) => r.error);
        if (!results.some((r) => r.segments?.length)) {
          throw new Error(failures[0]?.error ?? 'Transcription returned no text. Check the speech-to-text address and model in Settings.');
        }
        const named = await nameSpeakers(parts, { results, indices: parts.map((_, i) => i) });
        if (stopIfCancelled()) return { ok: false, cancelled: true };
        const startedAt = await audioStore.freeRecId(file.lastModified - durationMs);
        const title = file.name.replace(/\.[^.]*$/, '');
        const sttSegments = stt.mergeSttChunks(named.track.results, IMPORT_PART_MS, startedAt);
        await addMeeting({
          id: meetingId,
          title,
          startedAt,
          endedAt: file.lastModified,
          keepFrom: now(),
          mom: null,
          source: 'audio',
          segments: merge.replaceAudioSegments([], sttSegments, { baseTime: startedAt }),
        });
        const notKept = await keepImportedAudio(meetingId, startedAt, parts);
        setActive(meetingId);
        const failed = failures.length
          ? `${failures.length}/${parts.length} parts failed to transcribe: ${failures[0].error}`
          : null;
        finish([failed, named.error, notKept].filter(Boolean).join(' ') || null);
        if (!failures.length) autoMom(meetingId).catch((e) => console.error(e));
        return { ok: true };
      } catch (e) {
        finish(e.message);
        return { ok: false, error: e.message };
      }
    }

    // Marks the current moment in the running meeting.
    async function markMoment() {
      if (!rec.recording) return { ok: false, error: 'No meeting is running.' };
      const at = now();
      await updateMeeting(rec.meetingId, (meeting) => { meeting.marks = [...(meeting.marks ?? []), at]; });
      return { ok: true };
    }

    // Answers a question about all saved meetings using the AI.
    async function askAll({ question }) {
      try {
        const settings = await readSettings();
        if (!merge.canMakeMom(settings)) throw new Error('Add an API key in the Settings tab first.');
        const { meetings = [] } = await storage.get('meetings');
        const stored = (await Promise.all(meetings.map(readMeeting))).filter(Boolean);
        const { prompt, used, left } = merge.askAllPrompt(stored, question);
        if (!used) throw new Error('There are no meetings to ask about yet.');
        const answer = await openai.generateMoM({
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl,
          model: settings.model || openai.DEFAULT_MODEL,
          prompt,
        });
        return { ok: true, answer, used, left };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    // Answers a question about one meeting using the AI and saves the answer with it.
    async function askMeeting({ id, question }) {
      try {
        const settings = await readSettings();
        if (!merge.canMakeMom(settings)) throw new Error('Add an API key in the Settings tab first.');
        const meeting = await readMeeting(id);
        if (!meeting?.segments.length) throw new Error('The transcript is empty.');
        const basedOn = merge.transcriptStamp(meeting);
        const answer = await openai.generateMoM({
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl,
          model: settings.model || openai.DEFAULT_MODEL,
          prompt: merge.askPrompt(meeting, question),
        });
        await updateMeeting(id, (current) => merge.addAnswer(current, question, answer, basedOn));
        return { ok: true, answer };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    // Deletes meetings older than the "delete after" days setting, if it is set.
    async function deleteOldMeetings() {
      const settings = await readSettings();
      if (!(Number(settings.deleteAfterDays) > 0)) return { ok: true };
      const { meetings = [] } = await storage.get('meetings');
      const stored = await Promise.all(meetings.map(readMeeting));
      const expired = merge.expiredMeetingIds(stored.filter(Boolean), settings.deleteAfterDays, now());
      for (const id of expired) await deleteMeeting({ id });
      return { ok: true };
    }

    const HANDLERS = {
      // Describes the live meeting and recording state for the panel.
      'get-active': () => ({
        id: activeId,
        inCall: false,
        captionsOn: false,
        lastSegmentAt: 0,
        captionsOnAt: 0,
        rec: { ...rec, autoStt: true, muted: recorder.isMuted(), paused: !!recorder.isPaused?.() },
        panelTab: null,
        panelMeetingId: null,
      }),
      // Starts a recording.
      'start-recording': startRecording,
      // Stops the recording.
      'stop-recording': stopRecording,
      // Remakes a meeting's transcript from its saved audio.
      'regenerate-transcript': regenerate,
      // Makes the minutes of meeting.
      'generate-mom': ({ id }) => generateMomOnce(id),
      // Deletes a meeting.
      'delete-meeting': deleteMeeting,
      // Edits a transcript.
      'edit-transcript': editTranscript,
      // Imports an audio file as a meeting.
      'import-audio': importAudio,
      // Marks a moment in the running meeting.
      'mark-moment': markMoment,
      // Answers a question about one meeting.
      'ask-meeting': askMeeting,
      // Answers a question about all meetings.
      'ask-all': askAll,
      // Deletes meetings past the keep-for setting.
      'delete-old-meetings': deleteOldMeetings,
      // Cancels the running file import.
      'cancel-import': () => {
        if (importRun) importRun.cancelled = true;
      },
      // Opens Gemini or ChatGPT in the browser.
      'send-to-ai': ({ target }) => {
        if (Object.hasOwn(AI_URLS, target)) openExternal(AI_URLS[target]);
      },
      // Pauses or resumes the recording.
      'set-paused': ({ on }) => {
        recorder.setPaused(!!on);
        broadcast();
      },
      // Mutes or unmutes the microphone.
      'set-muted': ({ on }) => {
        recorder.setMuted(!!on);
        broadcast();
      },
      // Renames a meeting, ignoring a blank title.
      'rename-meeting': async ({ id, title }) => {
        const clean = String(title ?? '').trim();
        if (clean) await updateMeeting(id, (meeting) => { meeting.title = clean; });
      },
      // Sets a meeting's tags.
      'tag-meeting': async ({ id, tags }) => {
        await updateMeeting(id, (meeting) => { meeting.tags = merge.cleanTags(tags); });
      },
    };

    // Runs the handler for a panel message, the way the extension's service worker would.
    async function handle(msg) {
      return Object.hasOwn(HANDLERS, msg.type) ? HANDLERS[msg.type](msg) : undefined;
    }

    // On app start, closes meetings left open by a crash, saves their files and deletes old meetings.
    async function recover() {
      const settings = await readSettings();
      if (settings.mic === undefined) await storage.set({ settings: { ...settings, mic: true } });
      const { meetings = [] } = await storage.get('meetings');
      for (const id of meetings) {
        if (!String(id).startsWith('desktop-')) continue;
        const meeting = await readMeeting(id);
        if (meeting && !meeting.endedAt) {
          await updateMeeting(id, (m) => { m.endedAt = merge.lastActivityAt(m); });
          const baseTime = Number(String(id).slice('desktop-'.length));
          await keepInFolder(id, baseTime);
        }
      }
      await deleteOldMeetings();
    }

    return { handle, recover, warn, chunkSaved };
  }

  globalThis.createController = createController;
})();
