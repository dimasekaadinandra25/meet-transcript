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
      const isWav = blob.type === 'audio/wav';
      if (args.baseUrl !== globalThis.MeetStt.BUILTIN_URL && !isWav) return unwrap(await net.stt({ ...args, bytes: await blob.arrayBuffer() }));
      const wav = isWav ? blob : await globalThis.MeetWav.speechWav(blob);
      return unwrap(await net.stt({ ...args, fileName: 'audio.wav', bytes: await wav.arrayBuffer() }));
    },
  });

  globalThis.bridgeFetch = async (url, init = {}) => {
    const key = init.headers?.Authorization?.replace(/^Bearer /, '') ?? '';
    const answer = unwrap(await net.probe(url, key));
    return { ...answer, json: async () => answer.body };
  };
})();
