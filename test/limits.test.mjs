import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../lib/merge.js');
await import('../lib/audiostore.js');
await import('../lib/backup.js');
await import('../lib/openai.js');
await import('../content/selectors.js');
const M = globalThis.MeetMerge;
const { keepCount, pruneTargets } = globalThis.MeetAudioStore;
const { exportBackup, importBackup, readZip } = globalThis.MeetBackup;
const { LANG_PATTERN } = globalThis.MeetSelectors;

const lines = (...texts) => texts.map((text, i) => ({ id: `s${i}`, speaker: 'Ani', text, t: 1000 + i * 1000 }));

test('the transcript stamp changes with the words, not with marks', () => {
  const meeting = { segments: lines('halo semua') };
  const stamp = M.transcriptStamp(meeting);
  assert.equal(M.transcriptStamp({ ...meeting, marks: [5] }), stamp);
  assert.notEqual(M.transcriptStamp({ segments: lines('halo semuanya') }), stamp);
});

test('the stamp ignores clock formatting, so a timezone change is not a transcript change', () => {
  const at = (t) => ({ segments: [{ id: 's0', speaker: 'Ani', text: 'halo', t }] });
  assert.equal(M.transcriptStamp(at(1000)), M.transcriptStamp(at(3601000)));
});

test('the stamp notices a renamed speaker', () => {
  const named = (speaker) => ({ segments: [{ id: 's0', speaker, text: 'halo', t: 1000 }] });
  assert.notEqual(M.transcriptStamp(named('Ani')), M.transcriptStamp(named('Budi')));
});

test('an answer or MoM is outdated only after the transcript changes', () => {
  const meeting = { segments: lines('halo') };
  const stamp = M.transcriptStamp(meeting);
  assert.equal(M.changedSince(meeting, stamp), false);
  assert.equal(M.changedSince({ segments: lines('lain') }, stamp), true);
  assert.equal(M.changedSince(meeting, undefined), false);
});

test('an answer remembers the transcript it was based on', () => {
  const meeting = { segments: lines('halo') };
  M.addAnswer(meeting, 'Apa?', 'Halo', 123);
  assert.deepEqual(meeting.answers, [{ question: 'Apa?', answer: 'Halo', basedOn: 123 }]);
});

test('one answer can be deleted, and the rest of the meeting stays', () => {
  const meeting = { segments: lines('halo'), answers: [{ question: 'Dua?', answer: 'b' }, { question: 'Satu?', answer: 'a' }] };
  M.editMeeting(meeting, { deleteAnswer: { question: 'Dua?', answer: 'b' } });
  assert.deepEqual(meeting.answers, [{ question: 'Satu?', answer: 'a' }]);
  assert.equal(meeting.segments.length, 1);
  assert.equal(meeting.speakerNames, undefined);
});

test('deleting removes the answer you saw, even after a newer one arrived', () => {
  const meeting = { segments: [], answers: [{ question: 'Baru?', answer: 'c' }, { question: 'Dua?', answer: 'b' }, { question: 'Satu?', answer: 'a' }] };
  M.editMeeting(meeting, { deleteAnswer: { question: 'Satu?', answer: 'a' } });
  assert.deepEqual(meeting.answers.map((a) => a.question), ['Baru?', 'Dua?']);
});

test('deleting one of two identical answers removes only one', () => {
  const same = { question: 'Sama?', answer: 'x' };
  const meeting = { segments: [], answers: [{ ...same }, { ...same }] };
  M.editMeeting(meeting, { deleteAnswer: same });
  assert.equal(meeting.answers.length, 1);
});

test('search finds words in saved questions and answers', () => {
  const meeting = { title: 'x', segments: lines('halo'), answers: [{ question: 'Siapa pemimpin?', answer: 'Budi memimpin' }] };
  assert.ok(M.matchesSearch(meeting, 'pemimpin'));
  assert.ok(M.matchesSearch(meeting, 'memimpin'));
  assert.ok(!M.matchesSearch(meeting, 'kangaroo'));
});

test('a line inside one part plays from that part alone', () => {
  assert.deepEqual(M.playPlan(10000, 0, 120000, 5), [{ index: 0, offset: 9.7, wait: 0, seconds: 5 }]);
});

test('a line at the end of a part continues into the next part', () => {
  assert.deepEqual(M.playPlan(118000, 0, 120000, 5), [
    { index: 0, offset: 117.7, wait: 0, seconds: 2.3 },
    { index: 1, offset: 0, wait: 2.3, seconds: 2.7 },
  ]);
});

const heard = (speaker, text, t) => ({ speaker, text, t });

test('words the microphone picked up from the speakers are removed', () => {
  const others = [heard('Others', 'kita mulai rapat anggaran hari ini', 10000)];
  assert.deepEqual(M.dropEchoes([heard('You', 'kita mulai rapat anggaran hari ini', 10500)], others), []);
});

test('your own different words stay', () => {
  const others = [heard('Others', 'kita mulai rapat anggaran hari ini', 10000)];
  const mine = [heard('You', 'saya setuju dengan rencana itu', 11000)];
  assert.deepEqual(M.dropEchoes(mine, others), mine);
});

test('the same words long after are not an echo', () => {
  const others = [heard('Others', 'kita mulai rapat anggaran hari ini', 10000)];
  const mine = [heard('You', 'kita mulai rapat anggaran hari ini', 60000)];
  assert.deepEqual(M.dropEchoes(mine, others), mine);
});

test('short replies are kept, because both people can really say them', () => {
  const others = [heard('Others', 'iya oke', 10000)];
  const mine = [heard('You', 'iya oke', 10500)];
  assert.deepEqual(M.dropEchoes(mine, others), mine);
});

test('the number of recordings to keep is a sane whole number', () => {
  assert.equal(keepCount(undefined), 5);
  assert.equal(keepCount('12'), 12);
  assert.equal(keepCount(0), 5);
  assert.equal(keepCount('banyak'), 5);
  assert.equal(keepCount(2.7), 2);
  assert.equal(keepCount(100000), 100);
});

test('a file imported just now outlives recordings made after the file was', () => {
  const recs = [
    { recId: 9000, keys: ['meta:9000'] },
    { recId: 8000, keys: ['meta:8000'] },
    { recId: 1000, addedAt: 10000, imported: true, keys: ['meta:1000'] },
  ];
  assert.deepEqual(pruneTargets(recs, 1), ['meta:9000', 'meta:8000']);
});

test('the keep number decides what is pruned', () => {
  const recs = [3, 2, 1].map((recId) => ({ recId, keys: [`meta:${recId}`] }));
  assert.deepEqual(pruneTargets(recs, keepCount(1)), ['meta:2', 'meta:1']);
});

function fakeChrome(stored) {
  let data = stored;
  globalThis.chrome = { storage: { local: {
    get: async () => structuredClone(data),
    set: async (next) => { data = { ...data, ...structuredClone(next) }; },
    clear: async () => { data = {}; },
  } } };
  globalThis.MeetAudioStore.importAudio = async () => {};
  return () => data;
}

const backupOf = async (zip) => JSON.parse(await (await readZip(zip))[0].blob.text());

test('a backup leaves API keys out unless asked', async () => {
  fakeChrome({ settings: { apiKey: 'rahasia', sttApiKey: 'rahasia2', model: 'm' } });
  const plain = await backupOf(await exportBackup());
  assert.deepEqual(plain.storage.settings, { model: 'm' });
  const full = await backupOf(await exportBackup({ includeKeys: true, password: 'pw' }));
  assert.deepEqual(full.storage.settings, { model: 'm' });
  assert.ok(full.lockedKeys.data);
});

test('restoring a backup without keys keeps the keys you have now', async () => {
  fakeChrome({ settings: { apiKey: 'lama', sttApiKey: 'lama2', model: 'm' } });
  const zip = await exportBackup();
  const stored = fakeChrome({ settings: { apiKey: 'sekarang', sttApiKey: 'sekarang2', model: 'lain' } });
  await importBackup(zip);
  assert.deepEqual(stored().settings, { model: 'm', apiKey: 'sekarang', sttApiKey: 'sekarang2' });
});

test('a backup pointing at another server does not receive your keys', async () => {
  fakeChrome({ settings: { baseUrl: 'https://evil.example/v1', sttBaseUrl: 'https://evil.example/stt' } });
  const zip = await exportBackup();
  const stored = fakeChrome({ settings: { baseUrl: 'https://api.openai.com/v1', apiKey: 'rahasia', sttBaseUrl: 'https://stt.example/v1', sttApiKey: 'rahasia2' } });
  await importBackup(zip);
  assert.equal(stored().settings.baseUrl, 'https://evil.example/v1');
  assert.equal(stored().settings.apiKey, undefined);
  assert.equal(stored().settings.sttApiKey, undefined);
});

test('each key follows its own server when a backup is restored', async () => {
  fakeChrome({ settings: { baseUrl: 'https://api.openai.com/v1', sttBaseUrl: 'https://lain.example/v1' } });
  const zip = await exportBackup();
  const stored = fakeChrome({ settings: { baseUrl: 'https://api.openai.com/v1', apiKey: 'rahasia', sttBaseUrl: 'https://stt.example/v1', sttApiKey: 'rahasia2' } });
  await importBackup(zip);
  assert.equal(stored().settings.apiKey, 'rahasia');
  assert.equal(stored().settings.sttApiKey, undefined);
});

test('restoring a backup with keys uses the keys in the backup', async () => {
  fakeChrome({ settings: { apiKey: 'lama', model: 'm' } });
  const zip = await exportBackup({ includeKeys: true, password: 'pw' });
  const stored = fakeChrome({ settings: { apiKey: 'sekarang' } });
  await importBackup(zip, { password: 'pw' });
  assert.equal(stored().settings.apiKey, 'lama');
});

test('caption languages match how Meet may name them', () => {
  for (const [code, names] of Object.entries({
    id: ['Indonesian', 'Bahasa Indonesia'], en: ['English (United States)', 'Inggris'], es: ['Spanish (Spain)', 'Spanyol', 'Español'],
    ja: ['Japanese', 'Jepang', '日本語'], ms: ['Malay', 'Melayu'], zh: ['Chinese (Mandarin)', 'Mandarin', '中文'],
  })) for (const name of names) assert.ok(LANG_PATTERN[code].test(name), `${code}: ${name}`);
  assert.ok(!LANG_PATTERN.ja.test('Indonesian'));
  assert.ok(!LANG_PATTERN.ms.test('Malayalam'));
  assert.ok(LANG_PATTERN.ms.test('Malay (Malaysia)'));
  assert.equal(LANG_PATTERN.keep, undefined);
});

function capturedChat() {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, ...init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  };
  return calls;
}

test('calls to Claude carry what its API needs from an extension', async () => {
  const calls = capturedChat();
  await globalThis.MeetOpenAI.generateMoM({ apiKey: 'k', model: 'm', baseUrl: 'https://api.anthropic.com/v1', prompt: 'x' });
  assert.equal(calls[0].headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.ok(calls[0].body.max_tokens > 0);
});

test('calls to other services stay as they were', async () => {
  const calls = capturedChat();
  await globalThis.MeetOpenAI.generateMoM({ apiKey: 'k', model: 'm', baseUrl: 'https://api.openai.com/v1', prompt: 'x' });
  assert.equal(calls[0].headers['anthropic-dangerous-direct-browser-access'], undefined);
  assert.equal(calls[0].body.max_tokens, undefined);
});

test('a look-alike address is not treated as Claude', async () => {
  const calls = capturedChat();
  await globalThis.MeetOpenAI.generateMoM({ apiKey: 'k', model: 'm', baseUrl: 'https://api.anthropic.com.example.org/v1', prompt: 'x' });
  assert.equal(calls[0].headers['anthropic-dangerous-direct-browser-access'], undefined);
});

test('model names are read from the service list', () => {
  const { modelIds } = globalThis.MeetOpenAI;
  assert.deepEqual(modelIds({ data: [{ id: 'b' }, { id: 'a' }, {}] }), ['a', 'b']);
  assert.deepEqual(modelIds({ models: [{ name: 'c' }] }), ['c']);
  assert.deepEqual(modelIds(null), []);
});

test('presets use model names that are still offered', () => {
  const { LLM_PRESETS } = globalThis.MeetOpenAI;
  const model = (name) => LLM_PRESETS.find((p) => p.name === name).model;
  assert.equal(model('Gemini'), 'gemini-3.8-flash');
  assert.equal(model('Groq'), 'openai/gpt-oss-120b');
});
