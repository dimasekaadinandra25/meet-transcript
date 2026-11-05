(() => {
  const CHUNK_MS = 600000;
  const SILENT_PEAK = 0.01;
  const AI_URLS = { gemini: 'https://gemini.google.com/app', chatgpt: 'https://chatgpt.com/' };
  const IDLE = { recording: false, transcribing: false, meetingId: null, baseTime: null };

  function createController(deps) {
    const { recorder, audioStore, storage, merge, stt, tracks, openai, notify, openExternal, onState, now } = deps;
    let rec = { ...IDLE };
    let activeId = null;
    let starting = null;
    let writes = Promise.resolve();
    const momInFlight = new Map();

    const busy = () => rec.recording || rec.transcribing;
    const meetingKey = (id) => `meeting:${id}`;
    const readSettings = async () => (await storage.get('settings')).settings ?? {};
    const readMeeting = async (id) => (await storage.get(meetingKey(id)))[meetingKey(id)];
    const publishState = () => onState({ recording: rec.recording, muted: recorder.isMuted() });

    function enqueue(work) {
      const run = writes.then(work);
      writes = run.catch(() => {});
      return run;
    }

    const updateMeeting = (id, change) => enqueue(async () => {
      const meeting = await readMeeting(id);
      if (!meeting) throw new Error('Meeting tidak ditemukan.');
      change(meeting);
      await storage.set({ [meetingKey(id)]: meeting });
      notify({ type: 'meeting-updated', id });
    });

    const broadcast = (extra = {}) => notify({ type: 'rec-state', recording: rec.recording,
      transcribing: rec.transcribing, saving: false, muted: recorder.isMuted(), ...extra });

    const addMeeting = (meeting) => enqueue(async () => {
      const { meetings = [] } = await storage.get('meetings');
      await storage.set({ [meetingKey(meeting.id)]: meeting, meetings: [meeting.id, ...meetings] });
      notify({ type: 'meeting-updated', id: meeting.id });
    });

    function setActive(id) {
      activeId = id;
      notify({ type: 'status', id, inCall: false, captionsOn: false, lastSegmentAt: 0, captionsOnAt: 0 });
    }

    async function startRecording({ video }) {
      if (busy()) return { ok: false, error: 'Rekaman masih berjalan.' };
      const baseTime = now();
      const meetingId = `desktop-${baseTime}`;
      rec = { recording: true, transcribing: false, meetingId, baseTime };
      publishState();
      const begin = async () => {
        const settings = await readSettings();
        await recorder.start({ baseTime, mic: !!settings.mic, video: !!video, chunkMs: CHUNK_MS,
          prepare: () => audioStore.beginAudio({ meetingId, chunkMs: CHUNK_MS, baseTime }) });
        await addMeeting({ id: meetingId, title: new Date(baseTime).toLocaleString('id-ID'), startedAt: baseTime,
          endedAt: null, segments: [], mom: null, source: 'audio' });
      };
      starting = begin();
      try {
        await starting;
      } catch (e) {
        rec = { ...IDLE };
        publishState();
        broadcast({ error: e.message });
        return { ok: false, error: e.message };
      } finally {
        starting = null;
      }
      setActive(meetingId);
      broadcast({ error: null });
      return { ok: true };
    }

    async function sendChunks(loaded, skip, endpoint, progress) {
      if (!loaded) return { results: [], indices: [] };
      const results = [];
      for (let i = 0; i < loaded.blobs.length; i++) {
        if (skip(loaded.indices[i])) {
          results.push({ segments: [] });
          continue;
        }
        progress();
        try {
          results.push(await openai.transcribeAudio({ blob: loaded.blobs[i], baseUrl: endpoint.baseUrl,
            apiKey: endpoint.apiKey, model: endpoint.model, language: endpoint.language }));
        } catch (e) {
          results.push({ error: e.message });
        }
      }
      return { results, indices: loaded.indices };
    }

    async function transcribe(meetingId, recId, replace) {
      const endpoint = stt.sttEndpoint(await readSettings());
      const [system, mic] = await Promise.all([audioStore.loadSystem(recId), audioStore.loadMic(recId)]);
      const source = system ?? mic;
      if (!source) throw new Error('Audio rekaman tidak tersimpan lagi.');
      const micPeaks = (await readMeeting(meetingId))?.audioPeaks?.[recId] ?? [];
      const silent = (index) => micPeaks[index] !== undefined && micPeaks[index] !== null && micPeaks[index] < SILENT_PEAK;
      const skippedMic = mic ? mic.indices.filter(silent).length : 0;
      const total = (system?.blobs.length ?? 0) + (mic?.blobs.length ?? 0) - skippedMic;
      let done = 0;
      const progress = () => broadcast({ done: done++, total });
      const systemTrack = await sendChunks(system, () => false, endpoint, progress);
      const micTrack = await sendChunks(mic, silent, endpoint, progress);
      if (replace) {
        const blocked = tracks.replaceBlocker({ system: systemTrack, mic: micTrack });
        if (blocked) throw new Error(blocked);
      }
      const segments = tracks.mergeTracks({ system: systemTrack, mic: micTrack,
        chunkMs: source.chunkMs, baseTime: source.baseTime });
      await updateMeeting(meetingId, (meeting) => {
        meeting.segments = merge.replaceAudioSegments(meeting.segments, segments, { baseTime: source.baseTime, replace });
      });
      if (!segments.length) return 'Transkrip kosong. STT tidak menghasilkan teks, cek endpoint dan model STT di Settings.';
      const failures = [...systemTrack.results, ...micTrack.results].filter((r) => r.error);
      return failures.length ? `${failures.length}/${total} potongan gagal ditranskrip: ${failures[0].error}` : null;
    }

    async function stopRecording({ transcribe: runStt = true } = {}) {
      if (starting) await starting.catch(() => {});
      if (!rec.recording) return;
      const { meetingId, baseTime } = rec;
      rec = { ...rec, recording: false, transcribing: true };
      publishState();
      broadcast();
      try {
        const { peaks } = await recorder.stop();
        await updateMeeting(meetingId, (meeting) => {
          meeting.endedAt = now();
          meeting.audioPeaks = { ...meeting.audioPeaks, [baseTime]: peaks.mic };
        });
        const error = runStt ? await transcribe(meetingId, baseTime, false) : null;
        rec = { ...IDLE };
        broadcast({ error });
      } catch (e) {
        rec = { ...IDLE };
        broadcast({ error: e.message });
      }
      publishState();
    }

    async function regenerate({ id, recId }) {
      if (busy()) return { ok: false, error: 'Rekaman atau transkrip masih berjalan.' };
      rec = { ...rec, transcribing: true, meetingId: id };
      broadcast({ error: null });
      try {
        const target = (await audioStore.listRecordings()).find((r) => r.recId === Number(recId));
        if (!target) throw new Error('Rekaman itu sudah tidak tersimpan, hanya 5 rekaman terakhir yang disimpan.');
        if (target.meetingId !== id) throw new Error('Rekaman itu milik meeting lain.');
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
      if (!settings.apiKey) throw new Error('API key belum diisi di tab Settings.');
      const meeting = await readMeeting(id);
      if (!meeting?.segments.length) throw new Error('Transkrip kosong.');
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

    const HANDLERS = {
      'get-active': () => ({ id: activeId, inCall: false, captionsOn: false, lastSegmentAt: 0, captionsOnAt: 0,
        rec: { ...rec, autoStt: true, muted: recorder.isMuted() }, panelTab: null, panelMeetingId: null }),
      'start-recording': startRecording,
      'stop-recording': stopRecording,
      'regenerate-transcript': regenerate,
      'generate-mom': ({ id }) => generateMomOnce(id),
      'send-to-ai': ({ target }) => {
        if (Object.hasOwn(AI_URLS, target)) openExternal(AI_URLS[target]);
      },
      'set-muted': ({ on }) => {
        recorder.setMuted(!!on);
        publishState();
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

    return { handle, recover, warn: (error) => broadcast({ error }) };
  }

  globalThis.createController = createController;
})();
