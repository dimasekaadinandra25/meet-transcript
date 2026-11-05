(() => {
  const { net } = window.desktop;

  const unwrap = (result) => {
    if (result.ok) return result.value;
    throw Object.assign(new Error(result.error), { name: result.name });
  };

  Object.assign(globalThis.MeetOpenAI, {
    generateMoM: async (args) => unwrap(await net.chat(args)),
    testConnection: async (args) => unwrap(await net.test(args)),
    transcribeAudio: async ({ blob, ...args }) => {
      if (args.baseUrl !== globalThis.MeetStt.BUILTIN_URL) return unwrap(await net.stt({ ...args, bytes: await blob.arrayBuffer() }));
      const wav = await globalThis.MeetWav.speechWav(blob);
      return unwrap(await net.stt({ ...args, fileName: 'audio.wav', bytes: await wav.arrayBuffer() }));
    },
  });

  globalThis.bridgeFetch = async (url, init = {}) => {
    const key = init.headers?.Authorization?.replace(/^Bearer /, '') ?? '';
    return unwrap(await net.probe(url, key));
  };
})();
