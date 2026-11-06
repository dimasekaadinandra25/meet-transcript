(() => {
  const withoutCorrection = ({ captionText, correctedFrom, ...line }) => line;
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
  const SPEECH_LETTER = /^Speaker [A-Z]\d*$/;
  const CORRECT_MIN_WORDS = 4;
  const CORRECT_WORD_SHARE = 0.7;
  const CORRECT_WINDOW_MS = 8000;
  const BLOCK_MIN_WORDS = 20;
  const wordsOf = (text) => String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  function oneEditApart(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return a.slice(i + 1) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i) || a.slice(i) === b.slice(i + 1);
  }
  const closeWord = (word, known) => known.has(word)
    || (word.length >= FUZZY_WORD_LENGTH && [...known].some((other) => oneEditApart(word, other)));
  function captionIndex(captions, windowMs = DUPLICATE_WINDOW_MS) {
    return captions.map((c) => {
      const start = c.t ?? 0;
      const words = wordsOf(c.text);
      return { from: start - windowMs, to: start + words.length * SPOKEN_WORD_MS + windowMs, known: new Set(words) };
    });
  }
  function repeatsCaption(seg, index) {
    const words = wordsOf(seg.text);
    if (!words.length) return false;
    const at = seg.t ?? 0;
    return index.some(({ from, to, known }) => at >= from && at <= to
      && words.filter((w) => closeWord(w, known)).length / words.length >= DUPLICATE_WORD_SHARE);
  }
  const sameWord = (a, b) => a === b || (a.length >= FUZZY_WORD_LENGTH && oneEditApart(a, b));
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
  function matchAudioToCaptions(captions, audioSegs) {
    const targets = captions.filter((c) => !c.edited && !c.captionText).map((caption) => {
      const words = wordsOf(caption.text);
      const start = caption.t ?? 0;
      return { caption, words, from: start - CORRECT_WINDOW_MS, to: start + words.length * SPOKEN_WORD_MS + CORRECT_WINDOW_MS, lines: [] };
    }).filter((target) => target.words.length >= CORRECT_MIN_WORDS);
    for (const seg of audioSegs) {
      const words = wordsOf(seg.text);
      if (seg.failedUntil || words.length < CORRECT_MIN_WORDS) continue;
      const at = seg.t ?? 0;
      let best = null;
      let bestShared = 0;
      for (const target of targets) {
        if (at < target.from || at > target.to) continue;
        const shared = wordsInOrder(words, target.words);
        const nearer = best && shared === bestShared && Math.abs(at - target.caption.t) < Math.abs(at - best.caption.t);
        if (shared > bestShared || nearer) {
          best = target;
          bestShared = shared;
        }
      }
      if (best && bestShared / words.length >= CORRECT_WORD_SHARE) best.lines.push({ seg, words });
    }
    return targets;
  }
  const anyWordShared = (mine, theirs) => mine.some((a) => theirs.some((b) => sameWord(a, b)));
  const sameEnds = (words, spoken) => anyWordShared(words.slice(0, 2), spoken.slice(0, 3)) && anyWordShared(words.slice(-2), spoken.slice(-3));
  function correctCaptions(segments, audioSegs, baseTime) {
    const isCaption = (s) => !String(s.id ?? '').startsWith('audio:');
    const ordered = [...audioSegs].sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
    const corrections = new Map();
    const used = new Set();
    for (const { caption, words, lines } of matchAudioToCaptions(segments.filter(isCaption), ordered)) {
      const spoken = lines.flatMap((line) => line.words);
      const shared = spoken.length ? wordsInOrder(spoken, words) : 0;
      if (!shared || shared / words.length < CORRECT_WORD_SHARE || shared / spoken.length < CORRECT_WORD_SHARE) continue;
      if (spoken.join(' ') === words.join(' ') || !sameEnds(words, spoken)) continue;
      corrections.set(caption.id, lines.map(({ seg }) => seg.text.trim()).join(' '));
      for (const { seg } of lines) used.add(seg);
    }
    const lines = segments.map((s) => (corrections.has(s.id) ? { ...s, text: corrections.get(s.id), captionText: s.text, correctedFrom: baseTime } : s));
    return { lines, used };
  }
  function repeatsCaptionRun(seg, captions) {
    const words = wordsOf(seg.text);
    if (words.length < BLOCK_MIN_WORDS) return false;
    const at = seg.t ?? 0;
    const from = at - DUPLICATE_WINDOW_MS;
    const to = at + words.length * SPOKEN_WORD_MS + DUPLICATE_WINDOW_MS;
    const heard = captions.filter((c) => (c.t ?? 0) >= from && (c.t ?? 0) <= to).flatMap((c) => wordsOf(c.text));
    return wordsInOrder(words, heard) / words.length >= DUPLICATE_WORD_SHARE;
  }
  function dropEchoes(mine, others) {
    const index = captionIndex(others, ECHO_WINDOW_MS);
    return mine.filter((s) => wordsOf(s.text).length < ECHO_MIN_WORDS || !repeatsCaption(s, index));
  }
  function replaceAudioSegments(segments, audioSegs, { baseTime = 0, replace = false, legacy = false, names = {} } = {}) {
    if (!audioSegs.length) return segments;
    const tag = `audio:${baseTime}:`;
    const UNTAGGED = /^audio:\d+$/;
    const isTagged = (s) => String(s.id ?? '').startsWith(tag);
    const inside = (at, part) => at >= part.t && at < part.failedUntil;
    const spoken = segments.filter((s) => (isTagged(s) && !s.failed) || s.correctedFrom === baseTime);
    const savedParts = audioSegs.filter((seg) => seg.failedUntil && spoken.some((s) => inside(s.t, seg)));
    const inSavedPart = (at) => savedParts.some((part) => inside(at, part));
    const drop = (s) => {
      if (isTagged(s)) return s.failed || !inSavedPart(s.t);
      return replace && legacy && UNTAGGED.test(String(s.id ?? ''));
    };
    const restored = segments.filter((s) => !drop(s)).map((s) => (s.correctedFrom === baseTime && !s.edited && !inSavedPart(s.t) ? { ...withoutCorrection(s), text: s.captionText } : s));
    const heard = audioSegs.filter((seg) => !inSavedPart(seg.t));
    const { lines: kept, used } = correctCaptions(restored, heard, baseTime);
    const captionLines = kept.filter((s) => !String(s.id ?? '').startsWith('audio:')).map((s) => ({ t: s.t, text: `${s.text} ${s.captionText ?? ''}` }));
    const captions = captionIndex(captionLines);
    const usedIds = new Set(kept.map((s) => s.id));
    let next = 0;
    const freshId = () => {
      while (usedIds.has(`${tag}${next}`)) next++;
      return `${tag}${next++}`;
    };
    const fresh = heard.filter((seg) => !used.has(seg) && !repeatsCaption(seg, captions) && !repeatsCaptionRun(seg, captionLines)).map(({ failedUntil, ...seg }) => ({
      ...seg,
      ...(Object.hasOwn(names, seg.speaker) ? { speaker: names[seg.speaker] } : {}),
      ...(failedUntil ? { failed: true } : {}),
      id: freshId(),
    }));
    return kept.concat(fresh).sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  }
  function applyTranscriptEdit(segments, { segmentId, text, from, to }) {
    if (segmentId === undefined) {
      const name = String(to ?? '').trim();
      if (name === from) return segments;
      return segments.map((s) => (s.speaker === from ? { ...s, speaker: name } : s));
    }
    const clean = String(text ?? '').trim();
    if (!clean) return segments.filter((s) => s.id !== segmentId);
    return segments.map((s) => (s.id === segmentId && s.text !== clean ? { ...s, text: clean, edited: true } : s));
  }
  function replaceMeetingAudio(meeting, audioSegs, { baseTime, replace, legacy } = {}) {
    meeting.segments = replaceAudioSegments(meeting.segments, audioSegs, { baseTime, replace, legacy, names: meeting.speakerNames });
    if (replace && meeting.deletedFrom) meeting.deletedFrom = meeting.deletedFrom.filter((base) => base !== baseTime);
  }
  function carriedNames(names) {
    const kept = Object.entries(names ?? {}).filter(([from, to]) => from && to && !SPEECH_LETTER.test(from));
    return kept.length ? Object.fromEntries(kept) : undefined;
  }
  function rememberDeletedLine(meeting, { segmentId, text }) {
    if (segmentId === undefined || String(text ?? '').trim()) return;
    const base = String(segmentId).match(/^audio:(\d+):/)?.[1];
    if (base && meeting.segments.some((s) => s.id === segmentId)) {
      meeting.deletedFrom = [...new Set([...(meeting.deletedFrom ?? []), Number(base)])];
    }
  }
  function editMeeting(meeting, change) {
    if (change.toggleItem !== undefined) {
      const done = meeting.doneItems ?? [];
      meeting.doneItems = done.includes(change.toggleItem) ? done.filter((item) => item !== change.toggleItem) : [...done, change.toggleItem];
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
    const names = Object.fromEntries(Object.entries(meeting.speakerNames ?? {}).map(([key, name]) => [key, name === change.from ? to : name]));
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
  const plainItem = (text) => text.replace(/\*\*/g, '').trim();
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
      if (heading !== undefined || (bold && (!inside || /:\s*(?:\*\*)?\s*$/.test(line)))) {
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
          addItem(line.match(TABLE_LINE)[1].split('|').map((cell) => plainItem(cell)).filter(Boolean).join(' - '));
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
  function askAllPrompt(meetings, question) {
    const blocks = [];
    let size = 0;
    let left = 0;
    const newestFirst = [...meetings].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    for (const meeting of newestFirst) {
      const body = meeting.mom || formatTranscript(meeting.segments ?? []);
      if (!body) continue;
      const block = `## ${meeting.title} (${new Date(meeting.startedAt).toLocaleDateString()})\n${body}`;
      const room = ASK_ALL_MAX_CHARS - size;
      if (block.length > room) left++;
      if (block.length > room && room < ASK_ALL_MIN_PART) continue;
      const fitted = block.slice(0, room);
      blocks.push(fitted);
      size += fitted.length;
    }
    const prompt = `Answer the question using only the meetings below, newest first. Name the meeting each fact comes from. If they do not say, answer that they do not say. Reply in the language of the question.

Question: ${question}

Meetings:
${blocks.join('\n\n')}`;
    return { prompt, used: blocks.length, left };
  }
  function dateGroup(t, now) {
    const dayStart = (ms) => new Date(ms).setHours(0, 0, 0, 0);
    const days = Math.round((dayStart(now) - dayStart(t)) / 86400000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return days < 7 ? 'This week' : 'Earlier';
  }
  function minutesLeft(done, total, elapsedMs) {
    if (!done || done >= total) return null;
    return Math.max(1, Math.round((elapsedMs / done) * (total - done) / 60000));
  }
  function expiredMeetingIds(meetings, days, now) {
    if (!(Number(days) > 0)) return [];
    const cutoff = now - Number(days) * DAY_MS;
    return meetings.filter((m) => {
      const lastUse = Math.max(lastActivityAt(m), m.keepFrom ?? 0);
      return lastUse > 0 && lastUse < cutoff;
    }).map((m) => m.id);
  }
  const coversLine = (rec, t) => t >= rec.baseTime
    && t < rec.baseTime + rec.chunkMs * Math.max(rec.count ?? 0, rec.systemCount ?? 0, rec.micCount ?? 0);
  const locateLine = (t, baseTime, chunkMs) => ({
    index: Math.floor((t - baseTime) / chunkMs),
    offset: Math.max(0, ((t - baseTime) % chunkMs) / 1000 - PLAY_LEAD_SECONDS),
  });
  const inMillis = (seconds) => Math.round(seconds * 1000) / 1000;
  function playPlan(t, baseTime, chunkMs, seconds) {
    const { index, offset } = locateLine(t, baseTime, chunkMs);
    const start = inMillis(offset);
    const room = inMillis(chunkMs / 1000 - offset);
    if (seconds <= room) return [{ index, offset: start, wait: 0, seconds }];
    return [{ index, offset: start, wait: 0, seconds: room }, { index: index + 1, offset: 0, wait: room, seconds: inMillis(seconds - room) }];
  }
  function subtitleTime(ms, separator) {
    const part = (value, size) => String(Math.floor(value)).padStart(size, '0');
    return `${part(ms / 3600000, 2)}:${part((ms % 3600000) / 60000, 2)}:${part((ms % 60000) / 1000, 2)}${separator}${part(ms % 1000, 3)}`;
  }
  const subtitleOrigin = (meeting, baseTimes) => (baseTimes.length
    ? Math.min(...baseTimes)
    : meeting.segments.reduce((first, s) => Math.min(first, s.t), meeting.startedAt));
  function formatSubtitles(segments, kind, origin = segments[0]?.t ?? 0) {
    const separator = kind === 'srt' ? ',' : '.';
    const clean = (text) => (kind === 'vtt' ? text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/-->/g, '--&gt;') : text);
    const shown = segments.filter((s) => s.t >= origin);
    const blocks = shown.map((s, i) => {
      const from = Math.max(0, s.t - origin);
      const spoken = Math.max(SUBTITLE_MIN_MS, wordsOf(s.text).length * SPOKEN_WORD_MS);
      const next = shown[i + 1];
      const until = next && next.t > s.t ? Math.min(next.t - origin, from + spoken) : from + spoken;
      const to = Math.max(from + 1, until);
      const times = `${subtitleTime(from, separator)} --> ${subtitleTime(to, separator)}`;
      const line = clean(s.text.replace(/\s*\n\s*/g, ' '));
      const text = s.speaker ? `${clean(s.speaker)}: ${line}` : line;
      return (kind === 'srt' ? [i + 1, times, text] : [times, text]).join('\n');
    });
    return `${kind === 'srt' ? '' : 'WEBVTT\n\n'}${blocks.join('\n\n')}\n`;
  }
  const pad = (n) => String(n).padStart(2, '0');
  function timeOf(t) {
    const d = new Date(t);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  const transcriptLine = (s) => (s.speaker
    ? `[${timeOf(s.t)}] ${s.speaker}: ${s.text}`
    : `[${timeOf(s.t)}] ${s.text}`);
  const formatTranscript = (segments) => segments.map(transcriptLine).join('\n');
  const markLabel = () => `★ ${(globalThis.MeetI18n?.t ?? String)('Marked')}`;
  const timeline = (meeting) => [...meeting.segments, ...(meeting.marks ?? []).map((t) => ({ t, mark: true }))]
    .sort((a, b) => a.t - b.t);
  const formatWithMarks = (meeting) => timeline(meeting)
    .map((item) => (item.mark ? `[${timeOf(item.t)}] ${markLabel()}` : transcriptLine(item))).join('\n');
  function markdownLine(item) {
    if (item.mark) return `- **${markLabel()}** (${timeOf(item.t)})`;
    return item.speaker
      ? `- **${item.speaker}** (${timeOf(item.t)}): ${item.text}`
      : `- (${timeOf(item.t)}): ${item.text}`;
  }
  function formatMarkdown(meeting) {
    const lines = [`# ${meeting.title}`, '', new Date(meeting.startedAt).toLocaleString(), '', ...timeline(meeting).map(markdownLine)];
    if (meeting.mom) lines.push('', '---', '', '## MoM', '', meeting.mom);
    return lines.join('\n');
  }
  function transcriptStamp(meeting) {
    let stamp = 0;
    for (const char of meeting.segments.map((s) => `${s.speaker}\n${s.text}`).join('\n')) stamp = (stamp * 31 + char.codePointAt(0)) | 0;
    return stamp;
  }
  const changedSince = (meeting, stamp) => stamp !== undefined && transcriptStamp(meeting) !== stamp;
  function addAnswer(meeting, question, answer, basedOn) {
    meeting.answers = [{ question, answer, basedOn }, ...(meeting.answers ?? [])];
  }
  function momPrompt(meeting, settings) {
    const prompt = fillTemplate(momTemplateOf(settings.momTemplate), formatTranscript(meeting.segments));
    if (!meeting.marks?.length) return prompt;
    return `${prompt}\n\nImportant moments marked during the meeting, give them priority: ${meeting.marks.map(timeOf).join(', ')}`;
  }
  const askPrompt = (meeting, question) => `Answer the question using only the meeting transcript below. If the transcript does not say, answer that it does not say. Reply in the language of the question.

Question: ${question}

Transcript:
${formatTranscript(meeting.segments)}`;
  function lastActivityAt(meeting) {
    if (meeting.endedAt) return meeting.endedAt;
    let last = meeting.startedAt ?? 0;
    for (const s of meeting.segments ?? []) if ((s.t ?? 0) > last) last = s.t;
    return last;
  }
  const SESSION_GAP_MS = 30 * 60 * 1000;
  const CRASH_GAP_MS = 6 * 60 * 60 * 1000;
  function isStaleMeeting(meeting, now) {
    const gap = meeting.endedAt ? SESSION_GAP_MS : CRASH_GAP_MS;
    return now - lastActivityAt(meeting) > gap;
  }
  function ownerOfRecording(records, baseTime) {
    let best = null;
    for (const r of records) {
      if (r && r.startedAt <= baseTime && (!best || r.startedAt > best.startedAt)) best = r;
    }
    return best;
  }
  const OPENAI_HOST = 'api.openai.com';
  const momTemplate = (kind, sections) => `Create ${kind} from the meeting transcript below.

Write the whole MoM, including the section headings, in the main language spoken in the transcript. If the transcript mixes languages, use the one spoken most.

Format:
${sections.map((section) => `## ${section}`).join('\n')}

Transcript:
{{transcript}}`;
  const DEFAULT_MOM_TEMPLATE = momTemplate('Minutes of Meeting (MoM)', ['Date:', 'Related Project:', 'Participants', 'Context', 'Discussion', 'Action Items (who, what)']);
  const MOM_PRESETS = [
    { name: 'Standard', template: DEFAULT_MOM_TEMPLATE },
    { name: 'Standup', template: momTemplate('standup notes (MoM)', ['Done since last time', 'Plans until next time', 'Blockers (who, what)']) },
    { name: 'Client call', template: momTemplate('client call notes (MoM)', ['Date:', 'Client and attendees', 'Client needs', 'Decisions', 'Promises we made (who, what, when)', 'Next steps']) },
    { name: '1-on-1', template: momTemplate('1-on-1 notes (MoM)', ['Date:', 'Topics', 'Feedback', 'Decisions', 'Action Items (who, what)']) },
  ];
  const momTemplateOf = (saved) => (!saved || saved === OLD_MOM_TEMPLATE ? DEFAULT_MOM_TEMPLATE : saved);
  const canMakeMom = ({ apiKey, baseUrl }) => !!apiKey || (!!baseUrl && !baseUrl.includes(OPENAI_HOST));
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
  const searchWords = (query) => String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  function matchesSearch(meeting, query) {
    const text = [meeting.title, meeting.mom, ...(meeting.segments ?? []).flatMap((s) => [s.speaker, s.text]), ...(meeting.answers ?? []).flatMap((a) => [a.question, a.answer])]
      .join('\n').toLowerCase();
    return searchWords(query).every((word) => text.includes(word));
  }
  function searchSnippet(meeting, query) {
    for (const word of searchWords(query)) {
      const hit = (meeting.segments ?? []).find((s) => String(s.text ?? '').toLowerCase().includes(word));
      if (!hit) continue;
      const at = hit.text.toLowerCase().indexOf(word);
      const start = Math.max(0, at - SNIPPET_CONTEXT);
      const end = Math.min(hit.text.length, at + word.length + SNIPPET_CONTEXT);
      return `${start > 0 ? '…' : ''}${hit.text.slice(start, end).trim()}${end < hit.text.length ? '…' : ''}`;
    }
    return '';
  }
  globalThis.MeetMerge = {
    matchesSearch, searchSnippet, timeOf,
    upsertSegment, replaceAudioSegments, formatTranscript, formatWithMarks, formatMarkdown, fillTemplate, timeline, markLabel, addAnswer, transcriptStamp, changedSince, playPlan, dropEchoes,
    lastActivityAt, isStaleMeeting, ownerOfRecording, SESSION_GAP_MS, CRASH_GAP_MS,
    DEFAULT_MOM_TEMPLATE, momTemplateOf, canMakeMom, applyTranscriptEdit, editMeeting, dateGroup, minutesLeft, MOM_PRESETS, momPrompt, askPrompt, formatSubtitles, subtitleOrigin, carriedNames, actionItems, askAllPrompt, locateLine, expiredMeetingIds, coversLine, replaceMeetingAudio,
  };
})();
