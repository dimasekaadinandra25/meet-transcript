(() => {
  const CHUNK_MS = 120000;
  const IMPORT_PART_MS = 120000;
  const SILENT_PEAK = 0.01;
  const AI_URLS = { gemini: 'https://gemini.google.com/app', chatgpt: 'https://chatgpt.com/' };
  const IDLE = { recording: false, transcribing: false, meetingId: null, baseTime: null };

  function createController(deps) {
    const { recorder, audioStore, storage, merge, stt, tracks, openai, notify, openExternal, onState, onWarning, probeStt, startEngine, splitAudio, clipAudio, saveFile, speakers, now } = deps;
    let rec = { ...IDLE };
    let activeId = null;
    let starting = null;
    let finishing = null;
    let stopWarning = null;
    let importRun = null;
    let live = null;
    let writes = Promise.resolve();
    const momInFlight = new Map();

    const busy = () => rec.recording || rec.transcribing;
    const meetingKey = (id) => `meeting:${id}`;
    const readSettings = async () => (await storage.get('settings')).settings ?? {};
    const readMeeting = async (id) => (await storage.get(meetingKey(id)))[meetingKey(id)];
    const publishState = () => onState({ recording: rec.recording, transcribing: rec.transcribing, muted: recorder.isMuted(), paused: !!recorder.isPaused?.() });

    function enqueue(work) {
      const run = writes.then(work);
      writes = run.catch(() => {});
      return run;
    }

    const updateMeeting = (id, change) => enqueue(async () => {
      const meeting = await readMeeting(id);
      if (!meeting) throw new Error('Meeting not found.');
      change(meeting);
      await storage.set({ [meetingKey(id)]: meeting });
      notify({ type: 'meeting-updated', id });
    });

    function broadcast(extra = {}) {
      publishState();
      notify({ type: 'rec-state', recording: rec.recording, transcribing: rec.transcribing,
        saving: false, muted: recorder.isMuted(), paused: !!recorder.isPaused?.(), importing: !!importRun, ...extra });
    }

    const addMeeting = (meeting) => enqueue(async () => {
      const { meetings = [] } = await storage.get('meetings');
      await storage.set({ [meetingKey(meeting.id)]: meeting, meetings: [meeting.id, ...meetings] });
      notify({ type: 'meeting-updated', id: meeting.id });
    });

    function setActive(id) {
      activeId = id;
      notify({ type: 'status', id, inCall: false, captionsOn: false, lastSegmentAt: 0, captionsOnAt: 0 });
    }

    function warn(error) {
      stopWarning = error;
      if (live) live.paused = false;
      broadcast({ error });
      onWarning();
    }

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
      if (!answer.ok) {
        warn(`Speech-to-text at ${baseUrl} could not be reached. Recording continues, and you can make the transcript later from History.`);
      } else if (answer.value?.status === 401 || answer.value?.status === 403) {
        warn('Speech-to-text rejected the API key. Recording continues, and you can make the transcript later from History.');
      }
    }

    async function startRecording({ video }) {
      if (busy()) return { ok: false, error: 'A recording is still running.' };
      const baseTime = now();
      const meetingId = `desktop-${baseTime}`;
      rec = { recording: true, transcribing: false, meetingId, baseTime };
      publishState();
      const begin = async () => {
        const settings = await readSettings();
        await recorder.start({ baseTime, mic: settings.mic !== false, video: !!video, chunkMs: CHUNK_MS,
          prepare: () => audioStore.beginAudio({ meetingId, chunkMs: CHUNK_MS, baseTime, keep: settings.keepRecordings }) });
        await addMeeting({ id: meetingId, title: new Date(baseTime).toLocaleString(), startedAt: baseTime,
          endedAt: null, segments: [], mom: null, source: 'audio' }).catch(async (e) => {
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
      live = { meetingId, baseTime, done: { system: new Map(), mic: new Map() }, voices: stt.createVoiceMemory(), run: Promise.resolve(), stopped: false };
      setActive(meetingId);
      broadcast({ error: null });
      readSettings().then(checkStt).catch((e) => console.error(e));
      return { ok: true };
    }

    const isSilent = (peaks, index) => peaks[index] !== undefined && peaks[index] !== null && peaks[index] < SILENT_PEAK;

    function sendToStt(blob, endpoint, voices) {
      const send = (knownSpeakers) => openai.transcribeAudio({ blob, baseUrl: endpoint.baseUrl,
        apiKey: endpoint.apiKey, model: endpoint.model, language: endpoint.language, ...(endpoint.vocabulary ? { prompt: endpoint.vocabulary } : {}), ...(knownSpeakers ? { knownSpeakers } : {}) });
      if (!voices || !stt.isDiarizeModel(endpoint.model)) return send();
      return stt.sendWithVoices({ send, blob, voices, makeClip: clipAudio });
    }

    function finishedTrack(done) {
      const indices = [...done.keys()].sort((a, b) => a - b);
      return { results: indices.map((index) => done.get(index)), indices };
    }

    async function catchUpLive(session) {
      const settings = await readSettings();
      if (settings.liveTranscript === false) return;
      const endpoint = stt.sttEndpoint(settings);
      if (!endpoint.baseUrl) return;
      const [system, mic] = await Promise.all([audioStore.loadSystem(session.baseTime), audioStore.loadMic(session.baseTime)]);
      const peaks = recorder.currentPeaks()?.mic ?? [];
      const jobs = [[system, session.done.system, () => false, session.voices], [mic, session.done.mic, (index) => isSilent(peaks, index)]];
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

    async function liveSpeakers(session, loaded) {
      const track = finishedTrack(session.done.system);
      if (session.diarizing || !speakers || !unlabeledTrack(track) || (await readSettings()).localSpeakers === false || !await speakers.available()) return;
      const byIndex = new Map(loaded.indices.map((index, i) => [index, loaded.blobs[i]]));
      const blobs = track.indices.map((index) => byIndex.get(index));
      if (blobs.some((b) => !b)) return;
      session.diarizing = true;
      try {
        const found = await speakers.find(blobs, await savedVoices());
        session.found = { starts: new Map(track.indices.map((index, i) => [index, found.starts[i]])), turns: found.turns, references: found.references };
        if (!session.stopped) await saveLive(session, loaded);
      } catch (e) {
        console.error(e);
      } finally {
        session.diarizing = false;
      }
    }

    async function saveLive(session, source) {
      const done = finishedTrack(session.done.system);
      const system = session.found ? tracks.labelSpeakers(done, { starts: done.indices.map((index) => session.found.starts.get(index)), turns: session.found.turns, references: session.found.references }) : done;
      const segments = tracks.mergeTracks({ system, mic: finishedTrack(session.done.mic),
        chunkMs: source.chunkMs, baseTime: source.baseTime });
      await updateMeeting(session.meetingId, (meeting) => {
        merge.replaceMeetingAudio(meeting, segments, { baseTime: source.baseTime });
      });
    }

    function chunkSaved() {
      const session = live;
      if (!session || session.stopped) return;
      session.run = session.run.then(() => catchUpLive(session)).catch((e) => console.error(e));
    }

    const unlabeledTrack = (track) => track.results.some((r) => r?.segments?.length) && !track.results.some((r) => r?.segments?.some((s) => s.speaker));

    const MAX_VOICES = 8;
    async function savedVoices() {
      if ((await readSettings()).rememberVoices === false) return [];
      return (await storage.get('voices')).voices ?? [];
    }

    async function rememberVoice(meetingId, name) {
      if (!speakers || (await readSettings()).rememberVoices === false || !await speakers.available()) return;
      const sample = tracks.voicePieces((await readMeeting(meetingId))?.segments ?? [], name);
      const system = sample && await audioStore.loadSystem(sample.baseTime);
      if (!system) return;
      const clips = [];
      for (const { t, until } of sample.pieces) {
        const index = Math.floor((t - sample.baseTime) / system.chunkMs);
        const blob = system.blobs[system.indices.indexOf(index)];
        const start = sample.baseTime + index * system.chunkMs;
        if (blob) clips.push(await clipAudio(blob, (t - start) / 1000, Math.min(until - start, system.chunkMs) / 1000));
      }
      if (!clips.length) return;
      const { voices = [] } = await storage.get('voices');
      await storage.set({ voices: [...voices.filter((voice) => voice.name !== name), { name, clips, savedAt: now() }].slice(-MAX_VOICES) });
    }

    async function nameSpeakers(blobs, track) {
      if (!speakers || !blobs?.length || !unlabeledTrack(track) || (await readSettings()).localSpeakers === false || !await speakers.available()) return { track };
      broadcast({ speakers: true });
      try {
        return { track: tracks.labelSpeakers(track, await speakers.find(blobs, await savedVoices())) };
      } catch (e) {
        return { track, error: `Speakers could not be told apart (${e.message}).` };
      }
    }

    async function sendChunks(loaded, skip, endpoint, progress, known, voices) {
      if (!loaded) return { results: [], indices: [] };
      const results = [];
      for (let i = 0; i < loaded.blobs.length; i++) {
        if (known?.has(loaded.indices[i])) {
          results.push(known.get(loaded.indices[i]));
          continue;
        }
        if (skip(loaded.indices[i])) {
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

    async function transcribe(meetingId, recId, replace, known, voices = stt.createVoiceMemory()) {
      const endpoint = stt.sttEndpoint(await readSettings());
      const [system, mic] = await Promise.all([audioStore.loadSystem(recId), audioStore.loadMic(recId)]);
      const source = system ?? mic;
      if (!source) throw new Error('The recording audio is no longer saved.');
      const micPeaks = (await readMeeting(meetingId))?.audioPeaks?.[recId] ?? [];
      const silent = (index) => isSilent(micPeaks, index);
      const toSend = (loaded, skip, finished) => (loaded?.indices ?? []).filter((index) => !skip(index) && !finished?.has(index)).length;
      const total = toSend(system, () => false, known?.system) + toSend(mic, silent, known?.mic);
      let done = 0;
      const progress = () => broadcast({ done: done++, total });
      const systemTrack = await sendChunks(system, () => false, endpoint, progress, known?.system, voices);
      const micTrack = await sendChunks(mic, silent, endpoint, progress, known?.mic);
      if (replace) {
        const blocked = tracks.replaceBlocker({ system: systemTrack, mic: micTrack });
        if (blocked) throw new Error(blocked);
      }
      const named = await nameSpeakers(system?.blobs, systemTrack);
      const segments = tracks.mergeTracks({ system: named.track, mic: micTrack,
        chunkMs: source.chunkMs, baseTime: source.baseTime, imported: source.imported });
      await updateMeeting(meetingId, (meeting) => {
        merge.replaceMeetingAudio(meeting, segments, { baseTime: source.baseTime, replace });
      });
      if (!segments.length) return 'Empty transcript. STT returned no text, so check the speech-to-text address and model in Settings.';
      const failures = [...systemTrack.results, ...micTrack.results].filter((r) => r.error);
      return [failures.length ? `${failures.length}/${total} parts failed to transcribe: ${failures[0].error}` : null, named.error].filter(Boolean).join(' ') || null;
    }

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

    async function autoMom(id) {
      const settings = await readSettings();
      if (!settings.autoMom || !merge.canMakeMom(settings)) return;
      const result = await generateMomOnce(id);
      if (!result.ok) broadcast({ error: `MoM could not be made automatically: ${result.error}` });
    }

    const keepInFolder = (meetingId, baseTime) => saveToFolder(meetingId, baseTime).catch((e) => {
      warn(`The recording could not be saved to your folder (${e.message}). It is still available in History.`);
    });

    async function finishRecording(meetingId, baseTime) {
      const { peaks } = await recorder.stop();
      await updateMeeting(meetingId, (meeting) => {
        meeting.endedAt = now();
        meeting.audioPeaks = { ...meeting.audioPeaks, [baseTime]: peaks.mic };
      });
      await keepInFolder(meetingId, baseTime);
    }

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

    async function generateMom(id) {
      const settings = await readSettings();
      if (!merge.canMakeMom(settings)) throw new Error('Add an API key in the Settings tab first.');
      const meeting = await readMeeting(id);
      if (!meeting?.segments.length) throw new Error('The transcript is empty.');
      const prompt = merge.momPrompt(meeting, settings);
      const momBasedOn = merge.transcriptStamp(meeting);
      const mom = await openai.generateMoM({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, prompt,
        model: settings.model || openai.DEFAULT_MODEL });
      await updateMeeting(id, (fresh) => {
        fresh.mom = mom;
        fresh.momBasedOn = momBasedOn;
      });
      return mom;
    }

    function generateMomOnce(id) {
      if (!momInFlight.has(id)) {
        momInFlight.set(id, generateMom(id).then(
          (mom) => ({ ok: true, mom }),
          (e) => ({ ok: false, error: e.message }),
        ).finally(() => momInFlight.delete(id)));
      }
      return momInFlight.get(id);
    }

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

    async function editTranscript({ id, change }) {
      if (change.deleteAnswer === undefined && change.toggleItem === undefined && rec.meetingId === id) return { ok: false, error: 'This meeting is still running. Stop it before editing.' };
      try {
        const wasMatched = change.segmentId === undefined && !!(await readMeeting(id))?.segments.some((s) => s.speaker === change.from && s.matched);
        await updateMeeting(id, (meeting) => merge.editMeeting(meeting, change));
        const to = String(change.to ?? '').trim();
        if (change.segmentId === undefined && (wasMatched || merge.isGuessedSpeaker(change.from)) && to && !merge.isGuessedSpeaker(to)) {
          await rememberVoice(id, to).catch((e) => console.error(e));
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

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

    async function keepImportedAudio(meetingId, baseTime, parts) {
      try {
        const { keepRecordings } = await readSettings();
        await audioStore.beginAudio({ meetingId, chunkMs: IMPORT_PART_MS, baseTime, keep: keepRecordings, imported: true });
        for (const part of parts) await audioStore.appendSystemChunk(part, baseTime);
        return null;
      } catch (e) {
        await audioStore.removeRecordings(meetingId).catch(() => {});
        return `The audio could not be kept (${e.message}), so this file cannot be played or retranscribed here.`;
      }
    }

    async function importAudio({ file }) {
      if (busy()) return { ok: false, error: 'A recording or transcript is still running.' };
      const meetingId = `desktop-${now()}`;
      const run = { cancelled: false };
      importRun = run;
      const finish = (error) => {
        rec = { ...IDLE };
        importRun = null;
        broadcast({ error });
      };
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
        await addMeeting({ id: meetingId, title: file.name.replace(/\.[^.]*$/, ''), startedAt, endedAt: file.lastModified, keepFrom: now(), mom: null, source: 'audio',
          segments: merge.replaceAudioSegments([], stt.mergeSttChunks(named.track.results, IMPORT_PART_MS, startedAt), { baseTime: startedAt }) });
        const notKept = await keepImportedAudio(meetingId, startedAt, parts);
        setActive(meetingId);
        const failed = failures.length ? `${failures.length}/${parts.length} parts failed to transcribe: ${failures[0].error}` : null;
        finish([failed, named.error, notKept].filter(Boolean).join(' ') || null);
        if (!failures.length) autoMom(meetingId).catch((e) => console.error(e));
        return { ok: true };
      } catch (e) {
        finish(e.message);
        return { ok: false, error: e.message };
      }
    }

    async function markMoment() {
      if (!rec.recording) return { ok: false, error: 'No meeting is running.' };
      const at = now();
      await updateMeeting(rec.meetingId, (meeting) => { meeting.marks = [...(meeting.marks ?? []), at]; });
      return { ok: true };
    }

    async function askAll({ question }) {
      try {
        const settings = await readSettings();
        if (!merge.canMakeMom(settings)) throw new Error('Add an API key in the Settings tab first.');
        const { meetings = [] } = await storage.get('meetings');
        const stored = (await Promise.all(meetings.map(readMeeting))).filter(Boolean);
        const { prompt, used, left } = merge.askAllPrompt(stored, question);
        if (!used) throw new Error('There are no meetings to ask about yet.');
        const answer = await openai.generateMoM({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model || openai.DEFAULT_MODEL, prompt });
        return { ok: true, answer, used, left };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    async function askMeeting({ id, question }) {
      try {
        const settings = await readSettings();
        if (!merge.canMakeMom(settings)) throw new Error('Add an API key in the Settings tab first.');
        const meeting = await readMeeting(id);
        if (!meeting?.segments.length) throw new Error('The transcript is empty.');
        const basedOn = merge.transcriptStamp(meeting);
        const answer = await openai.generateMoM({ apiKey: settings.apiKey, baseUrl: settings.baseUrl,
          model: settings.model || openai.DEFAULT_MODEL, prompt: merge.askPrompt(meeting, question) });
        await updateMeeting(id, (current) => merge.addAnswer(current, question, answer, basedOn));
        return { ok: true, answer };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    async function deleteOldMeetings() {
      const settings = await readSettings();
      if (!(Number(settings.deleteAfterDays) > 0)) return { ok: true };
      const { meetings = [] } = await storage.get('meetings');
      const stored = await Promise.all(meetings.map(readMeeting));
      for (const id of merge.expiredMeetingIds(stored.filter(Boolean), settings.deleteAfterDays, now())) await deleteMeeting({ id });
      return { ok: true };
    }

    const HANDLERS = {
      'get-active': () => ({ id: activeId, inCall: false, captionsOn: false, lastSegmentAt: 0, captionsOnAt: 0,
        rec: { ...rec, autoStt: true, muted: recorder.isMuted(), paused: !!recorder.isPaused?.() }, panelTab: null, panelMeetingId: null }),
      'start-recording': startRecording,
      'stop-recording': stopRecording,
      'regenerate-transcript': regenerate,
      'generate-mom': ({ id }) => generateMomOnce(id),
      'delete-meeting': deleteMeeting,
      'edit-transcript': editTranscript,
      'import-audio': importAudio,
      'mark-moment': markMoment,
      'ask-meeting': askMeeting,
      'ask-all': askAll,
      'delete-old-meetings': deleteOldMeetings,
      'cancel-import': () => {
        if (importRun) importRun.cancelled = true;
      },
      'send-to-ai': ({ target }) => {
        if (Object.hasOwn(AI_URLS, target)) openExternal(AI_URLS[target]);
      },
      'set-paused': ({ on }) => {
        recorder.setPaused(!!on);
        broadcast();
      },
      'set-muted': ({ on }) => {
        recorder.setMuted(!!on);
        broadcast();
      },
      'rename-meeting': async ({ id, title }) => {
        const clean = String(title ?? '').trim();
        if (clean) await updateMeeting(id, (meeting) => { meeting.title = clean; });
      },
      'tag-meeting': async ({ id, tags }) => {
        await updateMeeting(id, (meeting) => { meeting.tags = merge.cleanTags(tags); });
      },
    };

    async function handle(msg) {
      return Object.hasOwn(HANDLERS, msg.type) ? HANDLERS[msg.type](msg) : undefined;
    }

    async function recover() {
      const settings = await readSettings();
      if (settings.mic === undefined) await storage.set({ settings: { ...settings, mic: true } });
      const { meetings = [] } = await storage.get('meetings');
      for (const id of meetings) {
        if (!String(id).startsWith('desktop-')) continue;
        const meeting = await readMeeting(id);
        if (meeting && !meeting.endedAt) {
          await updateMeeting(id, (m) => { m.endedAt = merge.lastActivityAt(m); });
          await keepInFolder(id, Number(String(id).slice('desktop-'.length)));
        }
      }
      await deleteOldMeetings();
    }

    return { handle, recover, warn, chunkSaved };
  }

  globalThis.createController = createController;
})();
