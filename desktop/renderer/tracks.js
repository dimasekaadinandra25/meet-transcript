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

  const MIN_MATCH_SECONDS = 1;
  function voiceNames(turns, references) {
    const best = new Map();
    for (const name of new Set(references.map((ref) => ref.name))) {
      const heard = new Map();
      for (const ref of references.filter((r) => r.name === name)) {
        for (const turn of turns) heard.set(turn.speaker, (heard.get(turn.speaker) ?? 0) + overlap(ref, turn));
      }
      const [speaker, amount] = [...heard].sort((a, b) => b[1] - a[1])[0] ?? [];
      if (amount >= MIN_MATCH_SECONDS && !(best.get(speaker)?.amount >= amount)) best.set(speaker, { name, amount });
    }
    return new Map([...best].map(([speaker, { name }]) => [speaker, name]));
  }

  function labelSpeakers(track, { starts, turns, references = [] }) {
    if (track.results.some((r) => r?.segments?.some((s) => s.speaker))) return track;
    const names = voiceNames(turns, references);
    const numbers = new Map();
    let matched = false;
    const results = track.results.map((r, i) => (!r?.segments ? r : { ...r, segments: r.segments.map((s) => {
      const line = { start: starts[i] + (s.start ?? 0), end: starts[i] + (s.end ?? (s.start ?? 0) + 1) };
      const best = turns.reduce((top, turn) => (overlap(line, turn) > (top ? overlap(line, top) : 0) ? turn : top), null);
      if (!best) return s;
      if (names.has(best.speaker)) {
        matched = true;
        return { ...s, speaker: names.get(best.speaker), named: true };
      }
      if (!numbers.has(best.speaker)) numbers.set(best.speaker, String(numbers.size + 1));
      return { ...s, speaker: numbers.get(best.speaker) };
    }) }));
    return numbers.size < 2 && !matched ? track : { ...track, results };
  }

  const PIECE_SECONDS = 6;
  const MIN_PIECE_SECONDS = 2;
  const SAMPLE_SECONDS = 10;
  const baseOf = (s) => Number(String(s.id ?? '').match(/^audio:(\d+):/)?.[1] ?? NaN);

  function voicePieces(segments, name) {
    const system = segments.filter((s) => s.speaker !== LABEL.mic && !Number.isNaN(baseOf(s))).sort((a, b) => a.t - b.t);
    const byBase = new Map();
    system.forEach((s, i) => {
      if (s.speaker !== name) return;
      const next = system.slice(i + 1).find((n) => baseOf(n) === baseOf(s));
      const until = Math.min(next?.t ?? Infinity, s.t + PIECE_SECONDS * 1000);
      if (until - s.t < MIN_PIECE_SECONDS * 1000) return;
      byBase.set(baseOf(s), [...(byBase.get(baseOf(s)) ?? []), { t: s.t, until }]);
    });
    const samples = [...byBase].map(([baseTime, all]) => {
      const pieces = [];
      let total = 0;
      for (const piece of all.sort((a, b) => (b.until - b.t) - (a.until - a.t))) {
        if (total >= SAMPLE_SECONDS * 1000) break;
        pieces.push(piece);
        total += piece.until - piece.t;
      }
      return { baseTime, pieces: pieces.sort((a, b) => a.t - b.t), total };
    });
    const best = samples.sort((a, b) => b.total - a.total)[0];
    return best ? { baseTime: best.baseTime, pieces: best.pieces } : null;
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

  globalThis.MeetTracks = { mergeTracks, replaceBlocker, labelSpeakers, voicePieces };
})();
