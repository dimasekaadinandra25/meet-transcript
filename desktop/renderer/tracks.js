(() => {
  const LABEL = { system: 'Others', mic: 'You' };

  // Turns one track's speech-to-text results into timed transcript segments.
  const segmentsOf = (track, chunkMs, baseTime) =>
    globalThis.MeetStt.mergeSttChunks(track.results, chunkMs, baseTime, track.indices);

  // Combines computer sound and microphone into one time-ordered transcript, dropping mic echoes.
  function mergeTracks({ system, mic, chunkMs, baseTime, imported = false }) {
    const others = segmentsOf(system, chunkMs, baseTime);
    const fallbackSpeaker = imported ? '' : LABEL.system;
    const otherLines = others.map((segment) => ({ ...segment, speaker: segment.speaker || fallbackSpeaker }));
    const micSegments = globalThis.MeetMerge.dropEchoes(segmentsOf(mic, chunkMs, baseTime), others);
    const myLines = micSegments.map((segment) => ({ ...segment, speaker: LABEL.mic }));
    return [...otherLines, ...myLines].sort((a, b) => a.t - b.t);
  }

  // Returns how many seconds two time spans share.
  const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

  const MIN_MATCH_SECONDS = 1;
  // Matches each saved voice to the diarized speaker it overlaps most, giving speaker -> name.
  function voiceNames(turns, references) {
    const best = new Map();
    for (const name of new Set(references.map((ref) => ref.name))) {
      const heard = new Map();
      for (const ref of references.filter((r) => r.name === name)) {
        for (const turn of turns) heard.set(turn.speaker, (heard.get(turn.speaker) ?? 0) + overlap(ref, turn));
      }
      const [speaker, amount] = [...heard].sort((a, b) => b[1] - a[1])[0] ?? [];
      const beatenByEarlier = best.get(speaker)?.amount >= amount;
      if (amount >= MIN_MATCH_SECONDS && !beatenByEarlier) best.set(speaker, { name, amount });
    }
    return new Map([...best].map(([speaker, { name }]) => [speaker, name]));
  }

  // Labels each segment with a saved voice name or a speaker number, using diarized turns.
  function labelSpeakers(track, { starts, turns, references = [] }) {
    if (track.results.some((r) => r?.segments?.some((s) => s.speaker))) return track;
    const names = voiceNames(turns, references);
    const numbers = new Map();
    let matched = false;

    // Gives one segment of chunk `i` the speaker whose turn overlaps it most.
    const labelSegment = (s, i) => {
      const start = starts[i] + (s.start ?? 0);
      const end = starts[i] + (s.end ?? (s.start ?? 0) + 1);
      const line = { start, end };
      const best = turns.reduce((top, turn) => {
        const topOverlap = top ? overlap(line, top) : 0;
        return overlap(line, turn) > topOverlap ? turn : top;
      }, null);
      if (!best) return s;
      if (names.has(best.speaker)) {
        matched = true;
        return { ...s, speaker: names.get(best.speaker), named: true };
      }
      if (!numbers.has(best.speaker)) numbers.set(best.speaker, String(numbers.size + 1));
      return { ...s, speaker: numbers.get(best.speaker) };
    };

    const results = track.results.map((r, i) => {
      if (!r?.segments) return r;
      return { ...r, segments: r.segments.map((s) => labelSegment(s, i)) };
    });
    return numbers.size < 2 && !matched ? track : { ...track, results };
  }

  const PIECE_SECONDS = 6;
  const MIN_PIECE_SECONDS = 2;
  const SAMPLE_SECONDS = 10;
  // Reads the recording start time out of an audio segment id like "audio:<baseTime>:...".
  const baseOf = (s) => Number(String(s.id ?? '').match(/^audio:(\d+):/)?.[1] ?? NaN);

  // Picks up to ~10 seconds of one speaker's clearest lines from a single recording, or null.
  function voicePieces(segments, name) {
    const system = segments
      .filter((s) => s.speaker !== LABEL.mic && !Number.isNaN(baseOf(s)))
      .sort((a, b) => a.t - b.t);
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
      const longestFirst = all.sort((a, b) => (b.until - b.t) - (a.until - a.t));
      for (const piece of longestFirst) {
        if (total >= SAMPLE_SECONDS * 1000) break;
        pieces.push(piece);
        total += piece.until - piece.t;
      }
      return { baseTime, pieces: pieces.sort((a, b) => a.t - b.t), total };
    });
    const best = samples.sort((a, b) => b.total - a.total)[0];
    return best ? { baseTime: best.baseTime, pieces: best.pieces } : null;
  }

  // Tells whether any chunk of the track produced text.
  const hasText = (track) => track.results.some((r) => r?.segments?.length);

  // Explains why a retranscription must not replace the old transcript, or returns null if it may.
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
