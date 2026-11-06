(() => {
  const MIX_PART_MS = 60000;
  const PEAK_SAMPLE_MS = 500;
  const PEAK_WINDOW_SAMPLES = 32768;
  const START_TIMEOUT_MS = 15000;
  const SOUND_LEVEL = 0.01;
  const NO_SOUND_WARNING_MS = 60000;
  const FINALIZE_TIMEOUT_MS = 5000;
  const VIDEO_BITRATE = 500000;
  const VIDEO_AUDIO_BITRATE = 48000;
  const DISPLAY_CONSTRAINTS = {
    audio: true,
    video: { width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 10 } },
  };

  function createRecorder(deps) {
    const { MediaRecorder, MediaStream, store, warn } = deps;
    const pick = (preferred, fallback) => (MediaRecorder.isTypeSupported(preferred) ? preferred : fallback);
    const audioMime = pick('audio/webm;codecs=opus', 'audio/webm');
    const videoMime = pick('video/webm;codecs=vp9,opus', 'video/webm');
    let session = null;
    let muted = false;
    let paused = false;

    function withinStartTime(getStream, message) {
      return new Promise((resolve, reject) => {
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(message));
        }, START_TIMEOUT_MS);
        getStream().then((stream) => {
          if (timedOut) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          clearTimeout(timer);
          resolve(stream);
        }, (e) => {
          clearTimeout(timer);
          reject(e);
        });
      });
    }

    const keepSave = (s, save, failText) => s.saves.push(save.catch((e) => warn(failText + e.message)));

    function startChunk(s, track) {
      const data = [];
      const index = track.chunk;
      const chunk = { heard: !paused };
      track.current = chunk;
      const recorder = new MediaRecorder(track.stream, { mimeType: audioMime });
      recorder.ondataavailable = (e) => { if (e.data.size) data.push(e.data); };
      recorder.onstop = () => {
        if (!chunk.heard) return;
        keepSave(s, track.append(new Blob(data, { type: audioMime }), s.recId, index).then(() => deps.onChunkSaved?.()),
          `A ${track.name} track part could not be saved: `);
      };
      recorder.start();
      track.recorder = recorder;
    }

    function rotate(s) {
      for (const track of s.tracks) {
        track.recorder.stop();
        track.chunk += 1;
        startChunk(s, track);
      }
    }

    function watchForNoSound(s, level) {
      if (s.heardSound || paused) return;
      if (level >= SOUND_LEVEL) {
        s.heardSound = true;
        return;
      }
      s.quietMs += s.sampleMs;
      if (s.quietMs < NO_SOUND_WARNING_MS) return;
      s.heardSound = true;
      warn('No computer audio for 1 minute. If the meeting has started, check your speaker or headset output.');
    }

    function samplePeaks(s) {
      const levels = {};
      for (const track of s.tracks) {
        track.analyser.getFloatTimeDomainData(track.buffer);
        const peak = track.buffer.reduce((loudest, v) => Math.max(loudest, Math.abs(v)), 0);
        s.peaks[track.name][track.chunk] = Math.max(s.peaks[track.name][track.chunk] ?? 0, peak);
        levels[track.name] = peak;
      }
      watchForNoSound(s, levels.system);
      deps.onLevels?.(levels);
    }

    function addTrack(s, name, source, append) {
      const destination = s.ctx.createMediaStreamDestination();
      source.connect(destination);
      const analyser = s.ctx.createAnalyser();
      analyser.fftSize = PEAK_WINDOW_SAMPLES;
      source.connect(analyser);
      const track = { name, stream: destination.stream, append, analyser, chunk: 0,
        buffer: new Float32Array(analyser.fftSize) };
      s.tracks.push(track);
      startChunk(s, track);
    }

    async function connectMic(s, gain) {
      try {
        s.micStream = await withinStartTime(() => deps.getUserMedia({ audio: true }), 'no answer within 15 seconds');
        s.ctx.createMediaStreamSource(s.micStream).connect(gain);
        s.micStream.getAudioTracks()[0]?.addEventListener('ended', () =>
          warn('Microphone disconnected. Computer audio keeps recording.'));
      } catch (e) {
        warn(`The microphone could not be used (${e.message}). Computer audio keeps recording.`);
      }
    }

    function startMix(s, mix) {
      const recorder = new MediaRecorder(mix.stream, { mimeType: audioMime });
      recorder.ondataavailable = (e) => {
        if (e.data.size) keepSave(s, store.appendMixPart(e.data, s.recId), 'A part of the recording file could not be saved: ');
      };
      recorder.start(MIX_PART_MS);
      s.mix = recorder;
    }

    function startVideo(s, mix) {
      try {
        const stream = new MediaStream([...s.display.getVideoTracks(), ...mix.stream.getAudioTracks()]);
        const recorder = new MediaRecorder(stream, { mimeType: videoMime,
          videoBitsPerSecond: VIDEO_BITRATE, audioBitsPerSecond: VIDEO_AUDIO_BITRATE });
        recorder.ondataavailable = (e) => {
          if (e.data.size) keepSave(s, store.appendVideoPart(e.data, s.recId), 'A part of the video could not be saved: ');
        };
        recorder.start(MIX_PART_MS);
        s.video = recorder;
      } catch (e) {
        warn(`Video recording could not start (${e.message}). Audio keeps recording.`);
      }
    }

    async function begin(s, { mic, video, chunkMs, prepare }) {
      const app = deps.chosenApp?.() ?? null;
      if (video) await deps.checkVideoSource?.();
      if (!app || video) {
        s.display = await withinStartTime(() => deps.getDisplayMedia(DISPLAY_CONSTRAINTS),
          'Computer audio did not start within 15 seconds. Try again, or restart the app.');
      }
      const systemAudio = s.display?.getAudioTracks() ?? [];
      if (!app && !systemAudio.length) throw new Error('Computer audio is not available.');
      s.ctx = new deps.AudioContext();
      await s.ctx.resume();
      if (app) {
        s.app = await deps.openAppAudio(app, s.ctx, () => warn('The chosen app closed, so its sound is no longer recorded. The microphone keeps recording.'));
        systemAudio.forEach((t) => t.stop());
      }
      await prepare?.();
      if (video) s.display.getVideoTracks().forEach((t) => { t.contentHint = 'detail'; });
      else s.display?.getVideoTracks().forEach((t) => t.stop());
      if (!app) {
        systemAudio[0].addEventListener('ended', () =>
          warn('Computer audio disconnected. The microphone keeps recording.'));
      }

      const mix = s.ctx.createMediaStreamDestination();
      const system = app ? s.app.node : s.ctx.createMediaStreamSource(new MediaStream(systemAudio));
      system.connect(mix);
      addTrack(s, 'system', system, store.appendSystemChunk);
      if (mic) {
        s.gain = s.ctx.createGain();
        s.gain.gain.value = muted ? 0 : 1;
        s.gain.connect(mix);
        addTrack(s, 'mic', s.gain, store.appendMicChunk);
        await connectMic(s, s.gain);
      }
      startMix(s, mix);
      if (video) startVideo(s, mix);
      if (paused) applyPause(s);
      s.timers.push(deps.setInterval(() => rotate(s), chunkMs));
      const fullWindowMs = (PEAK_WINDOW_SAMPLES / s.ctx.sampleRate) * 1000;
      s.sampleMs = Math.min(PEAK_SAMPLE_MS, Math.floor(fullWindowMs));
      s.timers.push(deps.setInterval(() => samplePeaks(s), s.sampleMs));
    }

    async function release(s) {
      for (const timer of s.timers) deps.clearInterval(timer);
      s.app?.close();
      s.display?.getTracks().forEach((t) => t.stop());
      s.micStream?.getTracks().forEach((t) => t.stop());
      await s.ctx?.close().catch(() => {});
      muted = false;
      paused = false;
    }

    async function start(options) {
      if (session) throw new Error('A recording is still running.');
      const s = { recId: options.baseTime, tracks: [], timers: [], saves: [], peaks: { system: [], mic: [] }, heardSound: false, quietMs: 0 };
      session = s;
      try {
        await begin(s, options);
      } catch (e) {
        await release(s);
        session = null;
        throw e;
      }
    }

    function finalize(recorder) {
      return new Promise((resolve) => {
        if (!recorder || recorder.state === 'inactive') return resolve(true);
        const timer = setTimeout(() => resolve(false), FINALIZE_TIMEOUT_MS);
        recorder.addEventListener('stop', () => {
          clearTimeout(timer);
          resolve(true);
        }, { once: true });
        recorder.stop();
      });
    }

    async function stop() {
      const s = session;
      if (!s) throw new Error('No active recording.');
      const recorders = [...s.tracks.map((t) => t.recorder), s.mix, s.video];
      const finished = await Promise.all(recorders.map(finalize));
      if (finished.includes(false)) warn('The end of the recording could not be finished and may be lost.');
      await Promise.all(s.saves);
      await release(s);
      session = null;
      return { peaks: s.peaks };
    }

    function setMuted(on) {
      if (!session) return;
      muted = on;
      if (session.gain) session.gain.gain.value = on ? 0 : 1;
    }

    function applyPause(s) {
      for (const track of [...(s.display?.getTracks() ?? []), ...(s.micStream?.getTracks() ?? [])]) track.enabled = !paused;
      if (s.app) s.app.node.gain.value = paused ? 0 : 1;
    }

    function setPaused(on) {
      if (!session) return;
      paused = on;
      applyPause(session);
      if (!on) for (const track of session.tracks) track.current.heard = true;
    }

    return { start, stop, setMuted, isMuted: () => muted, setPaused, isPaused: () => paused, currentPeaks: () => session?.peaks };
  }

  globalThis.createRecorder = createRecorder;
})();
