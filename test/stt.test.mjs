import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../lib/stt.js');
const { parseSttResponse, mergeSttChunks } = globalThis.MeetStt;

test('parseSttResponse verbose_json', () => {
  const r = parseSttResponse('{"segments":[{"start":1.5,"text":"halo"},{"start":3,"text":"dunia"}]}');
  assert.deepEqual(r, { segments: [{ start: 1.5, text: 'halo' }, { start: 3, text: 'dunia' }] });
});

test('parseSttResponse fallback {text}', () => {
  assert.deepEqual(parseSttResponse('{"text":"halo dunia"}'), { segments: [{ start: 0, text: 'halo dunia' }] });
});

test('parseSttResponse objek langsung (bukan string)', () => {
  assert.deepEqual(parseSttResponse({ segments: [{ start: 0, text: 'a' }] }), { segments: [{ start: 0, text: 'a' }] });
});

test('parseSttResponse tak terparse → segments kosong', () => {
  assert.deepEqual(parseSttResponse('bukan json'), { segments: [] });
});

test('mergeSttChunks offset antar chunk + baseTime', () => {
  const base = 1000000;
  const chunks = [
    { segments: [{ start: 0, text: 'satu' }, { start: 2, text: 'dua' }] },
    { segments: [{ start: 1, text: 'tiga' }] },
  ];
  const out = mergeSttChunks(chunks, 600000, base);
  assert.deepEqual(out, [
    { t: base + 0, speaker: '', text: 'satu' },
    { t: base + 2000, speaker: '', text: 'dua' },
    { t: base + 600000 + 1000, speaker: '', text: 'tiga' },
  ]);
});

test('mergeSttChunks chunk error → penanda, segmen kosong dilewati', () => {
  const out = mergeSttChunks([{ error: 'gagal' }, { segments: [{ start: 0, text: '' }, { start: 1, text: 'ok' }] }], 600000, 0);
  assert.deepEqual(out, [
    { t: 0, speaker: '', text: '[transcript failed]', failedUntil: 600000 },
    { t: 601000, speaker: '', text: 'ok' },
  ]);
});

const { sttMode, sttEndpoint, WHISPER_DEFAULT, DEFAULT_LANGUAGE } = globalThis.MeetStt;

test('sttMode: settings kosong (instalasi baru) → whisper-local', () => {
  assert.equal(sttMode({}), 'whisper-local');
  assert.equal(sttMode(), 'whisper-local');
});

test('sttMode: sttMode tersimpan menang atas tebakan apa pun', () => {
  assert.equal(sttMode({ sttMode: 'api', apiKey: '' }), 'api');
});

test('sttMode migrasi: sttMode browser tersimpan → diturunkan ulang', () => {
  assert.equal(sttMode({ sttMode: 'browser' }), 'whisper-local');
  assert.equal(sttMode({ sttMode: 'browser', sttBaseUrl: 'http://localhost:8080/v1' }), 'whisper-local');
  assert.equal(sttMode({ sttMode: 'browser', sttBaseUrl: 'https://api.openai.com/v1' }), 'api');
  assert.equal(sttMode({ sttMode: 'browser', apiKey: 'k' }), 'whisper-local');
  assert.equal(sttMode({ sttMode: 'browser', baseUrl: 'https://api.openai.com/v1' }), 'whisper-local');
});

test('sttEndpoint: settings browser lama → mode http, bukan browser', () => {
  const r = sttEndpoint({ sttMode: 'browser', sttBrowserModel: 'Xenova/whisper-small' });
  assert.equal(r.mode, 'http');
  assert.equal(r.baseUrl, WHISPER_DEFAULT);
});

test('sttMode migrasi: sttBaseUrl lokal → whisper-local (port apa pun)', () => {
  assert.equal(sttMode({ sttBaseUrl: 'http://localhost:8080/v1' }), 'whisper-local');
  assert.equal(sttMode({ sttBaseUrl: 'http://127.0.0.1:9000/v1' }), 'whisper-local');
});

test('sttMode migrasi: sttBaseUrl remote / rusak → api', () => {
  assert.equal(sttMode({ sttBaseUrl: 'https://api.openai.com/v1' }), 'api');
  assert.equal(sttMode({ sttBaseUrl: 'bukan url' }), 'api');
});

test('sttMode migrasi: mode chat lama (endpoint chat terisi) → api, bukan whisper', () => {
  assert.equal(sttMode({ apiKey: 'k' }), 'api');
  assert.equal(sttMode({ baseUrl: 'https://x/v1' }), 'api');
});

test('sttEndpoint whisper-local: URL kosong → default localhost, apiKey chat TIDAK ikut', () => {
  assert.deepEqual(
    sttEndpoint({ sttMode: 'whisper-local', baseUrl: 'https://x/v1', apiKey: 'k' }),
    { mode: 'http', baseUrl: WHISPER_DEFAULT, apiKey: '', model: 'whisper-1', language: DEFAULT_LANGUAGE });
});

test('sttEndpoint api: sttBaseUrl terisi → apiKey utama TIDAK ikut', () => {
  const r = sttEndpoint({ sttMode: 'api', baseUrl: 'https://x/v1', apiKey: 'k', sttBaseUrl: 'http://localhost:20128/v1' });
  assert.equal(r.baseUrl, 'http://localhost:20128/v1');
  assert.equal(r.apiKey, '');
});

test('sttEndpoint api: sttBaseUrl + sttApiKey terisi → dua-duanya dipakai', () => {
  const r = sttEndpoint({ sttMode: 'api', baseUrl: 'https://x/v1', apiKey: 'k', sttBaseUrl: 'http://localhost:20128/v1', sttApiKey: 's' });
  assert.equal(r.baseUrl, 'http://localhost:20128/v1');
  assert.equal(r.apiKey, 's');
});

test('sttEndpoint api: STT fields kosong → jatuh ke endpoint chat (perilaku lama)', () => {
  const r = sttEndpoint({ sttMode: 'api', baseUrl: 'https://x/v1', apiKey: 'k' });
  assert.equal(r.baseUrl, 'https://x/v1');
  assert.equal(r.apiKey, 'k');
});

test('sttEndpoint: default language is auto, and a saved language is kept', () => {
  assert.equal(sttEndpoint({ sttMode: 'api' }).language, '');
  assert.equal(sttEndpoint({ sttMode: 'api', sttLanguage: '' }).language, '');
  assert.equal(sttEndpoint({ sttMode: 'api', sttLanguage: 'en' }).language, 'en');
});

test('parseSttResponse: segments kosong jatuh ke {text}, bukan dibuang', () => {
  assert.deepEqual(parseSttResponse('{"text":"halo dunia","segments":[]}'),
    { segments: [{ start: 0, text: 'halo dunia' }] });
});

test('parseSttResponse: body {error} jadi penanda gagal, bukan segmen kosong', () => {
  assert.deepEqual(parseSttResponse('{"error":{"message":"model tidak ada"}}'),
    { error: 'model tidak ada' });
  const merged = mergeSttChunks([parseSttResponse('{"error":{"message":"x"}}')], 1000, 0);
  assert.deepEqual(merged.map((s) => s.text), ['[transcript failed]']);
});

test('mergeSttChunks memakai indeks asli potongan saat ada yang bolong', () => {
  const r = [{ segments: [{ start: 0, text: 'satu' }] }, { segments: [{ start: 0, text: 'tiga' }] }];
  assert.deepEqual(mergeSttChunks(r, 600000, 0, [0, 2]).map((s) => s.t), [0, 1200000]);
  assert.deepEqual(mergeSttChunks(r, 600000, 0).map((s) => s.t), [0, 600000]);
});

test('parseSttResponse: text kosong tidak menang atas body error', () => {
  assert.deepEqual(parseSttResponse('{"text":"   ","error":{"message":"model mati"}}'),
    { error: 'model mati' });
  assert.deepEqual(parseSttResponse('{"text":""}'), { segments: [] });
});

test('parseSttResponse: segmen sah menang atas field error yang menempel', () => {
  assert.deepEqual(parseSttResponse('{"segments":[{"start":0,"text":"halo"}],"error":{"message":"warn"}}'),
    { segments: [{ start: 0, text: 'halo' }] });
});

test('parseSttResponse: error tanpa message tetap terbaca', () => {
  assert.deepEqual(parseSttResponse('{"error":{"code":500}}'), { error: '{"code":500}' });
});

test('mergeSttChunks mengabaikan indices yang panjangnya tidak sepadan', () => {
  const r = [{ segments: [{ start: 0, text: 'a' }] }, { segments: [{ start: 0, text: 'b' }] },
    { segments: [{ start: 0, text: 'c' }] }];
  assert.deepEqual(mergeSttChunks(r, 600000, 0, [0, 2]).map((s) => s.t), [0, 600000, 1200000]);
});

test('sttEndpoint whisper-local: default model Online speech-to-text service yang terbawa Simpan tidak dikirim ke whisper', () => {
  const saved = { sttMode: 'whisper-local', sttModel: globalThis.MeetStt.DEFAULT_API_MODEL };
  assert.equal(sttEndpoint(saved).model, 'whisper-1');
});

test('sttEndpoint whisper-local: model pilihan user tetap dipakai', () => {
  assert.equal(sttEndpoint({ sttMode: 'whisper-local', sttModel: 'large-v3' }).model, 'large-v3');
});

test('parseSttResponse keeps the speaker the service returns', () => {
  const r = parseSttResponse({ segments: [{ start: 1, text: 'halo', speaker: 'A' }, { start: 2, text: 'hai' }] });
  assert.deepEqual(r, { segments: [{ start: 1, text: 'halo', speaker: 'A' }, { start: 2, text: 'hai' }] });
});

test('mergeSttChunks names the speaker from the service', () => {
  const out = mergeSttChunks([{ segments: [{ start: 0, text: 'halo', speaker: 'B' }, { start: 1, text: 'hai' }] }], 1000, 0);
  assert.deepEqual(out.map((s) => s.speaker), ['Speaker B', '']);
});

test('built-in mode uses the engine in the desktop app', () => {
  globalThis.desktop = {};
  try {
    const { sttMode, sttEndpoint, BUILTIN_URL } = globalThis.MeetStt;
    const settings = { sttMode: 'builtin', sttBaseUrl: 'http://old', sttApiKey: 'k', sttLanguage: 'en' };
    assert.equal(sttMode(settings), 'builtin');
    const endpoint = sttEndpoint(settings);
    assert.equal(endpoint.baseUrl, BUILTIN_URL);
    assert.equal(endpoint.apiKey, '');
    assert.equal(endpoint.language, 'en');
  } finally {
    delete globalThis.desktop;
  }
});

test('a backup from the desktop app falls back to Local Whisper in the extension', () => {
  const { sttMode } = globalThis.MeetStt;
  assert.equal(sttMode({ sttMode: 'builtin' }), 'whisper-local');
});

test('sound markers from Whisper are not transcript lines', () => {
  const r = parseSttResponse({ segments: [{ start: 0, text: ' [BLANK_AUDIO]' }, { start: 1, text: '(silence) [Music]' }, { start: 2, text: ' ♪ ' }, { start: 3, text: 'halo [tertawa] semua' }] });
  assert.deepEqual(r.segments.map((s) => s.text), ['halo [tertawa] semua']);
});

test('a reply with only sound markers has no segments', () => {
  assert.deepEqual(parseSttResponse({ text: ' [BLANK_AUDIO]\n' }), { segments: [] });
  assert.deepEqual(parseSttResponse({ segments: [{ start: 0, text: '[BLANK_AUDIO]' }] }), { segments: [] });
});

test('only a new install starts on the built-in engine', () => {
  const { neverConfigured } = globalThis.MeetStt;
  assert.equal(neverConfigured({}), true);
  assert.equal(neverConfigured({ settings: { uiLang: 'id' }, meetings: [] }), true);
  assert.equal(neverConfigured({ settings: { apiKey: 'k' } }), false);
  assert.equal(neverConfigured({ settings: { baseUrl: 'https://x/v1' } }), false);
  assert.equal(neverConfigured({ settings: { sttMode: 'whisper-local' } }), false);
  assert.equal(neverConfigured({ settings: { sttBaseUrl: 'http://x/v1' } }), false);
  assert.equal(neverConfigured({ meetings: ['a'] }), false);
});

test('STT detects the language by default, for every language', () => {
  const { sttEndpoint } = globalThis.MeetStt;
  assert.equal(sttEndpoint({}).language, '');
  assert.equal(sttEndpoint({ sttMode: 'api', sttBaseUrl: 'https://x/v1' }).language, '');
});

test('a language you choose is still used', () => {
  const { sttEndpoint } = globalThis.MeetStt;
  assert.equal(sttEndpoint({ sttLanguage: 'ja' }).language, 'ja');
  assert.equal(sttEndpoint({ sttLanguage: '' }).language, '');
});
