(() => {
  const SPEECH_RATE = 16000;
  const HEADER_BYTES = 44;
  const BYTES_PER_SAMPLE = 2;
  const MAX_SAMPLE = 32767;
  const LARGE_FILE_BYTES = 500 * 1048576;

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

  function pcm(samples) {
    const view = new DataView(new ArrayBuffer(samples.length * BYTES_PER_SAMPLE));
    samples.forEach((sample, i) => view.setInt16(i * BYTES_PER_SAMPLE, Math.round(Math.max(-1, Math.min(1, sample)) * MAX_SAMPLE), true));
    return view.buffer;
  }

  function encodeWav(samples, rate) {
    const out = new Uint8Array(HEADER_BYTES + samples.length * BYTES_PER_SAMPLE);
    out.set(new Uint8Array(wavHeader(samples.length, rate)));
    out.set(new Uint8Array(pcm(samples)), HEADER_BYTES);
    return out.buffer;
  }

  function mono(audio) {
    const out = new Float32Array(audio.length);
    for (let channel = 0; channel < audio.numberOfChannels; channel++) {
      audio.getChannelData(channel).forEach((sample, i) => { out[i] += sample / audio.numberOfChannels; });
    }
    return out;
  }

  const toWav = (samples) => new Blob([encodeWav(samples, SPEECH_RATE)], { type: 'audio/wav' });

  async function speechSamples(blob) {
    const context = new OfflineAudioContext(1, 1, SPEECH_RATE);
    return mono(await context.decodeAudioData(await blob.arrayBuffer()));
  }

  const speechWav = async (blob) => toWav(await speechSamples(blob));

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
    return { starts, wav: new Blob([wavHeader(count, SPEECH_RATE), ...parts], { type: 'audio/wav' }) };
  }

  function splitSamples(samples, rate, seconds) {
    const parts = [];
    for (let at = 0; at < samples.length; at += rate * seconds) parts.push(samples.subarray(at, at + rate * seconds));
    return parts.filter((part) => part.length >= rate);
  }

  async function speechParts(file, seconds) {
    const samples = await speechSamples(file).catch(() => {
      throw new Error('This file could not be read as audio.');
    });
    return {
      durationMs: Math.round((samples.length / SPEECH_RATE) * 1000),
      parts: splitSamples(samples, SPEECH_RATE, seconds).map(toWav),
    };
  }

  async function clipDataUrl(blob, from, to) {
    const samples = await speechSamples(blob);
    const clip = samples.subarray(Math.floor(from * SPEECH_RATE), Math.floor(to * SPEECH_RATE));
    const bytes = new Uint8Array(encodeWav(clip, SPEECH_RATE));
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return `data:audio/wav;base64,${btoa(text)}`;
  }

  const isLargeFile = (bytes) => bytes > LARGE_FILE_BYTES;

  globalThis.MeetWav = { encodeWav, mono, speechWav, joinedWav, splitSamples, speechParts, clipDataUrl, isLargeFile };
})();
