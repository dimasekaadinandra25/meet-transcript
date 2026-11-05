# Aplikasi Desktop Transcripables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aplikasi desktop Windows yang merekam audio komputer dan mikrofon dari aplikasi meeting apa pun, lalu menghasilkan transkrip berlabel You/Others, MoM, dan satu file rekaman per meeting.

**Architecture:** Electron dengan proses main yang memegang penyimpanan, jaringan, tray, dan izin. Renderer memuat `lib/` dan `panel/` yang sama dengan ekstensi lewat protokol aset privat, memakai shim `chrome.*`, dan menjalankan recorder serta controller pengganti service worker.

**Tech Stack:** Electron (versi stabil terbaru), electron-builder (NSIS), JavaScript, `tsc --noEmit` dengan `checkJs`, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-05-aplikasi-desktop-design.md`

## Prasyarat

- Branch `rewrite-compact` sudah diuji di browser dan di-commit. Bug `sttModel` di `panel/panel.js` sudah diperbaiki.
- Task 1 boleh jalan sebelum prasyarat ini, karena tidak menyentuh repo. Task 2 dan seterusnya tidak boleh.
- Kerjakan di branch `desktop-app` yang dibuat dari hasil prasyarat.
- macOS di luar plan ini. Gerbang dan penyesuaian macOS menjadi plan terpisah begitu ada Mac.

## Global Constraints

- Tanpa komentar di kode sumber, termasuk `// @ts-check`. Pemeriksaan tipe diaktifkan lewat `checkJs` di `desktop/tsconfig.json`.
- Commit tanpa baris `Co-Authored-By`.
- `node --test test/*.test.mjs` tetap lulus dan perilaku ekstensi tidak berubah. `desktop/` tidak masuk ZIP ekstensi.
- `lib/` dan `panel/` dipakai dari lokasinya. Tidak ada salinan yang di-commit.
- `contextIsolation` dan `sandbox` aktif, `nodeIntegration` mati, `webSecurity: false` tidak pernah dipakai.
- Tanpa telemetri. Audio dan transkrip hanya menuju endpoint yang diisi user.
- Rotasi STT 600000 ms. Part campuran dan video memakai timeslice 60000 ms. Video 1280x720, 10 fps, VP9, 500000 bps video, 48000 bps audio.
- Label baris persis `You` (mikrofon) dan `Others` (audio komputer). UI lainnya berbahasa Indonesia.

## Review Focus

- Endpoint STT mati saat Stop: audio tetap tersimpan, error terlihat, dan "Transkrip ulang" berhasil setelah server hidup (Task 8).
- Headset dicabut di tengah meeting: muncul peringatan dan track lain terus merekam (Task 7).
- Aplikasi crash atau listrik mati saat merekam: entri tetap ada di Riwayat setelah dibuka ulang dan potongannya bisa dipakai (Task 8).
- Kuota atau disk penuh saat menyimpan part: muncul peringatan dan recorder tidak berhenti (Task 7).
- Klik ganda Rekam atau Stop: hanya satu rekaman dan satu transkrip yang terjadi (Task 8).

---

### Task 1: Fase 0, prototipe tangkap audio Windows

Prototipe sekali pakai di folder di luar repo, misalnya `../transcripables-spike`. Tidak di-commit kecuali catatan hasilnya.

**Files:**
- Modify: `docs/superpowers/specs/2026-11-05-aplikasi-desktop-design.md` (tambah bagian `## Hasil Fase 0`)

**Interfaces:**
- Produces: keputusan lulus atau gagal, konfigurasi handler yang terbukti, dan dua temuan yang dipakai Task 7 serta Task 8.

- [ ] **Step 1: Buat prototipe Electron minimal**

Main memakai `session.defaultSession.setDisplayMediaRequestHandler` dan menjawab `{ video: <sumber layar dari desktopCapturer>, audio: 'loopback' }`. Renderer memanggil `getDisplayMedia`, menghentikan track video, memanggil `getUserMedia({ audio: true })`, lalu menjalankan dua `MediaRecorder` dan menyimpan dua file `.webm`.

- [ ] **Step 2: Jalankan panggilan sungguhan 30 menit di Zoom atau Teams desktop bersama satu peserta lain**

Ini butuh user dan satu peserta. Tepuk tangan sekali di awal dan akhir, dengan suara yang terdengar di kedua track, untuk mengukur selisih waktu.

- [ ] **Step 3: Periksa kriteria lulus spec**

Expected: track audio komputer memuat suara peserta lain; track mikrofon terpisah dan memuat suara user; aplikasi meeting terdengar normal tanpa bisu dan feedback; selisih kedua track di akhir kurang dari sekitar 1 detik; alur izin berhasil setelah aplikasi dibuka ulang.

- [ ] **Step 4: Catat dua temuan**

Kirim potongan mikrofon yang sunyi ke endpoint STT dan catat apakah muncul teks karangan. Rekam tanpa headset dan catat seberapa banyak suara speaker bocor ke mikrofon.

- [ ] **Step 5: Tulis hasil ke spec dan commit**

```bash
git add docs/superpowers/specs/2026-11-05-aplikasi-desktop-design.md
git commit -m "docs: hasil Fase 0 prototipe audio Windows"
```

**Gerbang:** bila ada kriteria yang gagal, berhenti dan kembalikan keputusan ke user. Task 2 tidak dimulai.

### Task 2: Kerangka aplikasi dan protokol aset

**Files:**
- Create: `desktop/package.json`, `desktop/tsconfig.json`, `desktop/main/main.js`, `desktop/main/assets.js`, `desktop/preload.js`, `desktop/renderer/index.html`
- Modify: `.gitignore` (tambah `desktop/node_modules/`, `desktop/dist/`)
- Test: `desktop/test/assets.test.mjs`

**Interfaces:**
- Produces: `resolveAsset(urlPath: string, roots: { app: string, shared: string }) -> string | null`, skema `transcripables://app/`, `sharedRoot()` yang mengembalikan `process.resourcesPath` saat packaged dan akar repo saat dev.

- [ ] **Step 1: Tulis test yang gagal**

```js
test('hanya memetakan folder yang diizinkan', () => {
  const roots = { app: '/a/desktop', shared: '/a' };
  assert.equal(resolveAsset('/renderer/index.html', roots), join('/a/desktop', 'renderer/index.html'));
  assert.equal(resolveAsset('/lib/merge.js', roots), join('/a', 'lib/merge.js'));
  assert.equal(resolveAsset('/panel/panel.js', roots), join('/a', 'panel/panel.js'));
  assert.equal(resolveAsset('/icons/icon48.png', roots), join('/a', 'icons/icon48.png'));
});
test('menolak traversal dan path lain', () => {
  const roots = { app: '/a/desktop', shared: '/a' };
  for (const p of ['/lib/../manifest.json', '/lib/%2e%2e/LICENSE', '/main/main.js', '/test/x.js', '/lib/..%5cLICENSE']) {
    assert.equal(resolveAsset(p, roots), null);
  }
});
```

- [ ] **Step 2: Jalankan test**

Run: `node --test desktop/test/assets.test.mjs`
Expected: FAIL karena `resolveAsset` belum ada.

- [ ] **Step 3: Implementasikan kerangka**

`resolveAsset` mendekode path, menolak segmen `..`, dan hanya mengizinkan `renderer/` dari `app` serta `lib/`, `panel/`, `icons/` dari `shared`. `main.js` mendaftarkan skema dengan `standard`, `secure`, `supportFetchAPI`, membuat jendela `backgroundThrottling: false`, dan memuat `transcripables://app/renderer/index.html` dengan CSP `default-src 'self'; connect-src 'self'`. `setPermissionRequestHandler` hanya mengizinkan media dari origin aplikasi. `package.json` memuat skrip `start`, `test`, `typecheck`, `dist`.

- [ ] **Step 4: Verifikasi**

Run: `node --test desktop/test/assets.test.mjs`, lalu `npm --prefix desktop run typecheck`, lalu `npm --prefix desktop start`
Expected: test PASS, typecheck tanpa error, dan jendela terbuka tanpa error CSP di DevTools.

- [ ] **Step 5: Commit**

```bash
git add .gitignore desktop/package.json desktop/package-lock.json desktop/tsconfig.json desktop/main desktop/preload.js desktop/renderer desktop/test
git commit -m "feat(desktop): kerangka Electron dan protokol aset"
```

### Task 3: Penyimpanan dan enkripsi API key

Satu file JSON per key, ditulis lewat file sementara lalu rename, sehingga crash tidak merusak data lain.

**Files:**
- Create: `desktop/main/store.js`
- Modify: `desktop/main/main.js`, `desktop/preload.js`
- Test: `desktop/test/store.test.mjs`

**Interfaces:**
- Produces: `createStore({ dir: string, cipher: { available(): boolean, encrypt(s: string): string, decrypt(s: string): string } })` dengan `get(keys: string | string[] | null) -> Promise<object>`, `set(obj) -> Promise<void>`, `remove(keys) -> Promise<void>`, `clear() -> Promise<void>`. IPC `store:get`, `store:set`, `store:remove`, `store:clear` dan event `store:changed` berbentuk `{ [key]: { newValue, oldValue } }`.

- [ ] **Step 1: Tulis test yang gagal**

```js
test('API key terenkripsi di disk dan terbaca polos', async () => {
  await store.set({ settings: { apiKey: 'sk-rahasia', sttApiKey: 'stt-rahasia', model: 'm' } });
  const disk = readAll(dir);
  assert.ok(!disk.includes('sk-rahasia') && !disk.includes('stt-rahasia'));
  assert.equal((await store.get('settings')).settings.apiKey, 'sk-rahasia');
});
test('menolak menyimpan key bila enkripsi tidak tersedia', async () => {
  await assert.rejects(noCipherStore.set({ settings: { apiKey: 'x' } }), /enkripsi/i);
});
test('file rusak dipindahkan, bukan ditimpa', async () => {
  writeFileSync(join(dir, encodeURIComponent('meeting:a') + '.json'), '{rusak');
  assert.deepEqual(await store.get('meeting:a'), {});
  assert.ok(readdirSync(dir).some((f) => f.includes('.corrupt-')));
});
test('key berisi titik dua dan get(null) bekerja', async () => {
  await store.set({ 'meeting:desktop-1': { id: 'desktop-1' }, meetings: ['desktop-1'] });
  assert.deepEqual(Object.keys(await store.get(null)).sort(), ['meeting:desktop-1', 'meetings']);
});
```

- [ ] **Step 2: Jalankan test**

Run: `node --test desktop/test/store.test.mjs`
Expected: FAIL karena `createStore` belum ada.

- [ ] **Step 3: Implementasikan `createStore` dan sambungkan IPC**

`cipher` di main memakai `safeStorage` dengan output base64. Hanya `settings.apiKey` dan `settings.sttApiKey` yang dienkripsi.

- [ ] **Step 4: Jalankan test**

Run: `node --test desktop/test/store.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add desktop/main desktop/preload.js desktop/test/store.test.mjs
git commit -m "feat(desktop): penyimpanan per key dan enkripsi API key"
```

### Task 4: Jaringan lewat proses main

**Files:**
- Create: `desktop/main/net.js`, `desktop/renderer/openai-bridge.js`
- Modify: `desktop/main/main.js`, `desktop/preload.js`
- Test: `desktop/test/net.test.mjs`

**Interfaces:**
- Consumes: `sharedRoot()` dari Task 2.
- Produces: `netCall(fn: () => Promise<any>) -> Promise<{ ok: true, value } | { ok: false, error: string, name: string }>`, IPC `net:chat`, `net:test`, `net:stt` (membawa `ArrayBuffer`), `net:probe(url, key)`. Di renderer, `openai-bridge.js` menimpa `generateMoM`, `testConnection`, `transcribeAudio` pada `globalThis.MeetOpenAI` dan mengekspor `bridgeFetch(url, init) -> Promise<{ ok, status }>`.

- [ ] **Step 1: Tulis test yang gagal**

```js
test('pesan error tiba utuh tanpa awalan IPC', async () => {
  const r = await netCall(async () => { throw new Error('HTTP 404 (endpoint/model STT tidak ditemukan?)'); });
  assert.deepEqual(r, { ok: false, name: 'Error', error: 'HTTP 404 (endpoint/model STT tidak ditemukan?)' });
});
test('nama TimeoutError dipertahankan', async () => {
  const e = Object.assign(new Error('x'), { name: 'TimeoutError' });
  assert.equal((await netCall(async () => { throw e; })).name, 'TimeoutError');
});
test('probe menolak skema selain http dan https', async () => {
  assert.equal((await probe('file:///etc/passwd', '')).ok, false);
});
```

- [ ] **Step 2: Jalankan test**

Run: `node --test desktop/test/net.test.mjs`
Expected: FAIL karena `netCall` belum ada.

- [ ] **Step 3: Implementasikan**

`net.js` memuat `lib/stt.js` dan `lib/openai.js` lewat `require` side-effect, lalu mengubah `ArrayBuffer` menjadi `Blob` sebelum `transcribeAudio`. `net:probe` memakai `AbortSignal.timeout(15000)`.

- [ ] **Step 4: Verifikasi CORS**

Run: `node --test desktop/test/net.test.mjs`, lalu Tes koneksi ke server lokal tanpa header CORS dari DevTools renderer lewat bridge.
Expected: test PASS dan panggilan berhasil. `fetch` langsung dari renderer tetap diblokir CSP.

- [ ] **Step 5: Commit**

```bash
git add desktop/main desktop/preload.js desktop/renderer/openai-bridge.js desktop/test/net.test.mjs
git commit -m "feat(desktop): STT dan LLM lewat proses main"
```

### Task 5: Prefix rekaman baru di audiostore

**Files:**
- Modify: `lib/audiostore.js`
- Test: `test/audiostore.test.mjs`

**Interfaces:**
- Produces: key `schunk:<baseTime>:<i>`, `mchunk:<baseTime>:<i>`, `xpart:<baseTime>:<i>`; counter `systemCount`, `micCount`, `mixCount`; `appendSystemChunk(blob, recId)`, `appendMicChunk(blob, recId)`, `appendMixPart(blob, recId)`; `loadSystem(recId)`, `loadMic(recId)`, `loadMix(recId)` dengan bentuk hasil sama seperti `loadAudio`. `groupRecordings` menambah `systemKeys`, `micKeys`, `mixKeys`.

- [ ] **Step 1: Tulis test yang gagal**

```js
test('prefix baru dikelompokkan ke daftarnya, bukan ke video', () => {
  const [r] = groupRecordings(['meta:5', 'schunk:5:0', 'mchunk:5:0', 'xpart:5:0', 'vchunk:5:0'],
    new Map([['meta:5', { baseTime: 5 }]]));
  assert.deepEqual(r.systemKeys.map((k) => k.key), ['schunk:5:0']);
  assert.deepEqual(r.micKeys.map((k) => k.key), ['mchunk:5:0']);
  assert.deepEqual(r.mixKeys.map((k) => k.key), ['xpart:5:0']);
  assert.deepEqual(r.videoKeys.map((k) => k.key), ['vchunk:5:0']);
});
test('pemangkasan ikut menghapus prefix baru', () => {
  const metas = new Map([1, 2, 3, 4, 5, 6].map((n) => [`meta:${n}`, { baseTime: n }]));
  const recs = groupRecordings([...metas.keys(), 'schunk:1:0', 'mchunk:1:0', 'xpart:1:0'], metas);
  assert.deepEqual(pruneTargets(recs).sort(), ['mchunk:1:0', 'meta:1', 'schunk:1:0', 'xpart:1:0']);
});
```

- [ ] **Step 2: Jalankan test**

Run: `node --test test/audiostore.test.mjs`
Expected: FAIL karena `systemKeys` belum ada.

- [ ] **Step 3: Implementasikan secara aditif**

Ganti percabangan `chunk`/`video` di `groupRecordings` dengan peta prefix ke nama daftar, dan buat `loadParts` menerima nama daftar. `publicMeta` membuang daftar baru. `loadAudio` dan `loadVideo` berperilaku sama.

- [ ] **Step 4: Jalankan seluruh test ekstensi**

Run: `node --test test/*.test.mjs`
Expected: PASS semua.

- [ ] **Step 5: Commit**

```bash
git add lib/audiostore.js test/audiostore.test.mjs
git commit -m "feat(audiostore): prefix untuk track STT dan campuran desktop"
```

### Task 6: Penggabungan track dan penjaga transkrip ulang

**Files:**
- Create: `desktop/renderer/tracks.js`
- Test: `desktop/test/tracks.test.mjs`

**Interfaces:**
- Consumes: `MeetStt.mergeSttChunks`.
- Produces: `globalThis.MeetTracks` berisi `mergeTracks({ system, mic, chunkMs, baseTime }) -> Segment[]`, dengan `system` dan `mic` berbentuk `{ results, indices }`, dan `replaceBlocker({ system, mic }) -> string | null`.

- [ ] **Step 1: Tulis test yang gagal**

```js
test('memberi label dan mengurutkan menurut waktu', () => {
  const segs = mergeTracks({ chunkMs: 600000, baseTime: 1000,
    system: { results: [{ segments: [{ start: 2, text: 'halo' }] }], indices: [0] },
    mic: { results: [{ segments: [{ start: 1, text: 'hai' }] }], indices: [0] } });
  assert.deepEqual(segs.map((s) => [s.speaker, s.text, s.t]), [['You', 'hai', 2000], ['Others', 'halo', 3000]]);
});
test('mikrofon sukses tapi audio komputer gagal total diblokir', () => {
  const ok = { results: [{ segments: [{ start: 0, text: 'a' }] }] };
  assert.match(replaceBlocker({ system: { results: [{ error: 'HTTP 500' }] }, mic: ok }), /HTTP 500/);
});
test('mikrofon sunyi tanpa error tidak memblokir', () => {
  const ok = { results: [{ segments: [{ start: 0, text: 'a' }] }] };
  assert.equal(replaceBlocker({ system: ok, mic: { results: [{ segments: [] }] } }), null);
});
test('tanpa teks sama sekali diblokir', () => {
  const none = { results: [{ segments: [] }] };
  assert.match(replaceBlocker({ system: none, mic: none }), /tidak menghasilkan teks/);
});
test('sebagian potongan gagal tidak memblokir bila track itu masih punya teks', () => {
  const part = { results: [{ error: 'x' }, { segments: [{ start: 0, text: 'a' }] }] };
  assert.equal(replaceBlocker({ system: part, mic: { results: [] } }), null);
});
```

- [ ] **Step 2: Jalankan test**

Run: `node --test desktop/test/tracks.test.mjs`
Expected: FAIL karena `MeetTracks` belum ada.

- [ ] **Step 3: Implementasikan `tracks.js` sebagai classic script**

Suatu track memblokir bila ada potongan error dan tidak ada teks pada track itu.

- [ ] **Step 4: Jalankan test**

Run: `node --test desktop/test/tracks.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add desktop/renderer/tracks.js desktop/test/tracks.test.mjs
git commit -m "feat(desktop): gabung track You/Others dan penjaga per track"
```

### Task 7: Recorder tiga track dan mute

**Files:**
- Create: `desktop/renderer/recorder.js`
- Test: `desktop/test/recorder.test.mjs`

**Interfaces:**
- Consumes: fungsi append dari Task 5, handler tampilan dari Task 1.
- Produces: `createRecorder(deps)` dengan `deps = { AudioContext, MediaRecorder, MediaStream, getDisplayMedia, getUserMedia, store, warn, setInterval, clearInterval }`, yang mengembalikan `start({ baseTime, mic: boolean, video: boolean, chunkMs }) -> Promise<void>`, `stop() -> Promise<{ peaks: { system: number[], mic: number[] } }>`, `setMuted(on: boolean)`, `isMuted() -> boolean`.

- [ ] **Step 1: Tulis test yang gagal dengan fake Web Audio dan MediaRecorder**

```js
test('tidak menyambung sumber ke speaker', async () => {
  await rec.start(opts);
  assert.ok(!fake.connections.some((c) => c.to === fake.ctx.destination));
});
test('mute menutup gain mikrofon sebelum track mikrofon dan campuran', async () => {
  await rec.start(opts);
  rec.setMuted(true);
  assert.equal(fake.micGain.gain.value, 0);
  assert.ok(fake.path(fake.micSource, fake.micGain, fake.micDest));
  assert.ok(fake.path(fake.micSource, fake.micGain, fake.mixDest));
  assert.ok(!fake.path(fake.micSource, fake.mixDest, { skipping: fake.micGain }));
  assert.equal(fake.recorders.filter((r) => r.state === 'recording').length, 3);
});
test('STT berotasi, campuran tidak', async () => {
  await rec.start(opts);
  const mix = fake.recorderFor(fake.mixDest);
  fake.tick(600000);
  assert.equal(mix.state, 'recording');
  assert.equal(mix.timeslice, 60000);
  assert.equal(fake.store.calls.appendSystemChunk.length, 1);
  assert.equal(fake.store.calls.appendMicChunk.length, 1);
});
test('track mikrofon sunyi sejak awal saat izin ditolak', async () => {
  deps.getUserMedia = async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); };
  await rec.start(opts);
  assert.match(warnings.at(-1), /mikrofon/i);
  assert.equal(fake.recorders.filter((r) => r.state === 'recording').length, 3);
});
test('headset dicabut: peringatan dan track lain tetap jalan', async () => {
  await rec.start(opts);
  fake.micTrack.emit('ended');
  assert.match(warnings.at(-1), /mikrofon/i);
  assert.equal(fake.recorderFor(fake.mixDest).state, 'recording');
});
test('kuota penuh: peringatan dan recorder tetap jalan', async () => {
  fake.store.failNext('appendMixPart', new Error('QuotaExceededError'));
  await rec.start(opts);
  fake.recorderFor(fake.mixDest).emitData(new Blob(['x']));
  await flush();
  assert.match(warnings.at(-1), /Quota/);
  assert.equal(fake.recorderFor(fake.mixDest).state, 'recording');
});
test('stop menunggu semua simpanan dan melepas track', async () => {
  await rec.start(opts);
  await rec.stop();
  assert.ok(fake.tracks.every((t) => t.stopped));
});
```

- [ ] **Step 2: Jalankan test**

Run: `node --test desktop/test/recorder.test.mjs`
Expected: FAIL karena `createRecorder` belum ada.

- [ ] **Step 3: Implementasikan graf audio dan recorder**

`system → mixDest`, `system → systemDest`, `micSource → micGain → micDest`, `micGain → mixDest`. `micDest` dibuat sejak awal, supaya slot waktu sejajar walau mikrofon tersambung belakangan. Track video dari `getDisplayMedia` dihentikan pada mode audio. Mode video memakai track video plus audio campuran. `stop` memakai batas tunggu 5000 ms per recorder dan mencatat puncak suara per potongan STT.

- [ ] **Step 4: Jalankan test**

Run: `node --test desktop/test/recorder.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add desktop/renderer/recorder.js desktop/test/recorder.test.mjs
git commit -m "feat(desktop): recorder tiga track dengan mute"
```

### Task 8: Controller pengganti service worker

**Files:**
- Create: `desktop/renderer/controller.js`
- Test: `desktop/test/controller.test.mjs`

**Interfaces:**
- Consumes: `createRecorder`, `MeetTracks`, `MeetMerge`, `MeetAudioStore`, `MeetOpenAI` bridge, shim storage.
- Produces: `createController(deps)` dengan `handle(msg) -> Promise<any>` untuk `get-active`, `stop-recording`, `generate-mom`, `regenerate-transcript`, `send-to-ai`, `start-recording { video }`, `set-muted { on }`, `rename-meeting { id, title }`; `recover() -> Promise<void>`; dan `broadcast` berbentuk `rec-state`, `status`, `meeting-updated`, sama seperti pesan yang sudah dibaca `panel.js`.

- [ ] **Step 1: Tulis test yang gagal**

```js
test('rekaman membuat entri desktop-<baseTime> dengan judul tanggal', async () => {
  await ctl.handle({ type: 'start-recording', video: false });
  const m = store.data[`meeting:desktop-${NOW}`];
  assert.equal(m.source, 'audio');
  assert.match(m.title, /\d/);
  assert.deepEqual(store.data.meetings, [`desktop-${NOW}`]);
});
test('klik ganda Rekam dan Stop hanya menghasilkan satu rekaman dan satu transkrip', async () => {
  await Promise.all([ctl.handle(START), ctl.handle(START)]);
  assert.equal(fakeRecorder.starts, 1);
  await Promise.all([ctl.handle(STOP), ctl.handle(STOP)]);
  assert.equal(fakeOpenAI.transcribeCalls.length, 2);
});
test('STT mati saat Stop: audio utuh, error terlihat, transkrip ulang berhasil', async () => {
  fakeOpenAI.fail = new Error('Tidak bisa terhubung');
  await runRecording(ctl);
  assert.match(lastRecState().error, /Tidak bisa terhubung/);
  assert.equal(fakeStore.removed.length, 0);
  fakeOpenAI.fail = null;
  assert.equal((await ctl.handle(regenerate(id, recId))).ok, true);
  assert.ok(store.data[`meeting:${id}`].segments.some((s) => s.speaker === 'Others'));
});
test('transkrip ulang yang diblokir tidak mengubah baris lama', async () => {
  await runRecording(ctl);
  const before = structuredClone(store.data[`meeting:${id}`].segments);
  fakeOpenAI.failFor = 'system';
  assert.equal((await ctl.handle(regenerate(id, recId))).ok, false);
  assert.deepEqual(store.data[`meeting:${id}`].segments, before);
});
test('recover menutup entri dari crash dan mempertahankan rekamannya', async () => {
  store.data[`meeting:desktop-5`] = { id: 'desktop-5', title: 't', startedAt: 5, endedAt: null, segments: [], mom: null, source: 'audio' };
  await ctl.recover();
  assert.ok(store.data['meeting:desktop-5'].endedAt);
  assert.equal(fakeStore.removed.length, 0);
});
test('send-to-ai membuka situs di browser default tanpa injeksi', async () => {
  await ctl.handle({ type: 'send-to-ai', target: 'gemini', text: 'p', id });
  assert.deepEqual(openedUrls, ['https://gemini.google.com/app']);
});
```

- [ ] **Step 2: Jalankan test**

Run: `node --test desktop/test/controller.test.mjs`
Expected: FAIL karena `createController` belum ada.

- [ ] **Step 3: Implementasikan**

Pakai guard sinkron sebelum `await` pertama untuk Rekam dan Stop. Tulis storage lewat satu antrean. Selalu lewati potongan mikrofon dengan puncak di bawah 0.01 dan isi hasilnya `{ segments: [] }`.

- [ ] **Step 4: Jalankan test**

Run: `node --test desktop/test/controller.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add desktop/renderer/controller.js desktop/test/controller.test.mjs
git commit -m "feat(desktop): controller rekam, transkrip, dan pemulihan crash"
```

### Task 9: Panel di aplikasi desktop

**Files:**
- Create: `desktop/renderer/chrome-shim.js`, `desktop/renderer/host.js`
- Modify: `desktop/renderer/index.html`, `panel/panel.js`
- Test: `desktop/test/shim.test.mjs`

**Interfaces:**
- Consumes: IPC Task 3, `bridgeFetch` Task 4, `createController` Task 8.
- Produces: `globalThis.chrome` berisi `storage.local`, `storage.onChanged`, `runtime.sendMessage`, `runtime.onMessage`, `permissions.request` (selalu `true`), dan `tabCapture: {}`. `globalThis.PanelHost` berisi `hideMeetSettings: true`, `recordControls(recState) -> HTMLElement`, `titleEditor(meeting) -> HTMLElement`, `fetch`, `aiLabel(name) -> string`, `backupWarning: string`, `transcriptHint: string`.

- [ ] **Step 1: Tulis test shim yang gagal**

```js
test('sendMessage meneruskan balasan controller', async () => {
  assert.deepEqual(await chrome.runtime.sendMessage({ type: 'get-active' }), { id: null });
});
test('onChanged berbentuk seperti chrome.storage', async () => {
  const seen = [];
  chrome.storage.onChanged.addListener((c, area) => seen.push([area, c]));
  ipc.emit('store:changed', { settings: { newValue: { a: 1 }, oldValue: undefined } });
  assert.deepEqual(seen[0], ['local', { settings: { newValue: { a: 1 }, oldValue: undefined } }]);
});
```

- [ ] **Step 2: Jalankan test**

Run: `node --test desktop/test/shim.test.mjs`
Expected: FAIL karena shim belum ada.

- [ ] **Step 3: Implementasikan shim dan tambahkan titik hook di `panel.js`**

Setiap hook bercabang pada `globalThis.PanelHost`. Tanpa host, perilaku ekstensi sama persis. Hook: baris Sumber transkrip, caption, dan bahasa caption disembunyikan; bar Live memakai `recordControls`; judul memakai `titleEditor`; `probeStt` memakai `PanelHost.fetch`; label AI menjadi "Salin & buka Gemini" atau "Salin & buka ChatGPT"; item "Unduh rekaman" memakai `loadMix` sebagai satu file bila `r.mixCount > 0`; gate transkrip menerima `r.systemCount > 0`; bagian Backup menambah `backupWarning` bahwa ZIP memuat API key dalam teks polos. `transcriptHint` berisi petunjuk kebocoran suara tanpa headset.

- [ ] **Step 4: Verifikasi aplikasi dan ekstensi**

Run: `node --test desktop/test/shim.test.mjs`, lalu `node --test test/*.test.mjs`, lalu `npm --prefix desktop start`
Expected: test PASS. Di aplikasi: rekam, mute, Stop, transkrip berlabel, Generate MoM, Copy, Unduh `.txt`/`.md`, satu file rekaman, ubah judul, ekspor backup. Di ekstensi lewat Load unpacked: panel dan Settings sama seperti sebelumnya.

- [ ] **Step 5: Commit**

```bash
git add desktop/renderer panel/panel.js desktop/test/shim.test.mjs
git commit -m "feat(desktop): panel berjalan di aplikasi desktop"
```

### Task 10: Tray, indikator, dan keamanan saat merekam

**Files:**
- Create: `desktop/main/lifecycle.js`
- Modify: `desktop/main/main.js`, `desktop/preload.js`, `desktop/renderer/host.js`
- Test: `desktop/test/lifecycle.test.mjs`

**Interfaces:**
- Produces: `closeAction({ recording: boolean, quitting: boolean }) -> 'hide' | 'confirm-quit' | 'close'`; IPC `rec:state { recording, muted }`; shortcut `Alt+Shift+R` (audio), `Alt+Shift+V` (audio + video), `Alt+Shift+S` (stop), `Alt+Shift+M` (mute).

- [ ] **Step 1: Tulis test yang gagal**

```js
test('tutup jendela saat merekam tidak menghentikan rekaman', () => {
  assert.equal(closeAction({ recording: true, quitting: false }), 'hide');
});
test('keluar saat merekam meminta konfirmasi', () => {
  assert.equal(closeAction({ recording: true, quitting: true }), 'confirm-quit');
});
test('tanpa rekaman jendela menutup', () => {
  assert.equal(closeAction({ recording: false, quitting: false }), 'close');
});
```

- [ ] **Step 2: Jalankan test**

Run: `node --test desktop/test/lifecycle.test.mjs`
Expected: FAIL karena `closeAction` belum ada.

- [ ] **Step 3: Implementasikan**

Ikon dan tooltip tray berubah saat merekam dan saat mute. `powerSaveBlocker.start('prevent-app-suspension')` aktif selama merekam. Pengingat izin peserta tampil sekali, ditandai `settings.consentShown`. UI menyatakan bahwa mute di aplikasi meeting tidak menghentikan rekaman mikrofon. Pendaftaran shortcut yang gagal tampil sebagai peringatan.

- [ ] **Step 4: Verifikasi**

Run: `node --test desktop/test/lifecycle.test.mjs`, lalu `npm --prefix desktop start`
Expected: test PASS. Menutup jendela saat merekam menurunkan aplikasi ke tray dengan rotasi tetap berjalan, keluar meminta konfirmasi, dan keempat shortcut bekerja saat aplikasi lain sedang fokus.

- [ ] **Step 5: Commit**

```bash
git add desktop/main desktop/preload.js desktop/renderer/host.js desktop/test/lifecycle.test.mjs
git commit -m "feat(desktop): tray, indikator, shortcut, dan konfirmasi keluar"
```

### Task 11: Installer Windows dan uji rilis

**Files:**
- Modify: `desktop/package.json`, `README.md`, `README.en.md`, `docs/superpowers/specs/2026-11-05-aplikasi-desktop-design.md`

**Interfaces:**
- Consumes: seluruh task sebelumnya.
- Produces: `desktop/dist/Transcripables-Setup-<versi>.exe`.

- [ ] **Step 1: Tambah konfigurasi electron-builder**

Target `nsis` untuk Windows, tanpa signing, `extraResources` memetakan `../lib`, `../panel`, `../icons`. Jangan tambahkan konfigurasi macOS. Target publish `github` dengan repo `dimasekaadinandra25/meet-transcript`, hanya dijalankan manual.

- [ ] **Step 2: Bangun dan pasang installer**

Run: `npm --prefix desktop run dist`
Expected: installer dibuat. Setelah dipasang, aplikasi terbuka dan aset `lib/` termuat lewat `transcripables://`.

- [ ] **Step 3: Uji kuota penyimpanan**

Rekam mode video selama minimal 2 jam pada build terpasang.
Expected: tidak ada peringatan kuota. Bila muncul, hentikan task dan laporkan, karena rekaman harus pindah ke file di `userData` sesuai spec.

- [ ] **Step 4: Uji panggilan sungguhan di satu aplikasi meeting desktop yang dimiliki user, bersama satu peserta lain**

Expected: aplikasi meeting terdengar normal tanpa bisu dan feedback, suara peserta tertangkap, transkrip berlabel You dan Others, MoM terbentuk, dan satu file rekaman bisa diputar. Bicara saat mute tidak muncul di file unduhan, track mikrofon, maupun transkrip. Audio dan transkrip hanya menuju endpoint yang diisi, dibuktikan dari daftar koneksi aplikasi.

- [ ] **Step 5: Tulis panduan instalasi, termasuk peringatan SmartScreen, di kedua README**

- [ ] **Step 6: Commit**

```bash
git add desktop/package.json desktop/package-lock.json README.md README.en.md docs/superpowers/specs/2026-11-05-aplikasi-desktop-design.md
git commit -m "feat(desktop): installer Windows dan panduan instalasi"
```

Upload ke GitHub Releases tidak termasuk task ini. Lakukan hanya setelah user memintanya.
