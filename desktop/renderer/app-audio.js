(() => {
  const RATE = 48000;
  const CHANNELS = 2;
  const BYTES_PER_SAMPLE = 2;
  const FULL_SCALE = 32768;
  const LEAD_SECONDS = 0.2;
  const MAX_BACKLOG_SECONDS = 1;

  function createPcmSource(ctx) {
    const node = ctx.createGain();
    let next = 0;

    function push(bytes) {
      const frames = Math.floor(bytes.length / (CHANNELS * BYTES_PER_SAMPLE));
      if (!frames) return;
      if (next > ctx.currentTime + MAX_BACKLOG_SECONDS) return;
      const samples = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const buffer = ctx.createBuffer(CHANNELS, frames, RATE);
      for (let channel = 0; channel < CHANNELS; channel++) {
        const out = buffer.getChannelData(channel);
        for (let i = 0; i < frames; i++) out[i] = samples.getInt16((i * CHANNELS + channel) * BYTES_PER_SAMPLE, true) / FULL_SCALE;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(node);
      const at = Math.max(next, ctx.currentTime + LEAD_SECONDS);
      source.start(at);
      next = at + buffer.duration;
    }

    return { node, push };
  }

  globalThis.MeetAppAudio = { createPcmSource };
})();
