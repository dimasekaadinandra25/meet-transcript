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
  function replaceAudioSegments(segments, audioSegs, { baseTime = 0, replace = false, legacy = false } = {}) {
    if (!audioSegs.length) return segments;
    const tag = `audio:${baseTime}:`;
    const UNTAGGED = /^audio:\d+$/;
    const drop = (id) => {
      const s = String(id ?? '');
      return s.startsWith(tag) || (replace && legacy && UNTAGGED.test(s));
    };
    const kept = segments.filter((s) => !drop(s.id));
    const captions = captionIndex(kept.filter((s) => !String(s.id ?? '').startsWith('audio:')));
    return kept
      .concat(audioSegs.filter((seg) => !repeatsCaption(seg, captions)).map((seg, i) => ({ ...seg, id: `${tag}${i}` })))
      .sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  }
  function applyTranscriptEdit(segments, { segmentId, text, from, to }) {
    if (segmentId === undefined) {
      const name = String(to ?? '').trim();
      if (name === from) return segments;
      return segments.map((s) => (s.speaker === from ? { ...s, speaker: name, edited: true } : s));
    }
    const clean = String(text ?? '').trim();
    if (!clean) return segments.filter((s) => s.id !== segmentId);
    return segments.map((s) => (s.id === segmentId && s.text !== clean ? { ...s, text: clean, edited: true } : s));
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
  const DEFAULT_MOM_TEMPLATE = `Create Minutes of Meeting (MoM) from the meeting transcript below.

Write the whole MoM, including the section headings, in the main language spoken in the transcript. If the transcript mixes languages, use the one spoken most.

Format:
## Date:
## Related Project:
## Participants
## Context
## Discussion
## Action Items (who, what)

Transcript:
{{transcript}}`;
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
    DEFAULT_MOM_TEMPLATE, momTemplateOf, canMakeMom, applyTranscriptEdit,
  };
})();
