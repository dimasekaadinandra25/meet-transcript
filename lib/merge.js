(() => {
  function upsertSegment(segments, seg) {
    for (let i = segments.length - 1; i >= 0; i--) {
      if (segments[i].id === seg.id) {
        segments[i].speaker = seg.speaker;
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
  const wordsOf = (text) => String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  function oneEditApart(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return a.slice(i + 1) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i) || a.slice(i) === b.slice(i + 1);
  }
  const closeWord = (word, known) => known.has(word)
    || (word.length >= FUZZY_WORD_LENGTH && [...known].some((other) => oneEditApart(word, other)));
  function captionIndex(captions) {
    return captions.map((c) => {
      const start = c.t ?? 0;
      const words = wordsOf(c.text);
      return { from: start - DUPLICATE_WINDOW_MS, to: start + words.length * SPOKEN_WORD_MS + DUPLICATE_WINDOW_MS, known: new Set(words) };
    });
  }
  function repeatsCaption(seg, index) {
    const words = wordsOf(seg.text);
    if (!words.length) return false;
    const at = seg.t ?? 0;
    return index.some(({ from, to, known }) => at >= from && at <= to
      && words.filter((w) => closeWord(w, known)).length / words.length >= DUPLICATE_WORD_SHARE);
  }
  function replaceAudioSegments(segments, audioSegs, { baseTime = 0, replace = false, legacy = false, names = {} } = {}) {
    if (!audioSegs.length) return segments;
    const tag = `audio:${baseTime}:`;
    const UNTAGGED = /^audio:\d+$/;
    const isTagged = (s) => String(s.id ?? '').startsWith(tag);
    const inside = (at, part) => at >= part.t && at < part.failedUntil;
    const spoken = segments.filter((s) => isTagged(s) && !s.failed);
    const savedParts = audioSegs.filter((seg) => seg.failedUntil && spoken.some((s) => inside(s.t, seg)));
    const inSavedPart = (at) => savedParts.some((part) => inside(at, part));
    const drop = (s) => {
      if (isTagged(s)) return s.failed || !inSavedPart(s.t);
      return replace && legacy && UNTAGGED.test(String(s.id ?? ''));
    };
    const kept = segments.filter((s) => !drop(s));
    const captions = captionIndex(kept.filter((s) => !String(s.id ?? '').startsWith('audio:')));
    const usedIds = new Set(kept.map((s) => s.id));
    let next = 0;
    const freshId = () => {
      while (usedIds.has(`${tag}${next}`)) next++;
      return `${tag}${next++}`;
    };
    const fresh = audioSegs.filter((seg) => !inSavedPart(seg.t) && !repeatsCaption(seg, captions)).map(({ failedUntil, ...seg }) => ({
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
  function editMeeting(meeting, change) {
    meeting.segments = applyTranscriptEdit(meeting.segments, change);
    if (change.segmentId !== undefined) return;
    const to = String(change.to ?? '').trim();
    const names = Object.fromEntries(Object.entries(meeting.speakerNames ?? {}).map(([key, name]) => [key, name === change.from ? to : name]));
    meeting.speakerNames = Object.hasOwn(names, change.from) ? names : { ...names, [change.from]: to };
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
  const expiredMeetingIds = (meetings, days, now) => (Number(days) > 0
    ? meetings.filter((m) => m.endedAt && m.endedAt < now - Number(days) * DAY_MS).map((m) => m.id)
    : []);
  const locateLine = (t, baseTime, chunkMs) => ({
    index: Math.floor((t - baseTime) / chunkMs),
    offset: Math.max(0, ((t - baseTime) % chunkMs) / 1000 - PLAY_LEAD_SECONDS),
  });
  function subtitleTime(ms, separator) {
    const part = (value, size) => String(Math.floor(value)).padStart(size, '0');
    return `${part(ms / 3600000, 2)}:${part((ms % 3600000) / 60000, 2)}:${part((ms % 60000) / 1000, 2)}${separator}${part(ms % 1000, 3)}`;
  }
  function formatSubtitles(segments, kind) {
    const separator = kind === 'srt' ? ',' : '.';
    const origin = segments[0]?.t ?? 0;
    const blocks = segments.map((s, i) => {
      const from = s.t - origin;
      const spoken = Math.max(SUBTITLE_MIN_MS, wordsOf(s.text).length * SPOKEN_WORD_MS);
      const next = segments[i + 1];
      const to = next && next.t > s.t ? Math.min(next.t - origin, from + spoken) : from + spoken;
      const times = `${subtitleTime(from, separator)} --> ${subtitleTime(to, separator)}`;
      const text = s.speaker ? `${s.speaker}: ${s.text}` : s.text;
      return (kind === 'srt' ? [i + 1, times, text] : [times, text]).join('\n');
    });
    return `${kind === 'srt' ? '' : 'WEBVTT\n\n'}${blocks.join('\n\n')}\n`;
  }
  const pad = (n) => String(n).padStart(2, '0');
  function timeOf(t) {
    const d = new Date(t);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function formatTranscript(segments) {
    return segments.map((s) => s.speaker
      ? `[${timeOf(s.t)}] ${s.speaker}: ${s.text}`
      : `[${timeOf(s.t)}] ${s.text}`).join('\n');
  }
  function formatMarkdown(meeting) {
    const lines = [`# ${meeting.title}`, '', new Date(meeting.startedAt).toLocaleString(), ''];
    for (const s of meeting.segments) lines.push(s.speaker
      ? `- **${s.speaker}** (${timeOf(s.t)}): ${s.text}`
      : `- (${timeOf(s.t)}): ${s.text}`);
    if (meeting.mom) lines.push('', '---', '', '## MoM', '', meeting.mom);
    return lines.join('\n');
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
    const text = [meeting.title, meeting.mom, ...(meeting.segments ?? []).flatMap((s) => [s.speaker, s.text])]
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
    upsertSegment, replaceAudioSegments, formatTranscript, formatMarkdown, fillTemplate,
    lastActivityAt, isStaleMeeting, ownerOfRecording, SESSION_GAP_MS, CRASH_GAP_MS,
    DEFAULT_MOM_TEMPLATE, momTemplateOf, canMakeMom, applyTranscriptEdit, editMeeting, dateGroup, minutesLeft, MOM_PRESETS, momPrompt, askPrompt, formatSubtitles, locateLine, expiredMeetingIds,
  };
})();
