(() => {
  const SPEECH_RATE = 16000;
  const HEADER_BYTES = 44;
  const BYTES_PER_SAMPLE = 2;
  const MAX_SAMPLE = 32767;
  const LARGE_FILE_BYTES = 500 * 1048576;

  // Builds the 44-byte header of a mono 16-bit WAV file with count samples.
  function wavHeader(count, rate) {
    const size = count * BYTES_PER_SAMPLE;
    const view = new DataView(new ArrayBuffer(HEADER_BYTES));
    const write = (at, text) => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
    write(0, 'RIFF');
    view.setUint32(4, HEADER_BYTES - 8 + size, true);
    write(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * BYTES_PER_SAMPLE, true);
    view.setUint16(32, BYTES_PER_SAMPLE, true);
    view.setUint16(34, BYTES_PER_SAMPLE * 8, true);
    write(36, 'data');
    view.setUint32(40, size, true);
    return view.buffer;
  }

  // Converts float samples between -1 and 1 into 16-bit PCM bytes.
  function pcm(samples) {
    const view = new DataView(new ArrayBuffer(samples.length * BYTES_PER_SAMPLE));
    samples.forEach((sample, i) => {
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(i * BYTES_PER_SAMPLE, Math.round(clamped * MAX_SAMPLE), true);
    });
    return view.buffer;
  }

  // Encodes float samples as a complete WAV file.
  function encodeWav(samples, rate) {
    const out = new Uint8Array(HEADER_BYTES + samples.length * BYTES_PER_SAMPLE);
    out.set(new Uint8Array(wavHeader(samples.length, rate)));
    out.set(new Uint8Array(pcm(samples)), HEADER_BYTES);
    return out.buffer;
  }

  // Mixes all channels of decoded audio down to one channel.
  function mono(audio) {
    const out = new Float32Array(audio.length);
    for (let channel = 0; channel < audio.numberOfChannels; channel++) {
      audio.getChannelData(channel).forEach((sample, i) => { out[i] += sample / audio.numberOfChannels; });
    }
    return out;
  }

  // Wraps speech-rate samples in a WAV Blob.
  const toWav = (samples) => new Blob([encodeWav(samples, SPEECH_RATE)], { type: 'audio/wav' });

  // Decodes an audio Blob into mono samples at the speech rate.
  async function speechSamples(blob) {
    const context = new OfflineAudioContext(1, 1, SPEECH_RATE);
    return mono(await context.decodeAudioData(await blob.arrayBuffer()));
  }

  // Converts an audio Blob into a mono speech-rate WAV Blob.
  const speechWav = async (blob) => toWav(await speechSamples(blob));

  // Joins several audio Blobs into one WAV and returns where each one starts, in seconds.
  async function joinedWav(blobs) {
    const starts = [];
    const parts = [];
    let count = 0;
    for (const blob of blobs) {
      starts.push(count / SPEECH_RATE);
      const samples = await speechSamples(blob).catch(() => new Float32Array(0));
      parts.push(pcm(samples));
      count += samples.length;
    }
    const wav = new Blob([wavHeader(count, SPEECH_RATE), ...parts], { type: 'audio/wav' });
    return { starts, wav };
  }

  // Turns a base64 WAV data URL back into a Blob.
  const wavOf = (dataUrl) => {
    const base64 = String(dataUrl).split(',')[1] ?? '';
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return new Blob([bytes], { type: 'audio/wav' });
  };

  // Joins known voice clips in front of the audio Blobs and says where each voice clip sits.
  async function joinedWithVoices(voices, blobs) {
    const clips = voices.flatMap((voice) => (voice.clips ?? [])
      .map((clip) => ({ name: voice.name, blob: wavOf(clip) })));
    const { wav, starts } = await joinedWav([...clips.map((clip) => clip.blob), ...blobs]);
    const references = clips.map((clip, i) => ({ name: clip.name, start: starts[i], end: starts[i + 1] }));
    return { wav, starts: starts.slice(clips.length), references };
  }

  // Cuts samples into parts of the given length, dropping parts shorter than one second.
  function splitSamples(samples, rate, seconds) {
    const parts = [];
    const step = rate * seconds;
    for (let at = 0; at < samples.length; at += step) parts.push(samples.subarray(at, at + step));
    return parts.filter((part) => part.length >= rate);
  }

  // Decodes an audio file and splits it into WAV parts of the given length.
  async function speechParts(file, seconds) {
    const samples = await speechSamples(file).catch(() => {
      throw new Error('This file could not be read as audio.');
    });
    return {
      durationMs: Math.round((samples.length / SPEECH_RATE) * 1000),
      parts: splitSamples(samples, SPEECH_RATE, seconds).map(toWav),
    };
  }

  // Cuts the audio between two times (in seconds) and returns it as a WAV data URL.
  async function clipDataUrl(blob, from, to) {
    const samples = await speechSamples(blob);
    const clip = samples.subarray(Math.floor(from * SPEECH_RATE), Math.floor(to * SPEECH_RATE));
    const bytes = new Uint8Array(encodeWav(clip, SPEECH_RATE));
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return `data:audio/wav;base64,${btoa(text)}`;
  }

  // Says whether a file is big enough that importing it may run out of memory.
  const isLargeFile = (bytes) => bytes > LARGE_FILE_BYTES;

  globalThis.MeetWav = {
    encodeWav, mono, speechWav, joinedWav, joinedWithVoices, splitSamples, speechParts, clipDataUrl, isLargeFile,
  };
})();
