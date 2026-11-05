(() => {
  const LABEL = { system: 'Others', mic: 'You' };

  function labelled(track, speaker, chunkMs, baseTime) {
    return globalThis.MeetStt.mergeSttChunks(track.results, chunkMs, baseTime, track.indices)
      .map((segment) => ({ ...segment, speaker }));
  }

  function mergeTracks({ system, mic, chunkMs, baseTime }) {
    return [...labelled(system, LABEL.system, chunkMs, baseTime), ...labelled(mic, LABEL.mic, chunkMs, baseTime)]
      .sort((a, b) => a.t - b.t);
  }

  const hasText = (track) => track.results.some((r) => r?.segments?.length);

  function replaceBlocker({ system, mic }) {
    for (const [name, track] of Object.entries({ system, mic })) {
      const failed = track.results.find((r) => r?.error);
      if (failed && !hasText(track)) {
        return `The ${LABEL[name]} track could not be transcribed, so the existing transcript was not changed. STT error: ${failed.error}`;
      }
    }
    if (!hasText(system) && !hasText(mic)) {
      return 'Transcription returned no text, so the existing transcript was not changed. Check the STT endpoint and model in Settings.';
    }
    return null;
  }

  globalThis.MeetTracks = { mergeTracks, replaceBlocker };
})();
