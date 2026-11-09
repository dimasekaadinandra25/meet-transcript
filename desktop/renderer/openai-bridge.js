(() => {
  const { net } = window.desktop;

  // Returns the value of a main-process reply, or rethrows its error with the original name.
  const unwrap = (result) => {
    if (result.ok) return result.value;
    throw Object.assign(new Error(result.error), { name: result.name });
  };

  Object.assign(globalThis.MeetOpenAI, {
    // Asks the chat model through the main process.
    generateMoM: async (args) => unwrap(await net.chat(args)),
    // Checks the AI connection through the main process.
    testConnection: async (args) => unwrap(await net.test(args)),
    // Sends audio to speech-to-text, converting it to WAV for the built-in engine.
    transcribeAudio: async ({ blob, ...args }) => {
      const isWav = blob.type === 'audio/wav';
      if (args.baseUrl !== globalThis.MeetStt.BUILTIN_URL && !isWav) {
        return unwrap(await net.stt({ ...args, bytes: await blob.arrayBuffer() }));
      }
      const wav = isWav ? blob : await globalThis.MeetWav.speechWav(blob);
      return unwrap(await net.stt({ ...args, fileName: 'audio.wav', bytes: await wav.arrayBuffer() }));
    },
  });

  // Shares the minutes of meeting through the main process.
  globalThis.shareMom = async (kind, settings, meeting) => unwrap(await net.share(kind, settings, meeting));

  // Stands in for fetch by routing the request through the main process.
  globalThis.bridgeFetch = async (url, init = {}) => {
    const key = init.headers?.Authorization?.replace(/^Bearer /, '') ?? '';
    const answer = unwrap(await net.probe(url, key));
    return { ...answer, json: async () => answer.body };
  };
})();
