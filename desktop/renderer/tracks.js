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
        return `Track ${LABEL[name]} gagal ditranskrip, jadi transkrip yang ada tidak diubah. Error STT: ${failed.error}`;
      }
    }
    if (!hasText(system) && !hasText(mic)) {
      return 'Transkrip tidak menghasilkan teks, jadi transkrip yang ada tidak diubah. Cek endpoint/model STT di Settings.';
    }
    return null;
  }

  globalThis.MeetTracks = { mergeTracks, replaceBlocker };
})();
