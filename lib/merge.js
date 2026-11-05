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
  const DUPLICATE_WORD_SHARE = 0.6;
  const wordsOf = (text) => String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  function repeatsCaption(seg, captions) {
    const words = wordsOf(seg.text);
    const nearby = new Set(captions
      .filter((c) => Math.abs((c.t ?? 0) - (seg.t ?? 0)) <= DUPLICATE_WINDOW_MS)
      .flatMap((c) => wordsOf(c.text)));
    return words.length > 0 && words.filter((w) => nearby.has(w)).length / words.length >= DUPLICATE_WORD_SHARE;
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
    const captions = kept.filter((s) => !String(s.id ?? '').startsWith('audio:'));
    return kept
      .concat(audioSegs.filter((seg) => !repeatsCaption(seg, captions)).map((seg, i) => ({ ...seg, id: `${tag}${i}` })))
      .sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
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
  function fillTemplate(template, transcript) {
    return template.split('{{transcript}}').join(transcript);
  }
  const DEFAULT_MOM_TEMPLATE = `Buat Minutes of Meeting (MoM) dari transkrip meeting berikut.

Format:
## Date:
## Related Project:
## Participants
## Context
## Discussion
## Action Items (siapa, apa)

Transkrip:
{{transcript}}`;
  globalThis.MeetMerge = {
    upsertSegment, replaceAudioSegments, formatTranscript, formatMarkdown, fillTemplate,
    lastActivityAt, isStaleMeeting, ownerOfRecording, SESSION_GAP_MS, CRASH_GAP_MS,
    DEFAULT_MOM_TEMPLATE,
  };
})();
