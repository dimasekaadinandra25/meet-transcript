# Desain: Aplikasi desktop Transcripables (Windows & macOS)

Tanggal: 2026-11-05
Status: disetujui user, 2026-11-05

Penanda: **[user]** = diputuskan user. **[usulan disetujui]** = diusulkan Claude
lalu disetujui user. **[keputusan Claude]** = belum pernah ditanyakan ke user,
silakan dibantah saat review.

## Masalah dan alasan

Ekstensi hanya menjangkau meeting yang berjalan di tab browser. Meeting di
aplikasi desktop (Zoom, Teams, Slack, Webex, Discord, WhatsApp, dan lainnya) di
luar jangkauannya, dan bahasa pemrograman apa pun tidak mengubah batasan itu.
Yang dibutuhkan adalah aplikasi desktop yang merekam audio komputer.

Yang diinginkan user setelah meeting selesai, dari aplikasi meeting apa pun:
transkrip lengkap, MoM, dan rekaman.

## Tujuan

1. Aplikasi desktop untuk Windows dan macOS. **[user]** Windows dikerjakan dan
   dirilis lebih dulu, karena user tidak punya Mac untuk pengujian. **[user]**
   macOS menyusul begitu ada Mac dari user atau tim. **[keputusan Claude]**
2. Berfungsi untuk semua aplikasi meeting yang suaranya keluar lewat audio
   komputer, tanpa integrasi per aplikasi. **[user]**
3. Hasil per meeting: transkrip lengkap, MoM, rekaman. **[user]**
4. Baris transkrip berlabel "You" (mikrofon) atau "Others" (audio komputer).
   **[usulan disetujui]**
5. Memakai layanan yang sama dengan ekstensi: server Whisper sendiri atau STT
   API untuk transkrip, LLM pilihan user untuk MoM. **[usulan disetujui]**

## Bukan tujuan

- Ponsel. **[user]**
- Pemisahan pembicara dengan AI (Speaker 1, Speaker 2) dan nama asli otomatis.
  User memilih transkrip teks saja. **[user]**
- Deteksi meeting otomatis: mulai dan berhenti ditekan user. **[usulan disetujui]**
- Menggantikan ekstensi. Ekstensi tetap ada untuk browser, termasuk nama
  pembicara dari caption Meet. **[usulan disetujui]**
- Linux, update otomatis, sinkronisasi cloud, server milik proyek.
  **[keputusan Claude]**

## Yang tidak boleh terjadi

- Merekam tanpa indikator yang terlihat. **[usulan disetujui]**
- Audio atau transkrip dikirim ke mana pun selain endpoint yang diisi user.
  Tanpa telemetri. **[usulan disetujui]**
- Rekaman hilang karena STT gagal atau aplikasi crash. Perilaku ini sudah ada di
  ekstensi dan harus tetap ada. **[keputusan Claude]**
- `lib/` punya dua salinan yang berjalan sendiri-sendiri. **[keputusan Claude]**
- Ekstensi mendapat build step, atau folder desktop ikut masuk ZIP ekstensi.
  **[keputusan Claude]**

## Teknologi

- Electron, dengan JavaScript. **[usulan disetujui]**
- Pemeriksaan tipe `// @ts-check` + `tsc --noEmit`. **[usulan disetujui]**
- Kode tinggal di `desktop/` dalam repo ini, dengan `package.json` sendiri.
  `lib/` dipakai langsung dari lokasinya, bukan disalin. **[keputusan Claude]**
- Installer dibuat dengan electron-builder **[keputusan Claude]** dan dirilis lewat
  GitHub Releases di repo user, `dimasekaadinandra25/meet-transcript`. **[user]**
- Pemakai awal: user dan timnya, dengan kemungkinan rilis publik nanti. **[user]**
  Rilis tim tidak ditandatangani dan memakai panduan instalasi manual, termasuk
  peringatan SmartScreen. Penandatanganan tidak dibangun sekarang, tapi konfigurasi
  rilis jangan menyulitkan penambahannya nanti. **[keputusan Claude]**

## Fase 0: prototipe tangkap audio (gerbang)

Dukungan Electron untuk audio sistem **belum diverifikasi** di kedua OS. Kandidat
awal: `session.setDisplayMediaRequestHandler` dengan `audio: 'loopback'`.
Dukungannya di macOS perlu dicek terhadap versi Electron terbaru.

Sekarang prototipe hanya bisa dijalankan di Windows. Gerbang Windows membuka
pengerjaan versi Windows. Gerbang macOS tetap berlaku dan dijalankan sebelum
pengerjaan khusus macOS dimulai, pada build yang ditandatangani dengan cara yang
sama seperti rilisnya, karena izin macOS terikat ke tanda tangan aplikasi.
**[keputusan Claude]**

Prototipe bersifat sekali pakai dan tidak dibawa ke kode produk. Lulus di
masing-masing OS bila, dalam panggilan sungguhan selama 30 menit di Zoom atau
Teams desktop:

- track audio komputer memuat suara peserta lain;
- track mikrofon terpisah dan memuat suara user;
- aplikasi meeting tetap terdengar normal, tanpa bisu dan tanpa feedback;
- selisih waktu kedua track di akhir rekaman kurang dari sekitar 1 detik;
- alur izin OS berhasil, termasuk setelah aplikasi dibuka ulang.

Hasil berikut dicatat sebagai temuan, bukan syarat lulus: seberapa banyak suara
speaker bocor ke mikrofon tanpa headset, dan apakah STT mengarang teks pada
potongan mikrofon yang sunyi.

Bila macOS gagal, jangan langsung mengganti teknologi. Bandingkan dulu helper
native kecil (ScreenCaptureKit atau Core Audio Tap) yang mengirim audio ke
Electron. Perangkat audio virtual tidak diterima karena user harus memasangnya
sendiri. Keputusan ini kembali ke user sebelum fase berikutnya.

## Hasil Fase 0 (Windows, 2026-11-05)

User meminta pengujian tiruan karena tidak memiliki semua aplikasi meeting. **[user]**
Panggilan sungguhan diganti rekaman 30 menit di Windows dengan bunyi uji 1 kHz dari
speaker setiap 30 detik, memakai Electron 45.2.3 dan
`setDisplayMediaRequestHandler` dengan `audio: 'loopback'`.

Terbukti:

- Audio komputer tertangkap: 60 dari 60 slot bunyi uji memuat nada yang kuat.
- Track mikrofon terpisah dan tidak punya jeda sunyi digital. Detektor menemukan 56
  dari 60 bunyi; empat sisanya tetap memuat nada, tapi di bawah ambang deteksi.
- Selisih waktu kedua track stabil 0,02 sampai 0,03 detik dari menit 2,5 sampai
  menit 29,5. Beberapa pasangan lain menyimpang karena suara lain di komputer dan
  ruangan, bukan karena drift.
- Track audio tetap hidup setelah track video dihentikan.
- Aplikasi berjalan lagi setelah dibuka ulang, tanpa dialog izin.

Belum terbukti, dan menjadi syarat uji di Task 11:

- Aplikasi meeting sungguhan tetap terdengar normal, tanpa bisu dan feedback.
- Suara orang sungguhan dari aplikasi meeting tertangkap.

Temuan:

- Tanpa headset, suara speaker bocor kuat ke mikrofon. Nada median di mikrofon sekitar
  seperlima energi nada di audio komputer, jadi baris dobel berlabel "You" memang akan
  terjadi tanpa headset.
- Teks karangan STT pada potongan sunyi belum diuji karena tidak ada server STT.
  Potongan mikrofon dengan puncak di bawah 0,01 selalu dilewati. **[keputusan Claude]**
- `ffmpeg` melaporkan satu `Error parsing Opus packet header` per file, tapi file tetap
  terbaca sepanjang rekaman. Posisinya belum dipastikan, dan pemutaran file diuji di
  Task 11.
- Saat loopback aktif, `getDisplayMedia` butuh user gesture. Mulai rekam dari shortcut
  dan tray harus menyediakannya.

Keputusan: gerbang Windows dibuka dengan dua hal yang belum terbukti di atas.
Bila gagal di Task 11, keputusan kembali ke user sebelum rilis.

## Perilaku produk

### Merekam

- Tombol Rekam dan Stop manual, ditambah shortcut global. **[usulan disetujui]**
- Indikator merekam selalu terlihat: ikon tray berubah dan status tampil di
  jendela. **[keputusan Claude]**
- Menutup jendela saat merekam tidak menghentikan rekaman: aplikasi turun ke tray.
  Keluar dari aplikasi saat merekam meminta konfirmasi. **[keputusan Claude]**
- Saat pertama kali dipakai, tampilkan pengingat bahwa izin peserta meeting
  menjadi tanggung jawab user. **[keputusan Claude]**
- Mikrofon nyala secara bawaan, berbeda dari ekstensi, karena label "You"
  membutuhkannya. Bisa dimatikan sebelum merekam. Bila izin ditolak atau perangkat
  tidak ada, rekaman jalan dengan audio komputer saja dan menampilkan peringatan.
  **[keputusan Claude]**
- Tombol dan shortcut mute di aplikasi, bisa dipakai saat merekam, dengan status
  yang selalu terlihat. **[user]** Aplikasi tidak bisa membaca status mute di Zoom
  atau Teams, jadi UI memberi tahu bahwa mute di aplikasi meeting tidak menghentikan
  rekaman mikrofon. **[keputusan Claude]**
- Audio bawaan, video layar opsional dengan preset ekstensi (720p, 10 fps, VP9).
  User memilih layar atau jendela. **[usulan disetujui]**
- Tidak ada id dari URL: id meeting adalah `desktop-<baseTime>`, judul bawaan
  berupa tanggal dan jam, dan judul bisa diubah. Tiap rekaman menjadi satu entri
  Riwayat. **[keputusan Claude]**

### Transkrip

- Otomatis setelah Stop. Bisa diulang lewat "Transkrip ulang". **[keputusan Claude]**
- Tiap track dikirim ke STT secara terpisah, sehingga prosesnya lebih lama daripada
  di ekstensi. Hasilnya diberi label lalu diurutkan menurut waktu.
- Tanpa headset, suara peserta bisa bocor ke mikrofon dan muncul dobel berlabel
  "You". Keterbatasan ini diterima dan ditampilkan sebagai petunjuk di UI.
  **[usulan disetujui]**
- Potongan mikrofon yang sunyi tidak dikirim ke STT bila prototipe menunjukkan STT
  mengarang teks di situ. Ambang dipilih builder. **[keputusan Claude]**

### MoM dan ekspor

- Generate MoM, Copy, dan Unduh `.txt`/`.md` sama seperti ekstensi.
- "Kirim ke Gemini/ChatGPT" menjadi: salin prompt ke clipboard lalu buka situsnya
  di browser default. Tanpa injeksi dan tanpa kirim otomatis. **[keputusan Claude]**
- Unduh rekaman menghasilkan satu file per meeting. **[user]** Isinya campuran suara
  semua orang. **[keputusan Claude]**

### Penyimpanan

- Semua data tinggal di komputer user, kecuali audio ke endpoint STT dan transkrip
  ke LLM. **[usulan disetujui]**
- Rekaman disimpan 5 terakhir, sama seperti ekstensi. **[keputusan Claude]**
- API key dienkripsi dengan `safeStorage` Electron. Ekspor backup tetap memuat key
  dalam teks polos dan harus diperingatkan di UI, seperti ekstensi.
  **[keputusan Claude]**

## Catatan teknis untuk builder

Hal berikut ditemukan dari membaca kode dan mudah terlewat.

**Yang bisa dipakai ulang.** `lib/merge.js`, `lib/stt.js`, `lib/openai.js`,
`lib/audiostore.js`, dan `lib/ui.js` tidak memakai API `chrome.*`.
`lib/backup.js` memakai `chrome.storage.local`.

**Panel.** `panel/panel.js` memakai `chrome.storage`, `chrome.runtime`, dan
`chrome.permissions`, dan memuat teks serta setelan khusus Meet (Sumber transkrip,
sembunyikan caption, bahasa caption). Dua pendekatan yang wajar: shim kecil untuk
API `chrome.*` plus penanda platform, atau memisahkan bagian yang sama. Pilihan
diserahkan ke builder. Bug `sttModel` di `panel.js` diperbaiki dulu di proyek
pembersihan ekstensi, supaya tidak ikut terbawa.

**CORS.** Ekstensi lolos CORS berkat izin host, sedangkan renderer Electron tidak.
Banyak server Whisper lokal tidak mengirim header CORS. Panggilan STT dan LLM,
termasuk Tes koneksi, harus lewat proses main. `webSecurity: false` tidak boleh
dipakai. `lib/openai.js` memakai `globalThis`, jadi bisa dimuat lewat import
side-effect seperti di test.

**Keamanan Electron.** `contextIsolation` dan `sandbox` aktif,
`nodeIntegration` mati, CSP ketat, dan preload hanya membuka API yang sempit.

**Jangan putar balik audio.** `offscreen.js` menyambung sumber ke `destination`
karena `tabCapture` membisukan tab. Loopback tidak membisukan apa pun, jadi menyalin
baris itu menghasilkan feedback.

**Tiga recorder audio.** Semuanya memakai `baseTime` yang sama:

- campuran suara, untuk unduhan: satu recorder berjalan terus dengan timeslice 60
  detik, seperti recorder video di `offscreen.js`, supaya hasilnya satu file;
- audio komputer, untuk STT: berotasi tiap 10 menit;
- mikrofon, untuk STT: berotasi tiap 10 menit.

Konsekuensi file campuran **[keputusan Claude]**: crash kehilangan paling banyak
sekitar 1 menit terakhir, sedangkan part yang gagal tersimpan bisa merusak sisa
file setelahnya. Potongan STT terpisah sehingga "Transkrip ulang" tidak terdampak.
ffmpeg tidak dipakai.

Recorder mikrofon membaca node Web Audio yang dibuat sejak awal dan sunyi sampai
mikrofon tersambung, supaya slot waktunya tetap sejajar walau izin diberikan
belakangan. Mute menutup gain mikrofon sebelum masuk ke track mikrofon dan campuran,
tanpa menghentikan recorder dan tanpa mengubah slot waktu. Suara selama mute tidak
boleh masuk ke rekaman, STT, maupun MoM.

**`lib/audiostore.js`.** Tiga prefix baru (campuran dan dua track STT) dan
counter-nya bersifat aditif. `PART_NEW`
wajib ikut mengenalinya, karena `pruneTargets` menghapus lewat `rec.keys`, dan key
yang tak dikenali menjadi yatim yang tidak pernah terhapus. Ekstensi tidak boleh
berubah perilakunya.

**`lib/merge.js`.** Tidak perlu diubah untuk dua track: gabungkan hasil
`mergeSttChunks` kedua track, isi `speaker`, lalu kirim ke `replaceAudioSegments`
sebagai satu grup rekaman. "Transkrip ulang" pun mengganti kedua track sekaligus.

**Transkrip ulang tidak boleh memperburuk hasil.** Penjaga di `transcribeChunks`
hanya mengecek "ada teks". Dengan dua track, mikrofon yang berhasil dan audio
komputer yang gagal total akan lolos dan menghapus baris "Others" yang masih bagus.
Penjaganya harus per track.

**Selama rekaman berjalan.** Pakai `backgroundThrottling: false`, karena rotasi
memakai `setInterval` dan jendela bisa tersembunyi di tray. Pakai
`powerSaveBlocker`. Bila track berakhir (headset dicabut), tampilkan peringatan dan
pertahankan rekaman yang lain.

**Kuota.** Ekstensi memakai izin `unlimitedStorage`, Electron tidak punya izin itu.
Pastikan rekaman video panjang muat di kuota IndexedDB; bila tidak, simpan rekaman
sebagai file di `userData`.

**Penyimpanan transkrip.** Harus muat transkrip tanpa batas jumlah dan selamat dari
crash. `localStorage` tidak cukup.

## Urutan kerja

1. Pembersihan ekstensi: penyederhanaan kode, pemeriksaan tipe, dan perbaikan bug.
   Proyek terpisah. Penyederhanaan sudah ada di branch `rewrite-compact`, belum
   diuji di browser dan belum di-merge.
2. Publikasi ke Chrome Web Store dan Edge Add-ons. Proyek terpisah, memakai akun
   milik user.
3. Fase 0: prototipe di Windows.
4. Aplikasi desktop versi Windows.
5. Fase 0 dan penyesuaian macOS, begitu ada Mac.

Urutan dasarnya **[usulan disetujui]**, dan pemisahan Windows lalu macOS mengikuti
jawaban user soal Mac. Fase 0 tidak perlu menunggu publikasi
store, karena hasilnya bisa mengubah seluruh proyek desktop. **[keputusan Claude]**

Target awal versi OS: Windows 10 ke atas, dan macOS 14.2 ke atas di Apple Silicon
dan Intel. Angka final ditetapkan setelah Fase 0. **[keputusan Claude]**

## Pengujian

- `node --test test/*.test.mjs` tetap lulus tanpa perubahan perilaku ekstensi.
- Logika baru yang murni (label track, penjaga per track, prefix audiostore) punya
  test `node --test`.
- Sebelum rilis per OS: panggilan sungguhan pada OS itu di satu aplikasi meeting desktop
  yang dimiliki user. **[user]**
  Versi macOS tidak dirilis sebelum lulus uji ini.
- Mute diuji dalam panggilan sungguhan: bicara saat mute tidak boleh muncul di file
  unduhan, track mikrofon, maupun transkrip.

## Diserahkan ke builder

Struktur file di `desktop/`, cara berbagi UI panel, ambang sunyi, penyimpanan
transkrip, pilihan shortcut global, dan rincian tray.
