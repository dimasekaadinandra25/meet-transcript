(() => {
  const CHUNK_MS = 120000;
  const SILENT_PEAK = 0.01;
  const AI_URLS = { gemini: 'https://gemini.google.com/app', chatgpt: 'https://chatgpt.com/' };
  const IDLE = { recording: false, transcribing: false, meetingId: null, baseTime: null };

  function createController(deps) {
    const { recorder, audioStore, storage, merge, stt, tracks, openai, notify, openExternal, onState, onWarning, probeStt, saveFile, now } = deps;
    let rec = { ...IDLE };
    let activeId = null;
    let starting = null;
    let finishing = null;
    let live = null;
    let writes = Promise.resolve();
    const momInFlight = new Map();

    const busy = () => rec.recording || rec.transcribing;
    const meetingKey = (id) => `meeting:${id}`;
    const readSettings = async () => (await storage.get('settings')).settings ?? {};
    const readMeeting = async (id) => (await storage.get(meetingKey(id)))[meetingKey(id)];
    const publishState = () => onState({ recording: rec.recording, transcribing: rec.transcribing, muted: recorder.isMuted() });

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
        saving: false, muted: recorder.isMuted(), ...extra });
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
      broadcast({ error });
      onWarning();
    }

    async function checkStt(settings) {
      const { baseUrl, apiKey } = stt.sttEndpoint(settings);
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
          prepare: () => audioStore.beginAudio({ meetingId, chunkMs: CHUNK_MS, baseTime }) });
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
        return { ok: false, error: e.message };
      } finally {
        starting = null;
      }
      live = { meetingId, baseTime, done: { system: new Map(), mic: new Map() }, run: Promise.resolve(), stopped: false };
      setActive(meetingId);
      broadcast({ error: null });
      readSettings().then(checkStt).catch((e) => console.error(e));
      return { ok: true };
    }

    const isSilent = (peaks, index) => peaks[index] !== undefined && peaks[index] !== null && peaks[index] < SILENT_PEAK;

    const sendToStt = (blob, endpoint) => openai.transcribeAudio({ blob, baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey, model: endpoint.model, language: endpoint.language });

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
      const jobs = [[system, session.done.system, () => false], [mic, session.done.mic, (index) => isSilent(peaks, index)]];
      let changed = false;
      for (const [loaded, done, skip] of jobs) {
        for (const [i, index] of (loaded?.indices ?? []).entries()) {
          if (done.has(index) || session.stopped) continue;
          if (skip(index)) {
            done.set(index, { segments: [] });
            continue;
          }
          try {
            const result = await sendToStt(loaded.blobs[i], endpoint);
            if (result.error) throw new Error(result.error);
            done.set(index, result);
            changed = true;
          } catch (e) {
            if (!session.stopped) broadcast({ error: `Live transcript paused (${e.message}). The recording continues, and missing parts are tried again when you stop.` });
            if (changed) await saveLive(session, system ?? mic);
            return;
          }
        }
      }
      if (changed) await saveLive(session, system ?? mic);
    }

    async function saveLive(session, source) {
      const segments = tracks.mergeTracks({ system: finishedTrack(session.done.system), mic: finishedTrack(session.done.mic),
        chunkMs: source.chunkMs, baseTime: source.baseTime });
      await updateMeeting(session.meetingId, (meeting) => {
        meeting.segments = merge.replaceAudioSegments(meeting.segments, segments, { baseTime: source.baseTime });
      });
    }

    function chunkSaved() {
      const session = live;
      if (!session || session.stopped) return;
      session.run = session.run.then(() => catchUpLive(session)).catch((e) => console.error(e));
    }

    async function sendChunks(loaded, skip, endpoint, progress, known) {
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
          results.push(await sendToStt(loaded.blobs[i], endpoint));
        } catch (e) {
          results.push({ error: e.message });
        }
      }
      return { results, indices: loaded.indices };
    }

    async function transcribe(meetingId, recId, replace, known) {
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
      const systemTrack = await sendChunks(system, () => false, endpoint, progress, known?.system);
      const micTrack = await sendChunks(mic, silent, endpoint, progress, known?.mic);
      if (replace) {
        const blocked = tracks.replaceBlocker({ system: systemTrack, mic: micTrack });
        if (blocked) throw new Error(blocked);
      }
      const segments = tracks.mergeTracks({ system: systemTrack, mic: micTrack,
        chunkMs: source.chunkMs, baseTime: source.baseTime });
      await updateMeeting(meetingId, (meeting) => {
        meeting.segments = merge.replaceAudioSegments(meeting.segments, segments, { baseTime: source.baseTime, replace });
      });
      if (!segments.length) return 'Empty transcript. STT returned no text, so check the STT endpoint and model in Settings.';
      const failures = [...systemTrack.results, ...micTrack.results].filter((r) => r.error);
      return failures.length ? `${failures.length}/${total} parts failed to transcribe: ${failures[0].error}` : null;
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

    async function finishRecording(meetingId, baseTime) {
      const { peaks } = await recorder.stop();
      await updateMeeting(meetingId, (meeting) => {
        meeting.endedAt = now();
        meeting.audioPeaks = { ...meeting.audioPeaks, [baseTime]: peaks.mic };
      });
      await saveToFolder(meetingId, baseTime).catch((e) => {
        warn(`The recording could not be saved to your folder (${e.message}). It is still available in History.`);
      });
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
      broadcast();
      finishing = finishRecording(meetingId, baseTime);
      try {
        await finishing;
        if (runStt) await session?.run;
        const error = runStt ? await transcribe(meetingId, baseTime, false, session?.done) : null;
        rec = { ...IDLE };
        broadcast({ error });
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
        if (!target) throw new Error('That recording is no longer saved. Only the last 5 recordings are kept.');
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
      if (!settings.apiKey) throw new Error('Add an API key in the Settings tab first.');
      const meeting = await readMeeting(id);
      if (!meeting?.segments.length) throw new Error('The transcript is empty.');
      const prompt = merge.fillTemplate(settings.momTemplate || merge.DEFAULT_MOM_TEMPLATE,
        merge.formatTranscript(meeting.segments));
      const mom = await openai.generateMoM({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, prompt,
        model: settings.model || openai.DEFAULT_MODEL });
      await updateMeeting(id, (fresh) => { fresh.mom = mom; });
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

    const HANDLERS = {
      'get-active': () => ({ id: activeId, inCall: false, captionsOn: false, lastSegmentAt: 0, captionsOnAt: 0,
        rec: { ...rec, autoStt: true, muted: recorder.isMuted() }, panelTab: null, panelMeetingId: null }),
      'start-recording': startRecording,
      'stop-recording': stopRecording,
      'regenerate-transcript': regenerate,
      'generate-mom': ({ id }) => generateMomOnce(id),
      'delete-meeting': deleteMeeting,
      'send-to-ai': ({ target }) => {
        if (Object.hasOwn(AI_URLS, target)) openExternal(AI_URLS[target]);
      },
      'set-muted': ({ on }) => {
        recorder.setMuted(!!on);
        broadcast();
      },
      'rename-meeting': async ({ id, title }) => {
        const clean = String(title ?? '').trim();
        if (clean) await updateMeeting(id, (meeting) => { meeting.title = clean; });
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
        }
      }
    }

    return { handle, recover, warn, chunkSaved };
  }

  globalThis.createController = createController;
})();
