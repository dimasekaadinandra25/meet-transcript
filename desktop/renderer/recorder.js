(() => {
  const MIX_PART_MS = 60000;
  const PEAK_SAMPLE_MS = 500;
  const PEAK_WINDOW_SAMPLES = 32768;
  const START_TIMEOUT_MS = 15000;
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
      const recorder = new MediaRecorder(track.stream, { mimeType: audioMime });
      recorder.ondataavailable = (e) => { if (e.data.size) data.push(e.data); };
      recorder.onstop = () => keepSave(s, track.append(new Blob(data, { type: audioMime }), s.recId),
        `A ${track.name} track part could not be saved: `);
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

    function samplePeaks(s) {
      for (const track of s.tracks) {
        track.analyser.getFloatTimeDomainData(track.buffer);
        const peak = track.buffer.reduce((loudest, v) => Math.max(loudest, Math.abs(v)), 0);
        s.peaks[track.name][track.chunk] = Math.max(s.peaks[track.name][track.chunk] ?? 0, peak);
      }
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
      s.display = await withinStartTime(() => deps.getDisplayMedia(DISPLAY_CONSTRAINTS),
        'Computer audio did not start within 15 seconds. Try again, or restart the app.');
      const systemAudio = s.display.getAudioTracks();
      if (!systemAudio.length) throw new Error('Computer audio is not available.');
      await prepare?.();
      if (video) s.display.getVideoTracks().forEach((t) => { t.contentHint = 'detail'; });
      else s.display.getVideoTracks().forEach((t) => t.stop());
      systemAudio[0].addEventListener('ended', () =>
        warn('Computer audio disconnected. The microphone keeps recording.'));

      s.ctx = new deps.AudioContext();
      await s.ctx.resume();
      const mix = s.ctx.createMediaStreamDestination();
      const system = s.ctx.createMediaStreamSource(new MediaStream(systemAudio));
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
      s.timers.push(deps.setInterval(() => rotate(s), chunkMs));
      const fullWindowMs = (PEAK_WINDOW_SAMPLES / s.ctx.sampleRate) * 1000;
      s.timers.push(deps.setInterval(() => samplePeaks(s), Math.min(PEAK_SAMPLE_MS, Math.floor(fullWindowMs))));
    }

    async function release(s) {
      for (const timer of s.timers) deps.clearInterval(timer);
      s.display?.getTracks().forEach((t) => t.stop());
      s.micStream?.getTracks().forEach((t) => t.stop());
      await s.ctx?.close().catch(() => {});
      muted = false;
    }

    async function start(options) {
      if (session) throw new Error('A recording is still running.');
      const s = { recId: options.baseTime, tracks: [], timers: [], saves: [], peaks: { system: [], mic: [] } };
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

    return { start, stop, setMuted, isMuted: () => muted };
  }

  globalThis.createRecorder = createRecorder;
})();
