import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

await import('../lib/merge.js');
await import('../lib/stt.js');
const { editMeeting, formatSubtitles } = globalThis.MeetMerge;
const { sttEndpoint } = globalThis.MeetStt;

const lines = () => [{ id: 'a', speaker: 'Others', text: 'halo', t: 1 }, { id: 'b', speaker: 'You', text: 'hai', t: 2 }];

test('a real speaker name still renames', () => {
  const meeting = { segments: lines() };
  editMeeting(meeting, { from: 'Others', to: 'Ani' });
  assert.equal(meeting.segments[0].speaker, 'Ani');
  assert.deepEqual(meeting.speakerNames, { Others: 'Ani' });
});

test('lines from before the recording stay out of its subtitles', () => {
  const segments = [{ speaker: 'Ani', text: 'sebelum', t: 100 }, { speaker: 'Ani', text: 'sebelum juga', t: 200 }, { speaker: 'Ani', text: 'sesudah', t: 5000 }];
  const out = formatSubtitles(segments, 'srt', 1000);
  assert.doesNotMatch(out, /sebelum/);
  assert.match(out, /^1\n00:00:04,000 --> /);
});

test('vtt text cannot be read as tags or timing', () => {
  const out = formatSubtitles([{ speaker: 'A<b>', text: 'if x<y & a --> b', t: 0 }], 'vtt', 0);
  assert.match(out, /A&lt;b>: if x&lt;y &amp; a --&gt; b/);
});

test('srt text stays as written', () => {
  const out = formatSubtitles([{ speaker: '', text: 'x<y & z', t: 0 }], 'srt', 0);
  assert.match(out, /x<y & z/);
});

test('your own Whisper server ignores a model chosen for an online service', () => {
  assert.equal(sttEndpoint({ sttMode: 'whisper-local', sttModel: 'gpt-4o-transcribe-diarize' }).model, 'whisper-1');
  assert.equal(sttEndpoint({ sttMode: 'whisper-local', sttModel: 'gpt-transcribe' }).model, 'whisper-1');
  assert.equal(sttEndpoint({ sttMode: 'whisper-local', sttModel: 'large-v3' }).model, 'large-v3');
});

test('Firefox loads every script the worker uses', () => {
  const firefox = JSON.parse(readFileSync(new URL('../manifest.firefox.json', import.meta.url), 'utf8')).background.scripts;
  const worker = readFileSync(new URL('../background/service-worker.js', import.meta.url), 'utf8');
  const imported = worker.match(/importScripts\(([^)]*)\)/)[1].match(/lib\/[a-z0-9]+\.js|content\/[a-z0-9]+\.js/g);
  for (const script of imported) assert.ok(firefox.includes(script), script);
  assert.equal(firefox[0], 'lib/i18n.js');
});

test('without a recording, subtitles start at the first line', () => {
  const meeting = { startedAt: 1000300, segments: [{ speaker: 'Ani', text: 'pertama', t: 1000000 }, { speaker: 'Ani', text: 'kedua', t: 1002000 }] };
  const out = formatSubtitles(meeting.segments, 'srt', globalThis.MeetMerge.subtitleOrigin(meeting, []));
  assert.match(out, /pertama/);
  assert.match(out, /kedua/);
});

test('with recordings, subtitles start at the earliest one', () => {
  const meeting = { startedAt: 100, segments: [{ speaker: '', text: 'x', t: 50 }] };
  assert.equal(globalThis.MeetMerge.subtitleOrigin(meeting, [900, 700]), 700);
});
