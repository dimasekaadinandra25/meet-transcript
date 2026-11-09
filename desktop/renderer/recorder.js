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

  // Records computer sound, microphone and optional video into chunked files plus one mixed file.
  function createRecorder(deps) {
    const { MediaRecorder, MediaStream, store, warn } = deps;
    // Uses the preferred recording format when this browser supports it.
    const pick = (preferred, fallback) => (MediaRecorder.isTypeSupported(preferred) ? preferred : fallback);
    const audioMime = pick('audio/webm;codecs=opus', 'audio/webm');
    const videoMime = pick('video/webm;codecs=vp9,opus', 'video/webm');
    let session = null;
    let muted = false;
    let paused = false;

    // Waits for a media stream, failing with `message` if it takes too long.
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

    // Tracks a pending save so stop() can wait for it, warning if it fails.
    const keepSave = (s, save, failText) => s.saves.push(save.catch((e) => warn(failText + e.message)));

    // Starts recording the next chunk of one track and saves it when that chunk stops.
    function startChunk(s, track) {
      const data = [];
      const index = track.chunk;
      const chunk = { heard: !paused };
      track.current = chunk;
      const recorder = new MediaRecorder(track.stream, { mimeType: audioMime });
      recorder.ondataavailable = (e) => { if (e.data.size) data.push(e.data); };
      recorder.onstop = () => {
        if (!chunk.heard) return;
        const blob = new Blob(data, { type: audioMime });
        const save = track.append(blob, s.recId, index).then(() => deps.onChunkSaved?.());
        keepSave(s, save, `A ${track.name} track part could not be saved: `);
      };
      recorder.start();
      track.recorder = recorder;
    }

    // Closes the current chunk of every track and begins the next one.
    function rotate(s) {
      for (const track of s.tracks) {
        track.recorder.stop();
        track.chunk += 1;
        startChunk(s, track);
      }
    }

    // Warns once if the computer stays silent for a minute after recording starts.
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

    // Measures each track's loudest sample, keeps the peak per chunk and reports live levels.
    function samplePeaks(s) {
      const levels = {};
      for (const track of s.tracks) {
        track.analyser.getFloatTimeDomainData(track.buffer);
        const peak = track.buffer.reduce((loudest, v) => Math.max(loudest, Math.abs(v)), 0);
        const trackPeaks = s.peaks[track.name];
        trackPeaks[track.chunk] = Math.max(trackPeaks[track.chunk] ?? 0, peak);
        levels[track.name] = peak;
      }
      watchForNoSound(s, levels.system);
      deps.onLevels?.(levels);
    }

    // Wires an audio source into its own chunk recorder and level analyser.
    function addTrack(s, name, source, append) {
      const destination = s.ctx.createMediaStreamDestination();
      source.connect(destination);
      const analyser = s.ctx.createAnalyser();
      analyser.fftSize = PEAK_WINDOW_SAMPLES;
      source.connect(analyser);
      const track = {
        name,
        stream: destination.stream,
        append,
        analyser,
        chunk: 0,
        buffer: new Float32Array(analyser.fftSize),
      };
      s.tracks.push(track);
      startChunk(s, track);
    }

    // Opens the microphone into the mic gain node; on failure it warns and keeps going.
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

    // Records the mixed sound into one playable file, saved in parts.
    function startMix(s, mix) {
      const recorder = new MediaRecorder(mix.stream, { mimeType: audioMime });
      recorder.ondataavailable = (e) => {
        if (!e.data.size) return;
        keepSave(s, store.appendMixPart(e.data, s.recId), 'A part of the recording file could not be saved: ');
      };
      recorder.start(MIX_PART_MS);
      s.mix = recorder;
    }

    // Records screen video with the mixed sound; on failure audio keeps recording.
    function startVideo(s, mix) {
      try {
        const stream = new MediaStream([...s.display.getVideoTracks(), ...mix.stream.getAudioTracks()]);
        const recorder = new MediaRecorder(stream, {
          mimeType: videoMime,
          videoBitsPerSecond: VIDEO_BITRATE,
          audioBitsPerSecond: VIDEO_AUDIO_BITRATE,
        });
        recorder.ondataavailable = (e) => {
          if (!e.data.size) return;
          keepSave(s, store.appendVideoPart(e.data, s.recId), 'A part of the video could not be saved: ');
        };
        recorder.start(MIX_PART_MS);
        s.video = recorder;
      } catch (e) {
        warn(`Video recording could not start (${e.message}). Audio keeps recording.`);
      }
    }

    // Opens every source, builds the audio graph and starts all recorders and timers.
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
        const onAppClosed = () =>
          warn('The chosen app closed, so its sound is no longer recorded. The microphone keeps recording.');
        s.app = await deps.openAppAudio(app, s.ctx, onAppClosed);
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

    // Stops timers, streams and the audio context, and resets mute and pause.
    async function release(s) {
      for (const timer of s.timers) deps.clearInterval(timer);
      s.app?.close();
      s.display?.getTracks().forEach((t) => t.stop());
      s.micStream?.getTracks().forEach((t) => t.stop());
      await s.ctx?.close().catch(() => {});
      muted = false;
      paused = false;
    }

    // Starts a new recording session, cleaning up fully if any part fails to start.
    async function start(options) {
      if (session) throw new Error('A recording is still running.');
      const s = {
        recId: options.baseTime,
        tracks: [],
        timers: [],
        saves: [],
        peaks: { system: [], mic: [] },
        heardSound: false,
        quietMs: 0,
      };
      session = s;
      try {
        await begin(s, options);
      } catch (e) {
        await release(s);
        session = null;
        throw e;
      }
    }

    // Stops one MediaRecorder and resolves true once it is done, or false if it hangs.
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

    // Stops all recorders, waits for every save, releases devices and returns the sound peaks.
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

    // Silences or restores the microphone in the recording.
    function setMuted(on) {
      if (!session) return;
      muted = on;
      if (session.gain) session.gain.gain.value = on ? 0 : 1;
    }

    // Turns every captured input off or on to match the paused state.
    function applyPause(s) {
      const inputs = [...(s.display?.getTracks() ?? []), ...(s.micStream?.getTracks() ?? [])];
      for (const track of inputs) track.enabled = !paused;
      if (s.app) s.app.node.gain.value = paused ? 0 : 1;
    }

    // Pauses or resumes recording; chunks heard after resuming are kept.
    function setPaused(on) {
      if (!session) return;
      paused = on;
      applyPause(session);
      if (!on) for (const track of session.tracks) track.current.heard = true;
    }

    return {
      start,
      stop,
      setMuted,
      isMuted: () => muted,
      setPaused,
      isPaused: () => paused,
      currentPeaks: () => session?.peaks,
    };
  }

  globalThis.createRecorder = createRecorder;
})();
