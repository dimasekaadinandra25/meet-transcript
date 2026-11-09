(() => {
  const RATE = 48000;
  const CHANNELS = 2;
  const BYTES_PER_SAMPLE = 2;
  const FULL_SCALE = 32768;
  const LEAD_SECONDS = 0.2;
  const MAX_BACKLOG_SECONDS = 2;

  // Turns raw 16-bit PCM bytes from one app into a Web Audio node that plays them in order.
  function createPcmSource(ctx) {
    const node = ctx.createGain();
    let nextStartAt = 0;

    // Schedules one block of interleaved stereo samples right after the previous block.
    function push(bytes) {
      const frames = Math.floor(bytes.length / (CHANNELS * BYTES_PER_SAMPLE));
      if (!frames) return;
      if (nextStartAt > ctx.currentTime + MAX_BACKLOG_SECONDS) return;
      const samples = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const buffer = ctx.createBuffer(CHANNELS, frames, RATE);
      for (let channel = 0; channel < CHANNELS; channel++) {
        const out = buffer.getChannelData(channel);
        for (let i = 0; i < frames; i++) {
          const byteOffset = (i * CHANNELS + channel) * BYTES_PER_SAMPLE;
          out[i] = samples.getInt16(byteOffset, true) / FULL_SCALE;
        }
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(node);
      const startAt = nextStartAt > ctx.currentTime ? nextStartAt : ctx.currentTime + LEAD_SECONDS;
      source.start(startAt);
      nextStartAt = startAt + buffer.duration;
    }

    return { node, push };
  }

  globalThis.MeetAppAudio = { createPcmSource };
})();
