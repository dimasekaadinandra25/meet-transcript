(() => {
  const SPEECH_RATE = 16000;
  const HEADER_BYTES = 44;
  const BYTES_PER_SAMPLE = 2;
  const MAX_SAMPLE = 32767;

  function encodeWav(samples, rate) {
    const size = samples.length * BYTES_PER_SAMPLE;
    const view = new DataView(new ArrayBuffer(HEADER_BYTES + size));
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
    samples.forEach((sample, i) => {
      const limited = Math.max(-1, Math.min(1, sample));
      view.setInt16(HEADER_BYTES + i * BYTES_PER_SAMPLE, Math.round(limited * MAX_SAMPLE), true);
    });
    return view.buffer;
  }

  function mono(audio) {
    const out = new Float32Array(audio.length);
    for (let channel = 0; channel < audio.numberOfChannels; channel++) {
      audio.getChannelData(channel).forEach((sample, i) => { out[i] += sample / audio.numberOfChannels; });
    }
    return out;
  }

  async function speechWav(blob) {
    const context = new OfflineAudioContext(1, 1, SPEECH_RATE);
    const audio = await context.decodeAudioData(await blob.arrayBuffer());
    return new Blob([encodeWav(mono(audio), SPEECH_RATE)], { type: 'audio/wav' });
  }

  globalThis.MeetWav = { encodeWav, mono, speechWav };
})();
