(() => {
  // Drops the fields that remember a caption line's original text before audio corrected it.
  const withoutCorrection = ({ captionText, correctedFrom, ...line }) => line;

  // Adds a caption segment, or updates the existing one with the same id.
  function upsertSegment(segments, seg) {
    for (let i = segments.length - 1; i >= 0; i--) {
      if (segments[i].id === seg.id) {
        segments[i].speaker = seg.speaker;
        if (segments[i].captionText === seg.text) return segments;
        segments[i] = withoutCorrection(segments[i]);
        segments[i].text = seg.text;
        return segments;
      }
    }
    segments.push({ ...seg });
    return segments;
  }

  const DUPLICATE_WINDOW_MS = 30000;
  const DUPLICATE_WORD_SHARE = 0.7;
  const FUZZY_WORD_LENGTH = 4;
  const SPOKEN_WORD_MS = 400;
  const SUBTITLE_MIN_MS = 1000;
  const DAY_MS = 86400000;
  const PLAY_LEAD_SECONDS = 0.3;
  const ECHO_WINDOW_MS = 5000;
  const ECHO_MIN_WORDS = 3;
  const SPEECH_LETTER = /^Speaker (?:[A-Z]\d*|\d+)$/;
  const CORRECT_MIN_WORDS = 4;
  const CORRECT_WORD_SHARE = 0.7;
  const CORRECT_WINDOW_MS = 8000;
  const BLOCK_MIN_WORDS = 20;

  // Says whether a speaker name is a placeholder like "Speaker A" rather than a real name.
  const isGuessedSpeaker = (name) => SPEECH_LETTER.test(name ?? '');

  // Splits text into lowercase words made of letters and digits.
  const wordsOf = (text) => String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

  // Says whether two words differ by at most one added, removed or changed letter.
  function oneEditApart(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    const restOfA = a.slice(i + 1);
    return restOfA === b.slice(i + 1) || restOfA === b.slice(i) || a.slice(i) === b.slice(i + 1);
  }

  // Says whether a word, or a near spelling of a long word, is in the known set.
  const closeWord = (word, known) => known.has(word)
    || (word.length >= FUZZY_WORD_LENGTH && [...known].some((other) => oneEditApart(word, other)));

  // Notes for each caption the time window around it and the words it holds.
  function captionIndex(captions, windowMs = DUPLICATE_WINDOW_MS) {
    return captions.map((caption) => {
      const start = caption.t ?? 0;
      const words = wordsOf(caption.text);
      return {
        from: start - windowMs,
        to: start + words.length * SPOKEN_WORD_MS + windowMs,
        known: new Set(words),
      };
    });
  }

  // Says whether a segment mostly repeats the words of a caption said around the same time.
  function repeatsCaption(seg, index) {
    const words = wordsOf(seg.text);
    if (!words.length) return false;
    const at = seg.t ?? 0;
    return index.some(({ from, to, known }) => at >= from && at <= to
      && words.filter((word) => closeWord(word, known)).length / words.length >= DUPLICATE_WORD_SHARE);
  }

  // Says whether two words are the same, allowing one typo in long words.
  const sameWord = (a, b) => a === b || (a.length >= FUZZY_WORD_LENGTH && oneEditApart(a, b));

  // Counts how many words of a appear in b in the same order (longest common subsequence).
  function wordsInOrder(a, b) {
    let previous = new Array(b.length + 1).fill(0);
    for (const word of a) {
      const row = [0];
      for (let j = 0; j < b.length; j++) {
        row.push(sameWord(word, b[j]) ? previous[j] + 1 : Math.max(previous[j + 1], row[j]));
      }
      previous = row;
    }
    return previous[b.length];
  }

  // Pairs each audio line with the caption it best matches, so the caption can be corrected.
  function matchAudioToCaptions(captions, audioSegs) {
    const targets = captions
      .filter((caption) => !caption.edited && !caption.captionText)
      .map((caption) => {
        const words = wordsOf(caption.text);
        const start = caption.t ?? 0;
        const from = start - CORRECT_WINDOW_MS;
        const to = start + words.length * SPOKEN_WORD_MS + CORRECT_WINDOW_MS;
        return { caption, words, from, to, lines: [] };
      })
      .filter((target) => target.words.length >= CORRECT_MIN_WORDS);
    for (const seg of audioSegs) {
      const words = wordsOf(seg.text);
      if (seg.failedUntil || words.length < CORRECT_MIN_WORDS) continue;
      const at = seg.t ?? 0;
      let best = null;
      let bestShared = 0;
      for (const target of targets) {
        if (at < target.from || at > target.to) continue;
        const shared = wordsInOrder(words, target.words);
        const nearer = best && shared === bestShared
          && Math.abs(at - target.caption.t) < Math.abs(at - best.caption.t);
        if (shared > bestShared || nearer) {
          best = target;
          bestShared = shared;
        }
      }
      if (best && bestShared / words.length >= CORRECT_WORD_SHARE) best.lines.push({ seg, words });
    }
    return targets;
  }

  // Says whether any word in mine matches any word in theirs.
  const anyWordShared = (mine, theirs) => mine.some((a) => theirs.some((b) => sameWord(a, b)));

  // Says whether the caption and the audio start and end with the same words.
  const sameEnds = (words, spoken) => anyWordShared(words.slice(0, 2), spoken.slice(0, 3))
    && anyWordShared(words.slice(-2), spoken.slice(-3));

  // Replaces caption text with the matching audio transcript where they clearly say the same thing.
  function correctCaptions(segments, audioSegs, baseTime) {
    const isCaption = (seg) => !String(seg.id ?? '').startsWith('audio:');
    const ordered = [...audioSegs].sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
    const corrections = new Map();
    const used = new Set();
    for (const { caption, words, lines } of matchAudioToCaptions(segments.filter(isCaption), ordered)) {
      const spoken = lines.flatMap((line) => line.words);
      const shared = spoken.length ? wordsInOrder(spoken, words) : 0;
      if (!shared) continue;
      if (shared / words.length < CORRECT_WORD_SHARE || shared / spoken.length < CORRECT_WORD_SHARE) continue;
      if (spoken.join(' ') === words.join(' ') || !sameEnds(words, spoken)) continue;
      corrections.set(caption.id, lines.map(({ seg }) => seg.text.trim()).join(' '));
      for (const { seg } of lines) used.add(seg);
    }
    const lines = segments.map((seg) => {
      if (!corrections.has(seg.id)) return seg;
      return { ...seg, text: corrections.get(seg.id), captionText: seg.text, correctedFrom: baseTime };
    });
    return { lines, used };
  }

  // Says whether a long audio line repeats, in order, the captions said around the same time.
  function repeatsCaptionRun(seg, captions) {
    const words = wordsOf(seg.text);
    if (words.length < BLOCK_MIN_WORDS) return false;
    const at = seg.t ?? 0;
    const from = at - DUPLICATE_WINDOW_MS;
    const to = at + words.length * SPOKEN_WORD_MS + DUPLICATE_WINDOW_MS;
    const heard = captions
      .filter((caption) => (caption.t ?? 0) >= from && (caption.t ?? 0) <= to)
      .flatMap((caption) => wordsOf(caption.text));
    return wordsInOrder(words, heard) / words.length >= DUPLICATE_WORD_SHARE;
  }

  // Drops lines from one track that are only an echo of what another track heard.
  function dropEchoes(mine, others) {
    const index = captionIndex(others, ECHO_WINDOW_MS);
    return mine.filter((seg) => wordsOf(seg.text).length < ECHO_MIN_WORDS || !repeatsCaption(seg, index));
  }

  // Merges a recording's transcribed audio lines into the meeting, replacing that recording's old lines.
  function replaceAudioSegments(
    segments,
    audioSegs,
    { baseTime = 0, replace = false, legacy = false, names = {} } = {},
  ) {
    if (!audioSegs.length) return segments;
    const tag = `audio:${baseTime}:`;
    const UNTAGGED = /^audio:\d+$/;
    const isTagged = (seg) => String(seg.id ?? '').startsWith(tag);
    const inside = (at, part) => at >= part.t && at < part.failedUntil;
    const spoken = segments.filter((seg) => (isTagged(seg) && !seg.failed) || seg.correctedFrom === baseTime);
    const savedParts = audioSegs
      .filter((part) => part.failedUntil && spoken.some((seg) => inside(seg.t, part)));
    const inSavedPart = (at) => savedParts.some((part) => inside(at, part));
    const drop = (seg) => {
      if (isTagged(seg)) return seg.failed || !inSavedPart(seg.t);
      return replace && legacy && UNTAGGED.test(String(seg.id ?? ''));
    };
    const restored = segments.filter((seg) => !drop(seg)).map((seg) => {
      const undoCorrection = seg.correctedFrom === baseTime && !seg.edited && !inSavedPart(seg.t);
      return undoCorrection ? { ...withoutCorrection(seg), text: seg.captionText } : seg;
    });
    const heard = audioSegs.filter((seg) => !inSavedPart(seg.t));
    const { lines: kept, used } = correctCaptions(restored, heard, baseTime);
    const captionLines = kept
      .filter((seg) => !String(seg.id ?? '').startsWith('audio:'))
      .map((seg) => ({ t: seg.t, text: `${seg.text} ${seg.captionText ?? ''}` }));
    const captions = captionIndex(captionLines);
    const usedIds = new Set(kept.map((seg) => seg.id));
    let next = 0;
    const freshId = () => {
      while (usedIds.has(`${tag}${next}`)) next++;
      return `${tag}${next++}`;
    };
    const isNew = (seg) => !used.has(seg) && !repeatsCaption(seg, captions) && !repeatsCaptionRun(seg, captionLines);
    const fresh = heard.filter(isNew).map(({ failedUntil, ...seg }) => ({
      ...seg,
      ...(Object.hasOwn(names, seg.speaker) ? { speaker: names[seg.speaker] } : {}),
      ...(failedUntil ? { failed: true } : {}),
      id: freshId(),
    }));
    return kept.concat(fresh).sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  }

  // Applies a user's edit to the transcript: renames a speaker, changes a line, or deletes it.
  function applyTranscriptEdit(segments, { segmentId, text, from, to }) {
    if (segmentId === undefined) {
      const name = String(to ?? '').trim();
      if (name === from) return segments;
      return segments.map(({ matched, ...seg }) => {
        if (seg.speaker === from) return { ...seg, speaker: name };
        return { ...seg, ...(matched ? { matched } : {}) };
      });
    }
    const clean = String(text ?? '').trim();
    if (!clean) return segments.filter((seg) => seg.id !== segmentId);
    return segments.map((seg) => {
      if (seg.id !== segmentId || seg.text === clean) return seg;
      return { ...seg, text: clean, edited: true };
    });
  }

  // Puts a recording's new transcript into the meeting, using the speaker names already given.
  function replaceMeetingAudio(meeting, audioSegs, { baseTime, replace, legacy }) {
    const options = { baseTime, replace, legacy, names: meeting.speakerNames };
    meeting.segments = replaceAudioSegments(meeting.segments, audioSegs, options);
    if (replace && meeting.deletedFrom) meeting.deletedFrom = meeting.deletedFrom.filter((base) => base !== baseTime);
  }

  // Keeps the speaker renames worth carrying to a new transcript, or undefined if none.
  function carriedNames(names) {
    const kept = Object.entries(names ?? {}).filter(([from, to]) => from && to && !SPEECH_LETTER.test(from));
    return kept.length ? Object.fromEntries(kept) : undefined;
  }

  // Remembers which recording a deleted audio line came from.
  function rememberDeletedLine(meeting, { segmentId, text }) {
    if (segmentId === undefined || String(text ?? '').trim()) return;
    const base = String(segmentId).match(/^audio:(\d+):/)?.[1];
    if (base && meeting.segments.some((seg) => seg.id === segmentId)) {
      meeting.deletedFrom = [...new Set([...(meeting.deletedFrom ?? []), Number(base)])];
    }
  }

  // Applies a change to a meeting: ticks an action item, deletes an answer, or edits the transcript.
  function editMeeting(meeting, change) {
    if (change.toggleItem !== undefined) {
      const done = meeting.doneItems ?? [];
      meeting.doneItems = done.includes(change.toggleItem)
        ? done.filter((item) => item !== change.toggleItem)
        : [...done, change.toggleItem];
      return;
    }
    if (change.deleteAnswer !== undefined) {
      const { question, answer } = change.deleteAnswer;
      const answers = meeting.answers ?? [];
      const at = answers.findIndex((a) => a.question === question && a.answer === answer);
      meeting.answers = answers.filter((_, i) => i !== at);
      return;
    }
    rememberDeletedLine(meeting, change);
    meeting.segments = applyTranscriptEdit(meeting.segments, change);
    if (change.segmentId !== undefined) return;
    const to = String(change.to ?? '').trim();
    const names = Object.fromEntries(Object.entries(meeting.speakerNames ?? {})
      .map(([key, name]) => [key, name === change.from ? to : name]));
    meeting.speakerNames = Object.hasOwn(names, change.from) ? names : { ...names, [change.from]: to };
  }

  const ACTION_HEADING = /^[\W\d_]*(?:(?:action|task|to.?do|follow.?up|promise)s?(?:\s+items?)?|next\s+steps?|tindak\s+lanjut|rencana\s+tindak\s+lanjut|(?:item\s+)?tindakan|(?:item\s+)?aksi|tugas|langkah(?:\s+selanjutnya)?|janji|acciones|tareas|pr[oó]ximos\s+pas(?:os|sos)|a[cç][oõ]es|aufgaben|n[aä]chste\s+schritte)(?![\p{L}\p{N}])|^[\W\d_]*(?:待办|行动项|行動項目|アクション|액션)/iu;
  const MARKDOWN_HEADING = /^\s*#{1,6}\s+(.*)$/;
  const BOLD_LINE = /^\s*(?:\d+[.)]\s+)?\*\*([^*]+)\*\*:?\s*$/;
  const BOLD_LEAD = /^\s*\*\*[^*]+\*\*:\s+\S/;
  const LIST_LINE = /^\s*(?:[-*•]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+)$/;
  const SUB_ITEM = /^\s{2,}(?:[-*•]|\d+[.)])\s/;
  const TABLE_LINE = /^\s*\|(.+)\|\s*$/;
  const TABLE_RULE = /^\s*\|[\s:|-]+\|\s*$/;
  const NO_ITEM = /^(?:none\b.*|no action items?\b.*|nothing\b.*|n\/a|-+|tidak ada\b.*|belum ada\b.*)\.?$/i;

  // Removes Markdown bold marks and outer spaces from an action item.
  const plainItem = (text) => text.replace(/\*\*/g, '').trim();

  // Finds the action items in the MoM's action section, noting which are ticked off.
  function actionItems(meeting) {
    const done = new Set(meeting.doneItems ?? []);
    const lines = String(meeting.mom ?? '').split(/\r?\n/);
    const items = [];
    const addItem = (text) => {
      if (text && !NO_ITEM.test(text)) items.push({ text, done: done.has(text) });
    };
    let inside = false;
    let found = false;
    let person = '';
    lines.forEach((line, i) => {
      const heading = line.match(MARKDOWN_HEADING)?.[1];
      const bold = line.match(BOLD_LINE);
      const boldHeading = bold && (!inside || /:\s*(?:\*\*)?\s*$/.test(line));
      if (heading !== undefined || boldHeading) {
        inside = ACTION_HEADING.test(heading ?? bold[1]);
        found = false;
        person = '';
        return;
      }
      if (!inside || !line.trim()) return;
      if (bold) {
        person = bold[1].trim();
        return;
      }
      if (TABLE_LINE.test(line)) {
        if (!TABLE_RULE.test(line) && !TABLE_RULE.test(lines[i + 1] ?? '')) {
          const cells = line.match(TABLE_LINE)[1].split('|').map((cell) => plainItem(cell)).filter(Boolean);
          addItem(cells.join(' - '));
          found = true;
        }
        return;
      }
      if (SUB_ITEM.test(line) && found) return;
      const listed = line.match(LIST_LINE)?.[1];
      if (listed !== undefined || BOLD_LEAD.test(line)) {
        const text = plainItem(listed ?? line);
        addItem(person ? `${person}: ${text}` : text);
        found = true;
      } else if (found) {
        inside = false;
      }
    });
    return items;
  }

  const ASK_ALL_MAX_CHARS = 60000;
  const ASK_ALL_MIN_PART = 2000;

  // Builds a prompt that asks a question across many meetings, most relevant first, within a size limit.
  function askAllPrompt(meetings, question) {
    const blocks = [];
    let size = 0;
    let left = 0;
    const wanted = keyWords(question);
    const bodyOf = (meeting) => meeting.mom || formatTranscript(meeting.segments ?? []);
    const score = (meeting) => {
      const words = keyWords(`${meeting.title} ${bodyOf(meeting)}`);
      return [...wanted].filter((word) => words.has(word)).length;
    };
    const ranked = meetings.map((meeting) => ({ meeting, score: score(meeting) }))
      .sort((a, b) => b.score - a.score || (b.meeting.startedAt ?? 0) - (a.meeting.startedAt ?? 0));
    for (const { meeting } of ranked) {
      const body = bodyOf(meeting);
      if (!body) continue;
      const block = `## ${meeting.title} (${new Date(meeting.startedAt).toLocaleDateString()})\n${body}`;
      const room = ASK_ALL_MAX_CHARS - size;
      if (block.length > room) left++;
      if (block.length > room && room < ASK_ALL_MIN_PART) continue;
      const fitted = block.slice(0, room);
      blocks.push(fitted);
      size += fitted.length;
    }
    const prompt = `Answer the question using only the meetings below, the ones closest to the question first. Name the meeting each fact comes from. If they do not say, answer that they do not say. Reply in the language of the question.

Question: ${question}

Meetings:
${blocks.join('\n\n')}`;
    return { prompt, used: blocks.length, left };
  }

  // Names the history group a meeting falls in: Today, Yesterday, This week or Earlier.
  function dateGroup(t, now) {
    const dayStart = (ms) => new Date(ms).setHours(0, 0, 0, 0);
    const days = Math.round((dayStart(now) - dayStart(t)) / 86400000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return days < 7 ? 'This week' : 'Earlier';
  }

  // Estimates the minutes left for a job from its progress so far, or null if unknown.
  function minutesLeft(done, total, elapsedMs) {
    if (!done || done >= total) return null;
    return Math.max(1, Math.round((elapsedMs / done) * (total - done) / 60000));
  }

  // Lists the ids of meetings not used for longer than the given number of days.
  function expiredMeetingIds(meetings, days, now) {
    if (!(Number(days) > 0)) return [];
    const cutoff = now - Number(days) * DAY_MS;
    return meetings.filter((meeting) => {
      const lastUse = Math.max(lastActivityAt(meeting), meeting.keepFrom ?? 0);
      return lastUse > 0 && lastUse < cutoff;
    }).map((meeting) => meeting.id);
  }

  // Counts the failed audio parts of a meeting, grouped by recording.
  function failedParts(meeting) {
    const counts = new Map();
    for (const seg of meeting.segments ?? []) {
      const base = seg.failed && String(seg.id ?? '').match(/^audio:(\d+):/)?.[1];
      if (base) counts.set(Number(base), (counts.get(Number(base)) ?? 0) + 1);
    }
    return [...counts].map(([baseTime, count]) => ({ baseTime, count }));
  }

  // Works out how much of the talking each speaker did, by word count, most first.
  function speakerShares(segments) {
    const words = new Map();
    for (const seg of segments ?? []) {
      if (!seg.speaker) continue;
      const count = String(seg.text ?? '').match(/\S+/g)?.length ?? 0;
      words.set(seg.speaker, (words.get(seg.speaker) ?? 0) + count);
    }
    const total = [...words.values()].reduce((sum, n) => sum + n, 0);
    if (words.size < 2 || !total) return [];
    return [...words]
      .map(([speaker, n]) => ({ speaker, words: n, share: Math.round((n / total) * 100) }))
      .sort((a, b) => b.words - a.words);
  }

  // Collects the lowercase words of four or more letters in a text.
  const keyWords = (text) => new Set(String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);

  // Finds the transcript line that shares the most key words with a text, if any shares two or more.
  function sourceLine(meeting, text) {
    const wanted = keyWords(text);
    let best = null;
    let bestScore = 1;
    for (const seg of meeting.segments ?? []) {
      const words = keyWords(seg.text);
      const score = [...wanted].filter((word) => words.has(word)).length;
      if (score > bestScore) [best, bestScore] = [seg.id, score];
    }
    return best;
  }

  // Says whether a recording covers the given time.
  const coversLine = (rec, t) => {
    const parts = Math.max(rec.count ?? 0, rec.systemCount ?? 0, rec.micCount ?? 0);
    return t >= rec.baseTime && t < rec.baseTime + rec.chunkMs * parts;
  };

  // Finds the chunk that holds a time and where in it to start playing.
  const locateLine = (t, baseTime, chunkMs) => ({
    index: Math.floor((t - baseTime) / chunkMs),
    offset: Math.max(0, ((t - baseTime) % chunkMs) / 1000 - PLAY_LEAD_SECONDS),
  });

  // Rounds seconds to whole milliseconds.
  const inMillis = (seconds) => Math.round(seconds * 1000) / 1000;

  // Plans how to play a stretch of a recording, spilling into the next chunk if needed.
  function playPlan(t, baseTime, chunkMs, seconds) {
    const { index, offset } = locateLine(t, baseTime, chunkMs);
    const start = inMillis(offset);
    const room = inMillis(chunkMs / 1000 - offset);
    if (seconds <= room) return [{ index, offset: start, wait: 0, seconds }];
    return [
      { index, offset: start, wait: 0, seconds: room },
      { index: index + 1, offset: 0, wait: room, seconds: inMillis(seconds - room) },
    ];
  }

  // Formats milliseconds as a subtitle time like 00:01:02,345.
  function subtitleTime(ms, separator) {
    const part = (value, size) => String(Math.floor(value)).padStart(size, '0');
    const hours = part(ms / 3600000, 2);
    const minutes = part((ms % 3600000) / 60000, 2);
    const seconds = part((ms % 60000) / 1000, 2);
    return `${hours}:${minutes}:${seconds}${separator}${part(ms % 1000, 3)}`;
  }

  // Picks the time subtitles count from: the first recording, or else the earliest line.
  const subtitleOrigin = (meeting, baseTimes) => (baseTimes.length
    ? Math.min(...baseTimes)
    : meeting.segments.reduce((first, seg) => Math.min(first, seg.t), meeting.startedAt));

  // Builds an .srt or .vtt subtitle file from transcript lines.
  function formatSubtitles(segments, kind, origin = segments[0]?.t ?? 0) {
    const separator = kind === 'srt' ? ',' : '.';
    const clean = (text) => {
      if (kind !== 'vtt') return text;
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/-->/g, '--&gt;');
    };
    const shown = segments.filter((seg) => seg.t >= origin);
    const blocks = shown.map((seg, i) => {
      const from = Math.max(0, seg.t - origin);
      const spoken = Math.max(SUBTITLE_MIN_MS, wordsOf(seg.text).length * SPOKEN_WORD_MS);
      const next = shown[i + 1];
      const until = next && next.t > seg.t ? Math.min(next.t - origin, from + spoken) : from + spoken;
      const to = Math.max(from + 1, until);
      const times = `${subtitleTime(from, separator)} --> ${subtitleTime(to, separator)}`;
      const line = clean(seg.text.replace(/\s*\n\s*/g, ' '));
      const text = seg.speaker ? `${clean(seg.speaker)}: ${line}` : line;
      return (kind === 'srt' ? [i + 1, times, text] : [times, text]).join('\n');
    });
    return `${kind === 'srt' ? '' : 'WEBVTT\n\n'}${blocks.join('\n\n')}\n`;
  }

  // Pads a number to two digits.
  const pad = (n) => String(n).padStart(2, '0');

  // Formats a timestamp as a local HH:MM:SS clock time.
  function timeOf(t) {
    const d = new Date(t);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // Formats one transcript line as "[time] speaker: text".
  const transcriptLine = (seg) => (seg.speaker
    ? `[${timeOf(seg.t)}] ${seg.speaker}: ${seg.text}`
    : `[${timeOf(seg.t)}] ${seg.text}`);

  // Formats transcript lines as plain text, one per line.
  const formatTranscript = (segments) => segments.map(transcriptLine).join('\n');

  // Returns the translated label shown for a marked moment.
  const markLabel = () => `★ ${(globalThis.MeetI18n?.t ?? String)('Marked')}`;

  // Merges a meeting's transcript lines and marked moments in time order.
  const timeline = (meeting) => [...meeting.segments, ...(meeting.marks ?? []).map((t) => ({ t, mark: true }))]
    .sort((a, b) => a.t - b.t);

  // Formats the transcript as plain text with the marked moments in place.
  const formatWithMarks = (meeting) => timeline(meeting)
    .map((item) => (item.mark ? `[${timeOf(item.t)}] ${markLabel()}` : transcriptLine(item)))
    .join('\n');

  // Puts text on one line and escapes the Markdown special characters.
  const mdText = (text) => String(text ?? '').replace(/\s*\n\s*/g, ' ').replace(/[\\`*_[\]<>#|~]/g, '\\$&');

  // Formats one transcript line or marked moment as a Markdown list item.
  function markdownLine(item) {
    if (item.mark) return `- **${markLabel()}** (${timeOf(item.t)})`;
    if (item.speaker) return `- **${mdText(item.speaker)}** (${timeOf(item.t)}): ${mdText(item.text)}`;
    return `- (${timeOf(item.t)}): ${mdText(item.text)}`;
  }

  // Builds the Markdown export of a meeting.
  function formatMarkdown(meeting) {
    const lines = [
      `# ${mdText(meeting.title)}`,
      '',
      new Date(meeting.startedAt).toLocaleString(),
      '',
      ...timeline(meeting).map(markdownLine),
    ];
    if (meeting.mom) lines.push('', '---', '', '## MoM', '', meeting.mom);
    return lines.join('\n');
  }

  // Computes a short hash of the transcript, to tell later whether it changed.
  function transcriptStamp(meeting) {
    let stamp = 0;
    const text = meeting.segments.map((seg) => `${seg.speaker}\n${seg.text}`).join('\n');
    for (const char of text) stamp = (stamp * 31 + char.codePointAt(0)) | 0;
    return stamp;
  }

  // Says whether the transcript changed since the given stamp was taken.
  const changedSince = (meeting, stamp) => stamp !== undefined && transcriptStamp(meeting) !== stamp;

  // Adds a question and its answer to the top of a meeting's answers.
  function addAnswer(meeting, question, answer, basedOn) {
    meeting.answers = [{ question, answer, basedOn }, ...(meeting.answers ?? [])];
  }

  // Builds the prompt that asks a language model to write the MoM.
  function momPrompt(meeting, settings) {
    const prompt = fillTemplate(momTemplateOf(settings.momTemplate), formatTranscript(meeting.segments));
    if (!meeting.marks?.length) return prompt;
    const marked = meeting.marks.map(timeOf).join(', ');
    return `${prompt}\n\nImportant moments marked during the meeting, give them priority: ${marked}`;
  }

  // Builds the prompt that asks a question about one meeting.
  const askPrompt = (meeting, question) => `Answer the question using only the meeting transcript below. If the transcript does not say, answer that it does not say. Reply in the language of the question.

Question: ${question}

Transcript:
${formatTranscript(meeting.segments)}`;

  // Returns when a meeting was last active: its end, or else its latest line.
  function lastActivityAt(meeting) {
    if (meeting.endedAt) return meeting.endedAt;
    let last = meeting.startedAt ?? 0;
    for (const seg of meeting.segments ?? []) if ((seg.t ?? 0) > last) last = seg.t;
    return last;
  }

  const SESSION_GAP_MS = 30 * 60 * 1000;
  const CRASH_GAP_MS = 6 * 60 * 60 * 1000;

  // Says whether a meeting has been quiet too long to continue it.
  function isStaleMeeting(meeting, now) {
    const gap = meeting.endedAt ? SESSION_GAP_MS : CRASH_GAP_MS;
    return now - lastActivityAt(meeting) > gap;
  }

  // Finds the latest meeting that started at or before a recording began.
  function ownerOfRecording(records, baseTime) {
    let best = null;
    for (const record of records) {
      if (record && record.startedAt <= baseTime && (!best || record.startedAt > best.startedAt)) best = record;
    }
    return best;
  }

  const OPENAI_HOST = 'api.openai.com';

  // Builds a MoM prompt template with the given kind of notes and section headings.
  const momTemplate = (kind, sections) => `Create ${kind} from the meeting transcript below.

Write the whole MoM, including the section headings, in the main language spoken in the transcript. If the transcript mixes languages, use the one spoken most.

Format:
${sections.map((section) => `## ${section}`).join('\n')}

Transcript:
{{transcript}}`;

  const DEFAULT_MOM_TEMPLATE = momTemplate('Minutes of Meeting (MoM)', [
    'Date:', 'Related Project:', 'Participants', 'Context', 'Discussion', 'Action Items (who, what)',
  ]);
  const MOM_PRESETS = [
    { name: 'Standard', template: DEFAULT_MOM_TEMPLATE },
    {
      name: 'Standup',
      template: momTemplate('standup notes (MoM)', ['Done since last time', 'Plans until next time', 'Blockers (who, what)']),
    },
    {
      name: 'Client call',
      template: momTemplate('client call notes (MoM)', [
        'Date:', 'Client and attendees', 'Client needs', 'Decisions', 'Promises we made (who, what, when)', 'Next steps',
      ]),
    },
    {
      name: '1-on-1',
      template: momTemplate('1-on-1 notes (MoM)', ['Date:', 'Topics', 'Feedback', 'Decisions', 'Action Items (who, what)']),
    },
  ];

  // Returns the saved MoM template, or the default when none is saved or it is the old default.
  const momTemplateOf = (saved) => (!saved || saved === OLD_MOM_TEMPLATE ? DEFAULT_MOM_TEMPLATE : saved);

  // Says whether the settings allow making a MoM with a language model.
  const canMakeMom = ({ apiKey, baseUrl }) => !!apiKey || (!!baseUrl && !baseUrl.includes(OPENAI_HOST));

  // Puts the transcript into a template in place of {{transcript}}.
  function fillTemplate(template, transcript) {
    return template.split('{{transcript}}').join(transcript);
  }

  const OLD_MOM_TEMPLATE = `Buat Minutes of Meeting (MoM) dari transkrip meeting berikut.

Format:
## Date:
## Related Project:
## Participants
## Context
## Discussion
## Action Items (siapa, apa)

Transkrip:
{{transcript}}`;
  const SNIPPET_CONTEXT = 50;
  const TAG_MAX = 30;
  const TAGS_MAX = 10;

  // Splits a search query into lowercase words.
  const searchWords = (query) => String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);

  // Tidies tags: trims and shortens them, drops blanks and case-insensitive repeats, and caps the count.
  function cleanTags(value) {
    const seen = new Set();
    const list = Array.isArray(value) ? value : String(value ?? '').split(',');
    return list
      .map((tag) => String(tag ?? '').replace(/\s+/g, ' ').trim().slice(0, TAG_MAX).trim())
      .filter((tag) => {
        if (!tag || seen.has(tag.toLowerCase())) return false;
        seen.add(tag.toLowerCase());
        return true;
      })
      .slice(0, TAGS_MAX);
  }

  // Lists every tag used across meetings once, in alphabetical order.
  function allTags(meetings) {
    const seen = new Map();
    for (const tag of meetings.flatMap((meeting) => cleanTags(meeting?.tags))) {
      if (!seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }

  // Says whether a meeting contains every word of the search query.
  function matchesSearch(meeting, query) {
    const text = [
      meeting.title,
      ...(meeting.tags ?? []),
      meeting.mom,
      ...(meeting.segments ?? []).flatMap((seg) => [seg.speaker, seg.text]),
      ...(meeting.answers ?? []).flatMap((a) => [a.question, a.answer]),
    ].join('\n').toLowerCase();
    return searchWords(query).every((word) => text.includes(word));
  }

  // Returns a short piece of the transcript around the first search hit, or '' if none.
  function searchSnippet(meeting, query) {
    for (const word of searchWords(query)) {
      const hit = (meeting.segments ?? []).find((seg) => String(seg.text ?? '').toLowerCase().includes(word));
      if (!hit) continue;
      const at = hit.text.toLowerCase().indexOf(word);
      const start = Math.max(0, at - SNIPPET_CONTEXT);
      const end = Math.min(hit.text.length, at + word.length + SNIPPET_CONTEXT);
      const before = start > 0 ? '…' : '';
      const after = end < hit.text.length ? '…' : '';
      return `${before}${hit.text.slice(start, end).trim()}${after}`;
    }
    return '';
  }

  globalThis.MeetMerge = {
    matchesSearch, searchSnippet, timeOf,
    upsertSegment, replaceAudioSegments, formatTranscript, formatWithMarks, formatMarkdown, fillTemplate,
    timeline, markLabel, addAnswer, transcriptStamp, changedSince, playPlan, dropEchoes,
    lastActivityAt, isStaleMeeting, ownerOfRecording, SESSION_GAP_MS, CRASH_GAP_MS,
    DEFAULT_MOM_TEMPLATE, momTemplateOf, canMakeMom, applyTranscriptEdit, editMeeting, dateGroup, minutesLeft,
    MOM_PRESETS, momPrompt, askPrompt, formatSubtitles, subtitleOrigin, carriedNames, isGuessedSpeaker,
    actionItems, sourceLine, speakerShares, cleanTags, allTags, failedParts, askAllPrompt, locateLine,
    expiredMeetingIds, coversLine, replaceMeetingAudio,
  };
})();
