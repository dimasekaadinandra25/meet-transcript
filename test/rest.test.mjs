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

test('vocabulary travels with every speech-to-text mode', () => {
  for (const sttMode of ['api', 'whisper-local']) {
    assert.equal(sttEndpoint({ sttMode, sttVocabulary: ' Dimas, Transcripables ' }).vocabulary, 'Dimas, Transcripables');
    assert.equal('vocabulary' in sttEndpoint({ sttMode }), false);
  }
});

test('a very long vocabulary is cut to what a speech model can take', () => {
  assert.equal(sttEndpoint({ sttMode: 'api', sttVocabulary: 'x'.repeat(5000) }).vocabulary.length, 500);
});

test('speaker names carry over, but letters from a speech service do not', () => {
  const { carriedNames } = globalThis.MeetMerge;
  assert.deepEqual(carriedNames({ Others: 'Budi', 'Speaker A': 'Ani', 'Speaker Z3': 'Citra', Ani: 'Ani S.' }), { Others: 'Budi', Ani: 'Ani S.' });
  assert.equal(carriedNames(undefined), undefined);
  assert.equal(carriedNames({ 'Speaker A': 'Ani' }), undefined);
});

test('carried names leave out blank names and blank speakers', () => {
  const { carriedNames } = globalThis.MeetMerge;
  assert.deepEqual(carriedNames({ '': 'Budi', Ani: '', Citra: 'Citra S.' }), { Citra: 'Citra S.' });
});

const { actionItems, askAllPrompt } = globalThis.MeetMerge;
const mom = `## Date: 1 Mei
## Discussion
- Anggaran naik
## Action Items (who, what)
- **Ani**: kirim laporan
* Budi cek target
1. Citra buat slide
## Next
- bukan tugas`;

test('action items come from the MoM action section', () => {
  assert.deepEqual(actionItems({ mom }).map((item) => item.text), ['Ani: kirim laporan', 'Budi cek target', 'Citra buat slide']);
});

test('action items are found in other MoM types and languages', () => {
  assert.deepEqual(actionItems({ mom: '## Next steps\n- a' }).map((i) => i.text), ['a']);
  assert.deepEqual(actionItems({ mom: '## Promises we made (who, what, when)\n- b' }).map((i) => i.text), ['b']);
  assert.deepEqual(actionItems({ mom: '## Tindak Lanjut\n- c' }).map((i) => i.text), ['c']);
  assert.deepEqual(actionItems({ mom: '**Action Items:**\n- d' }).map((i) => i.text), ['d']);
});

test('placeholders and empty MoMs give no action items', () => {
  assert.deepEqual(actionItems({ mom: '## Action Items\n- None\n- Tidak ada\n- -' }), []);
  assert.deepEqual(actionItems({ mom: null }), []);
  assert.deepEqual(actionItems({}), []);
});

test('ticking an action item is remembered and can be undone', () => {
  const meeting = { segments: [], mom };
  editMeeting(meeting, { toggleItem: 'Budi cek target' });
  assert.deepEqual(actionItems(meeting).map((i) => i.done), [false, true, false]);
  editMeeting(meeting, { toggleItem: 'Budi cek target' });
  assert.deepEqual(actionItems(meeting).map((i) => i.done), [false, false, false]);
});

test('asking across meetings uses the MoM when there is one, newest first', () => {
  const meetings = [
    { title: 'Lama', startedAt: 1000, mom: 'ringkasan lama', segments: [{ speaker: 'Ani', text: 'tidak terkirim', t: 1 }] },
    { title: 'Baru', startedAt: 2000, mom: null, segments: [{ speaker: 'Budi', text: 'isi transkrip', t: 2 }] },
    { title: 'Kosong', startedAt: 3000, mom: null, segments: [] },
  ];
  const { prompt, used } = askAllPrompt(meetings, 'apa keputusannya?');
  assert.equal(used, 2);
  assert.match(prompt, /apa keputusannya\?/);
  assert.match(prompt, /ringkasan lama/);
  assert.doesNotMatch(prompt, /tidak terkirim/);
  assert.ok(prompt.indexOf('isi transkrip') < prompt.indexOf('ringkasan lama'));
  assert.doesNotMatch(prompt, /Kosong/);
});

test('asking across meetings stops at a size the AI can take', () => {
  const meetings = Array.from({ length: 50 }, (_, i) => ({ title: `M${i}`, startedAt: i, mom: 'x'.repeat(5000), segments: [] }));
  const { prompt, used } = askAllPrompt(meetings, 'q');
  assert.ok(used < 50);
  assert.ok(prompt.length < 70000);
  assert.match(prompt, /M49/);
  assert.doesNotMatch(prompt, /M0\b/);
});

test('backups leave out the sharing secrets and keep your own on restore', async () => {
  await import('../lib/backup.js');
  const restored = globalThis.MeetBackup.keepCurrentKeys({ settings: { baseUrl: 'https://other.example/v1' } }, { baseUrl: 'https://x/v1', slackWebhook: 'https://hooks.slack.com/services/A', notionToken: 'n' });
  assert.equal(restored.settings.slackWebhook, 'https://hooks.slack.com/services/A');
  assert.equal(restored.settings.notionToken, 'n');
});

const texts = (momText) => actionItems({ mom: momText }).map((item) => item.text);

test('people listed under the action heading keep their items', () => {
  assert.deepEqual(texts('## Action Items\n**Ani**\n- kirim laporan\n**Budi**\n- review'), ['Ani: kirim laporan', 'Budi: review']);
  assert.deepEqual(texts('## Action Items\n**Ani**: kirim laporan'), ['Ani: kirim laporan']);
  assert.deepEqual(texts('## Action Items\n- first\n**Ani**: kirim **laporan**\n- after'), ['first', 'Ani: kirim laporan', 'after']);
});

test('action items in a table are read, without the header', () => {
  assert.deepEqual(texts('## Action Items\n| Who | What |\n|---|---|\n| Ani | kirim laporan |\n| Budi | review |'), ['Ani - kirim laporan', 'Budi - review']);
});

test('other ways of writing the heading are understood', () => {
  assert.deepEqual(texts('2. **Action Items**\n- a'), ['a']);
  assert.deepEqual(texts('### Item Tindakan\n- b'), ['b']);
  assert.deepEqual(texts('## Acciones\n- c'), ['c']);
  assert.deepEqual(texts('## Próximos pasos\n- d'), ['d']);
  assert.deepEqual(texts('## 行动项\n- e'), ['e']);
});

test('headings that only contain similar letters are not action items', () => {
  for (const heading of ['Transaction review', 'Customer satisfaction', 'Compromises', 'Discussion: action on budget']) {
    assert.deepEqual(texts(`## ${heading}\n- x`), [], heading);
  }
});

test('a real heading after the section ends it', () => {
  assert.deepEqual(texts('## Action Items\n- a\n**Notes:**\n- b'), ['a']);
  assert.deepEqual(texts('## Action Items\n- a\nNotes:\n- b'), ['a']);
  assert.deepEqual(texts('## Action Items\nBerikut tugasnya:\n- a'), ['a']);
});

test('details under an item and "nothing to do" lines are not items', () => {
  assert.deepEqual(texts('## Action Items\n- a\n  - Deadline: Jumat'), ['a']);
  assert.deepEqual(texts('## Action Items\n- None identified.\n- No action items.\n- Tidak ada tindak lanjut.'), []);
});

test('one very long meeting does not hide the others', () => {
  const huge = 'x'.repeat(80000);
  const newestHuge = askAllPrompt([{ title: 'Besar', startedAt: 2, mom: huge, segments: [] }, { title: 'Kecil', startedAt: 1, mom: 'pendek', segments: [] }], 'q');
  assert.equal(newestHuge.used, 1);
  assert.ok(newestHuge.left > 0);
  assert.ok(newestHuge.prompt.length < 70000);
  const middleHuge = askAllPrompt([{ title: 'Baru', startedAt: 3, mom: 'pendek baru', segments: [] }, { title: 'Besar', startedAt: 2, mom: huge, segments: [] }, { title: 'Lama', startedAt: 1, mom: 'pendek lama', segments: [] }], 'q');
  assert.match(middleHuge.prompt, /pendek baru/);
  assert.equal(middleHuge.left, 2);
});

test('empty meetings do not count as left out', () => {
  const { used, left } = askAllPrompt([{ title: 'A', startedAt: 1, mom: 'isi', segments: [] }, { title: 'B', startedAt: 2, mom: null, segments: [] }], 'q');
  assert.equal(used, 1);
  assert.equal(left, 0);
});

test('a backup cannot silently replace your Slack webhook', async () => {
  await import('../lib/backup.js');
  const backup = { settings: { slackWebhook: 'https://hooks.slack.com/services/ATTACKER' } };
  assert.equal(globalThis.MeetBackup.keepCurrentKeys(backup, { slackWebhook: 'https://hooks.slack.com/services/MINE' }).settings.slackWebhook, 'https://hooks.slack.com/services/MINE');
  assert.equal(globalThis.MeetBackup.keepCurrentKeys(backup, {}).settings.slackWebhook, 'https://hooks.slack.com/services/ATTACKER');
});

test('a backup cannot silently replace where Notion sends your MoM', async () => {
  await import('../lib/backup.js');
  const backup = { settings: { notionToken: 'ntn_ATTACKER', notionPage: 'https://www.notion.so/attacker-page' } };
  const kept = globalThis.MeetBackup.keepCurrentKeys(backup, { notionToken: 'ntn_MINE', notionPage: 'https://www.notion.so/my-page' }).settings;
  assert.equal(kept.notionToken, 'ntn_MINE');
  assert.equal(kept.notionPage, 'https://www.notion.so/my-page');
  const tokenOnly = globalThis.MeetBackup.keepCurrentKeys(backup, { notionToken: 'ntn_MINE' }).settings;
  assert.equal(tokenOnly.notionToken, 'ntn_MINE');
  assert.ok(!tokenOnly.notionPage, 'the backup page was paired with your token');
  const fresh = globalThis.MeetBackup.keepCurrentKeys(backup, {}).settings;
  assert.equal(fresh.notionToken, 'ntn_ATTACKER');
  assert.equal(fresh.notionPage, 'https://www.notion.so/attacker-page');
});

test('asking across meetings sends the meetings about the question first', () => {
  const meetings = [
    { title: 'Anggaran Q3', startedAt: 1, mom: 'Keputusan anggaran pemasaran naik', segments: [] },
    ...Array.from({ length: 30 }, (_, i) => ({ title: `Lain ${i}`, startedAt: 100 + i, mom: 'y'.repeat(5000), segments: [] })),
  ];
  const { prompt } = askAllPrompt(meetings, 'Berapa anggaran pemasaran?');
  assert.match(prompt, /Anggaran Q3/);
  assert.ok(prompt.indexOf('Anggaran Q3') < prompt.indexOf('Lain 29'));
});
