(() => {
  const LABEL = { system: 'Others', mic: 'You' };

  const segmentsOf = (track, chunkMs, baseTime) => globalThis.MeetStt.mergeSttChunks(track.results, chunkMs, baseTime, track.indices);

  function mergeTracks({ system, mic, chunkMs, baseTime, imported = false }) {
    const others = segmentsOf(system, chunkMs, baseTime);
    return [
      ...others.map((segment) => ({ ...segment, speaker: segment.speaker || (imported ? '' : LABEL.system) })),
      ...globalThis.MeetMerge.dropEchoes(segmentsOf(mic, chunkMs, baseTime), others).map((segment) => ({ ...segment, speaker: LABEL.mic })),
    ].sort((a, b) => a.t - b.t);
  }

  const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

  function labelSpeakers(track, { starts, turns }) {
    if (track.results.some((r) => r?.segments?.some((s) => s.speaker))) return track;
    const numbers = new Map();
    const results = track.results.map((r, i) => (!r?.segments ? r : { ...r, segments: r.segments.map((s) => {
      const line = { start: starts[i] + (s.start ?? 0), end: starts[i] + (s.end ?? (s.start ?? 0) + 1) };
      const best = turns.reduce((top, turn) => (overlap(line, turn) > (top ? overlap(line, top) : 0) ? turn : top), null);
      if (!best) return s;
      if (!numbers.has(best.speaker)) numbers.set(best.speaker, String(numbers.size + 1));
      return { ...s, speaker: numbers.get(best.speaker) };
    }) }));
    return numbers.size < 2 ? track : { ...track, results };
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
      return 'Transcription returned no text, so the existing transcript was not changed. Check the speech-to-text address and model in Settings.';
    }
    return null;
  }

  globalThis.MeetTracks = { mergeTracks, replaceBlocker, labelSpeakers };
})();
