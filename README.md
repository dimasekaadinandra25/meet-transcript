# 🎙️ Transcripables

<p align="center">
  <img src="icons/icon128.png" width="112" alt="Transcripables">
</p>

Bahasa: Indonesia | [English](README.en.md)

**Ekstensi Chrome untuk Transkripsi Google Meet, Rekaman Meeting Web (Teams, Webex, Slack, Discord, Zoom) & Pembuatan Notulen (MoM) Otomatis**

---

**Transcripables** adalah ekstensi Google Chrome yang terintegrasi langsung pada *side panel* Google Meet. Ekstensi ini menangkap transkrip caption secara *real-time* selama rapat berlangsung dan secara otomatis merangkumnya menjadi *Minutes of Meeting* (MoM). Rekaman audio ditranskrip setelah perekaman dihentikan (mode *Record audio*) atau kapan pun Anda menekan **Generate transcript**.

Selain Google Meet, **Microsoft Teams web**, **Webex web app**, **huddle Slack di peramban**, **panggilan suara Discord di peramban** (`discord.com/channels/…`), dan **meeting Zoom di web client** (`zoom.us/wc/…`) juga dapat direkam. Di platform-platform itu ekstensi tidak membaca *caption*: rekamannya disimpan sebagai arsip, dan transkripnya dibuat lewat STT hanya bila Anda menekan **Generate transcript** di Riwayat — tanpa nama pembicara, dan perekaman berhenti saat Anda menekan Stop atau menutup tab yang direkam.

Seluruh data rapat disimpan secara lokal di peramban (*browser*) Anda. Tanpa server perantara, dan Anda memiliki kendali penuh atas *endpoint* STT (Speech-to-Text) maupun LLM (Large Language Model) yang digunakan — termasuk *server* Whisper di jaringan Anda sendiri. Baca bagian [Keamanan & Privasi](#-keamanan--privasi) untuk mengetahui persis data apa yang keluar pada tiap mode.

## ✨ Fitur Utama

* **Popup Aksi Cepat:** Klik ikon ekstensi membuka popup ringkas — **Record** (audio / audio + video), **Microphone** (centang on/off), **Caption language** (Indonesia / English), **Show details** (membuka side panel), dan **History** yang membuka rapat pilihan langsung di halaman detailnya.
* **Multi-Sumber Transkripsi:** Dengan **Transcript source** = *Record audio*, *caption* bawaan Google Meet (menyertakan nama pembicara) dan rekaman audio *tab* (via STT) digabung dalam satu linimasa rapat, diurutkan menurut waktu.
* **Rekam Video (Opsional):** Rekam isi *tab* Meet sebagai satu fail `.webm` (720p, VP9, ±250 MB/jam) lewat menu klik kanan **Record meeting audio + video**. Di mode *Meet captions* rekaman ini hanya arsip — transkrip tetap dari caption, audionya tidak dikirim ke STT kecuali Anda menekan **Generate transcript**.
* **Rekam Mikrofon (Opsional):** Bawaan hanya suara peserta lain (audio *tab*) yang terekam. Nyalakan **Microphone** dari popup ikon — atau centang **Record microphone** di Settings, keduanya kunci yang sama — agar suara Anda ikut dicampur ke rekaman audio dan video; izin mikrofon diminta sekali lewat jendela kecil. Dapat dinyalakan **di tengah rekaman**: mic langsung bergabung tanpa memutus rekaman yang sedang jalan (bagian sebelum itu tetap tanpa mic). Mematikannya di tengah rekaman tidak bisa — hentikan rekamannya dulu.
* **Endpoint STT Milik Anda:** Arahkan ke *server* Whisper pribadi (whisper.cpp, faster-whisper) di jaringan sendiri, atau ke *endpoint* Online speech-to-text service mana pun yang OpenAI-compatible.
* **Pembuatan MoM Otomatis:** Menghasilkan *context*, *discussion*, peserta, dan *action items* menggunakan *endpoint* LLM yang kompatibel dengan OpenAI (misal: `gpt-4o-mini`). *Template* dapat dikustomisasi.
* **Fleksibilitas Tanpa API Key:** Anda dapat menyalin *prompt* beserta transkrip ke *clipboard*, atau mengirimkannya secara otomatis ke Google Gemini atau ChatGPT di *tab* baru tanpa memerlukan integrasi API.
* **Manajemen Riwayat Lokal:** Transkrip, MoM, dan setelan tersimpan di `chrome.storage.local`; potongan audio di IndexedDB. Ekspor riwayat ke `.txt` atau `.md` kapan saja.
* **Backup & Restore:** Tombol **Export backup (.zip)** di Settings menyimpan data teks (riwayat, MoM, setelan) ke satu fail ZIP — **bukan** fail rekaman: audio & video tidak ikut karena bisa ratusan MB per rekaman, unduh sendiri dari entri Riwayat → **Download**. **Import backup** memulihkan data teks itu — termasuk setelah *uninstall*/pindah komputer — dan **menghapus rekaman yang tersimpan saat itu**.
* **Sadar Rapat Berulang:** Rapat *recurring* memakai link (kode ruang) yang sama — setiap sesi tetap menjadi entri Riwayat terpisah. Jeda lebih dari 30 menit setelah rapat berakhir dianggap sesi baru; keluar-masuk sebentar tetap tersambung ke sesi yang sama.
* **Penyelamatan Audio Cerdas:** Potongan audio disimpan ke IndexedDB selama proses perekaman. Jika terjadi kesalahan konfigurasi STT, Anda cukup melakukan "Transkrip ulang" tanpa kehilangan data audio.
* **Transkrip Audio Manual:** Rekaman yang tidak ditranskrip otomatis (Meet bermode *Meet captions*, Teams, Webex, Slack, Discord, Zoom) menampilkan tombol **Generate transcript** di Riwayat selama audionya masih tersimpan. Tanpa audio tersimpan, tombol itu tidak muncul. Baris audio yang hampir sama dengan caption di dekatnya tidak ditambahkan, jadi caption dan nama pembicaranya tetap ada. Bila semua baris sama, panel memberi tahu dan transkrip tidak berubah.
* **Siklus Hidup Otomatis (Google Meet):** Perekaman berhenti otomatis saat rapat selesai (keluar panggilan, pindah ruang, atau *tab* rekaman ditutup). Menutup *tab* lain yang ikut bergabung ke ruang yang sama tidak menghentikan rekaman.
* **Caption Tersembunyi (Bawaan):** Tampilan caption di layar Meet disembunyikan tanpa mematikan CC — tile video tetap penuh, transkrip tetap terisi di panel. Ingin melihat caption lagi? Matikan **Hide captions on the Meet screen** di Settings.
* **Bahasa Caption dari Popup:** Pemilih bahasa milik Meet berada di dalam area caption, jadi ikut tersembunyi oleh butir di atas. Pilihan **Indonesia** (bawaan) / **English** di popup menerapkannya langsung ke Meet, sekali tiap panggilan — pergantian manual di UI Meet tetap dihormati.
* **Rekam Discord Web:** Panggilan suara di `discord.com/channels/…` ikut bisa direkam (audio, atau audio + video tab). Hanya versi web — aplikasi desktop Discord di luar jangkauan ekstensi.
* **Rekam Zoom Web:** Meeting di web client Zoom (`zoom.us/wc/<id>/join`, `/start`, atau bentuk lama `/wc/join/<id>`) ikut bisa direkam — termasuk `app.zoom.us` dan subdomain *vanity* perusahaan. Mulai rekam dari **popup ikon**, menu klik kanan, atau pintasan `Alt+Shift+R` / `Alt+Shift+V`. Link `zoom.us/j/<id>` bukan halaman web client — ia meluncurkan aplikasi desktop, yang audionya tidak ada di tab. Zoom for Government (`zoomgov.com`) di luar cakupan.
* **Rekam Teams, Webex, dan Slack Web:** Mulai rekam dari **popup ikon**, menu klik kanan, atau pintasan `Alt+Shift+R` / `Alt+Shift+V`. URL tab harus memuat id rapat:
  * **Teams** (`teams.microsoft.com`, `teams.live.com`, `teams.cloud.microsoft`): id thread `19:meeting_…@thread.v2` (di hash web client, link undangan `/l/meetup-join/…`, atau launcher) atau link pendek `/meet/<angka>`. Satu rapat yang dibuka lewat dua bentuk link itu menjadi dua entri Riwayat.
  * **Webex** (`<situs>.webex.com`): `MTID=m<hex>` di link undangan, id hex di halaman *join*, atau *personal room* `/meet/<nama>` / `/join/<nama>`. `web.webex.com` (aplikasi Webex di peramban) belum dikenali.
  * **Slack** (`app.slack.com`): jendela huddle `/huddle/<workspace>/<channel>` atau tampilan channel `/client/<workspace>/<channel>` — huddle tidak punya id sendiri, jadi satu channel/DM = satu entri, seperti Discord.
  * Bentuk URL ketiga platform saat **sudah di dalam panggilan** belum diverifikasi dengan rapat sungguhan. Kalau tombol Rekam menolak, pesannya menyebut URL tab — kirim URL itu agar bentuknya ditambahkan.

---

## 🚀 Panduan Instalasi

Ekstensi ini berjalan pada **Chrome 116+** — termasuk browser Chromium lain (Edge, Brave, Opera, Vivaldi) — dan **Firefox 128+**. Di Chromium dipasang melalui mode *Developer*; di Firefox langsung dari [Firefox Add-ons resmi](https://addons.mozilla.org/en-US/firefox/addon/meet-transcript/). **Versi Firefox caption-only**: tanpa rekam audio/STT, karena Firefox tidak memiliki API `tabCapture`. (Panel samping sendiri sudah ada sejak Chrome 114, tetapi pemulihan status rekaman memakai `chrome.runtime.getContexts` yang baru tersedia di 116.) Tidak memerlukan proses *build* atau instalasi melalui Chrome Web Store.

### Metode 1: Melalui Rilis ZIP (Direkomendasikan)

1. Buka halaman **[Releases](../../releases)** dan unduh aset `transcripables-vX.Y.Z.zip` terbaru. *(Paket ini bersih — hanya fail ekstensi, tanpa docs/test, di bawah 1 MB.)*
2. Ekstrak fail ZIP ke direktori permanen di komputer Anda (hindari folder *Downloads*).
3. Buka URL `chrome://extensions` di Google Chrome (Edge: `edge://extensions`, Brave: `brave://extensions`, Opera: `opera://extensions`).
4. Aktifkan **Developer mode** (sakelar di sudut kanan atas).
5. Klik **Load unpacked**, lalu pilih folder **`transcripables`** di dalam hasil ekstraksi — folder yang isinya langsung `manifest.json`, bukan folder pembungkusnya.
6. Sematkan (*pin*) ikon Transcripables di *toolbar* Anda.

> **Untuk Update:** Unduh ZIP versi terbaru, timpa (*replace*) fail di folder lama, lalu klik ikon **Reload** (🔄) pada kartu ekstensi di halaman konfigurasi.

### Metode 2: Melalui Git Clone (Untuk Developer)

```bash
git clone https://github.com/dimasekaadinandra25/transcripables.git
```

Buka `chrome://extensions` → **Load unpacked** → pilih folder hasil *clone*. Untuk memperbarui ekstensi, jalankan perintah `git pull`, lalu klik **Reload**.

> [!NOTE]
> Peringatan "Disable developer mode extensions" yang muncul saat Chrome dijalankan adalah perilaku normal untuk ekstensi di luar Web Store. Anda dapat mengabaikannya. Jangan klik "Remove".

### Firefox

Pasang langsung dari Add-ons resmi Mozilla: **[Transcripables di Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/meet-transcript/)** (listing mungkin masih bernama Meet Transcript) → klik **Add to Firefox**. Update berjalan otomatis. Setelah terpasang, klik ikon Transcripables di *toolbar* untuk membuka/menutup *sidebar*.

> [!NOTE]
> Versi Firefox **caption-only**: fitur Perekaman Audio & Mode STT di bawah tidak tersedia (Firefox tidak punya API `tabCapture`). Transkrip dari *caption*, Riwayat, MoM, dan Paste into Gemini/ChatGPT berfungsi penuh.
>
> Untuk pengembangan: salin folder repo, di salinan itu timpa `manifest.json` dengan isi `manifest.firefox.json`, lalu muat via `about:debugging` → *This Firefox* → *Load Temporary Add-on* (hilang saat Firefox ditutup).

---

## 🖥️ Aplikasi Desktop (Windows)

Aplikasi desktop merekam audio komputer dan mikrofon, jadi berfungsi untuk aplikasi meeting apa pun yang suaranya keluar lewat speaker atau headset, termasuk Zoom, Teams, Slack, Webex, Discord, dan WhatsApp desktop. Hasilnya: transkrip berlabel **You** dan **Others**, MoM, dan satu file rekaman per meeting. Bila layanan STT Anda mengembalikan pembicara, **Others** menjadi **Speaker A**, **Speaker B**, dan seterusnya. Dukungan macOS belum selesai: pengaturan build sudah ada, tetapi belum pernah dijalankan di Mac.

### Instalasi

1. Jalankan `Transcripables-Setup-X.Y.Z.exe`.
2. Windows SmartScreen memperingatkan installer yang belum ditandatangani. Pilih **More info**, lalu **Run anyway**.

**Di Mac:** unduh `.dmg` sesuai chip Anda (`arm64` untuk Apple Silicon, `x64` untuk Intel). Karena belum ditandatangani, macOS memblokir saat pertama dibuka: buka **System Settings > Privacy & Security** lalu pilih **Open Anyway**. Bila macOS bilang aplikasi rusak, jalankan `xattr -cr /Applications/Transcripables.app`. Izinkan mikrofon dan perekaman layar saat diminta. Merekam suara komputer perlu macOS 14.2 atau lebih baru. Belum ada yang merekam rapat sungguhan di Mac.

3. Buka **Settings** dan isi endpoint LLM untuk MoM. Speech-to-text memakai mesin bawaan secara default, jadi tidak perlu server atau internet.

Untuk membangun installer sendiri: `npm --prefix desktop install`, lalu `npm --prefix desktop run dist`. Perintah ini mengunduh mesin suara, memeriksa SHA-256-nya, mengompilasi pembantu suara per aplikasi dengan `g++`, dan menyimpan installer di `desktop/dist/`. Di Mac, pakai `dist:mac`, yang mengompilasi mesin suara dan memerlukan `cmake` serta Xcode command line tools.

**Code signing:** installer belum ditandatangani karena proyek ini belum punya sertifikat. Dengan file `.pfx`, isi `WIN_CSC_LINK` dan `WIN_CSC_KEY_PASSWORD` sebelum `npm run dist`, lalu electron-builder menandatanganinya. Sertifikat di token perangkat keras atau layanan cloud perlu pengaturan penandatanganan dari penyedianya di pengaturan build `win`.

### Penggunaan

| Aksi | Tombol | Shortcut |
| --- | --- | --- |
| Rekam audio | **Record audio** | `Alt+Shift+A` |
| Rekam audio + video | **Record audio + video** | `Alt+Shift+V` |
| Stop | **Stop recording** | `Alt+Shift+S` |
| Bisukan atau nyalakan mikrofon | **Mute microphone** | `Alt+Shift+M` |

* **Language** di Settings mengganti bahasa aplikasi antara English dan Bahasa Indonesia. Transkrip, MoM, dan judul tidak pernah diterjemahkan, dan huruf shortcut `Alt` sama di kedua bahasa.
* **Import audio file** mengubah berkas audio atau video yang sudah ada menjadi meeting dengan transkrip. Salinan berkualitas suara disimpan bersama rekaman Anda, jadi ▶ dan **Retranscribe** tetap berfungsi. Salinan ini dihitung dalam **Recordings to keep** di Settings.
* Klik kanan ikon tray untuk merekam, berhenti, membisukan, atau membuka folder rekaman tanpa membuka jendela.
* **Check for updates** di Settings mencari rilis GitHub baru dan membuka halaman unduhnya. Tidak memasang apa pun sendiri.
* Setiap tombol juga punya shortcut `Alt` yang berfungsi saat jendela aktif. Tahan `Alt` untuk melihatnya, atau arahkan kursor ke tombol.
* Mute di Zoom atau Teams **tidak** menghentikan rekaman mikrofon aplikasi ini. Pakai mute milik aplikasi. Mikrofon kembali menyala di setiap rekaman baru.
* Transkrip terisi sekitar tiap 2 menit selama meeting, dan selesai saat Stop. Matikan di Settings agar audio hanya dikirim setelah meeting.
* Setiap rekaman juga disimpan ke `Documents/Transcripables`. Menghapus meeting di aplikasi tidak menghapus salinan itu. Matikan di Settings.
* Menutup jendela saat merekam atau mentranskrip membuat proses tetap berjalan di system tray. Ikon tray dan judul jendela menunjukkan statusnya. Peringatan, misalnya mikrofon terputus, memunculkan jendela lagi.
* Secara bawaan, semua suara di speaker komputer ikut terekam, termasuk notifikasi dan aplikasi lain. Di Windows, menu suara di samping **Record audio** merekam satu aplikasi saja, misalnya Zoom. Aplikasi muncul di sana setelah pernah memutar suara. Fitur ini perlu versi Windows yang baru, dan macOS selalu merekam semua suara komputer.
* Tanpa headset, suara peserta bisa bocor ke mikrofon. Baris yang mengulang suara komputer dalam sekitar 5 detik dihapus. Jawaban pendek dan baris yang terdengar berbeda masih bisa muncul sebagai **You**.
* Minta izin peserta meeting sebelum merekam.

### Keterbatasan

* Bila aplikasi crash, file rekaman bisa kehilangan sekitar 1 menit terakhir, dan transkrip bisa kehilangan sampai 2 menit terakhir.
* API key dienkripsi di komputer. **Export backup** tidak menyertakannya kecuali Anda mencentang **Include API keys**, yang menyimpannya dalam teks polos. Memulihkan cadangan tanpa key mempertahankan key yang Anda punya sekarang hanya bila cadangan memakai alamat server yang sama, jadi cadangan tidak pernah bisa mengirim key Anda ke tempat lain.
* Template MoM bawaan meminta LLM menulis dalam bahasa utama meeting, termasuk judul bagiannya. Template yang sudah Anda ubah tetap seperti yang Anda tulis.
* Server LLM lokal seperti Ollama dan LM Studio tidak memerlukan API key. Key hanya wajib untuk alamat default OpenAI.
* **Ask** pada meeting mengirim pertanyaan dan transkrip ke layanan AI Anda. Jawaban disimpan bersama meeting, dan tidak ikut diekspor.
* **Mark moment** (`Alt+Shift+K` di aplikasi desktop dan Chrome) menandai poin penting. Tanda muncul di transkrip dan di ekspor `.txt`, `.md`, `.docx`, dan PDF, dan prompt MoM memprioritaskannya.
* Tombol ▶ pada baris memutar momen itu dari rekaman, selama rekamannya masih tersimpan.
* **Download** juga menyediakan subtitle `.srt` dan `.vtt`. **MoM type** di Settings menyediakan Standard, Standup, Client call, dan 1-on-1.
* **Delete meetings older than** di Settings menghapus meeting lama beserta rekamannya saat aplikasi dimulai. Nonaktif secara default, dan salinan di `Documents/Transcripables` tetap ada.
* Di ekstensi, ikon menampilkan **!** saat caption mati atau hening, atau saat *Meet captions + recorded audio* belum merekam. Arahkan kursor ke ikon untuk melihat alasannya.
* **Edit transcript** pada meeting yang sudah selesai memungkinkan Anda memperbaiki baris dan mengganti nama pembicara, misalnya **Others** menjadi nama asli, di seluruh meeting. **Retranscribe** mengganti hasil edit teks pada baris dari rekaman itu, dan bertanya dulu. Nama pembicara tetap, tetapi dengan model diarize hurufnya bisa berubah, jadi aplikasi bertanya dulu dan sebaiknya Anda memeriksa namanya setelah itu. Bila satu bagian gagal ditranskrip lagi, baris lamanya dipertahankan.
* **STT language** kosong secara default, jadi bahasa dideteksi otomatis untuk setiap bagian rekaman. Model Whisper pada mesin bawaan mencakup sekitar 100 bahasa. Bila peserta berganti bahasa dalam satu bagian, isi bahasa utama di Settings, misalnya `id` atau `en`. Layanan STT lain mendukung bahasa sesuai modelnya.
* Mesin bawaan dimulai dengan model kecil (`ggml-base-q5_1`). **Built-in engine accuracy** di Settings mengunduh model lebih besar (190 MB atau 540 MB), diperiksa dengan checksum tetap, dan tetap di komputer Anda. Penginstal sudah memuat berkas runtime Microsoft yang dibutuhkan mesin.
* Huruf pembicara berasal dari layanan STT Anda. Dengan model diarize seperti `gpt-4o-transcribe-diarize`, potongan suara pendek dari bagian sebelumnya dikirim bersama bagian berikutnya, jadi **Speaker A** tetap orang yang sama untuk sampai 4 suara. Potongan itu dikirim ke layanan yang sama dengan audionya. OpenAI menghentikan model itu pada 26 Februari 2027 dan belum menyebut pengganti yang memberi label pembicara. Dengan layanan lain, **Speaker A** di satu bagian bisa jadi orang berbeda di bagian berikutnya.

---

## 📖 Penggunaan Dasar (Quick Start)

1. **Mulai Rapat:** Bergabunglah ke Google Meet. Ekstensi akan mencoba mengaktifkan *Closed Captions* (CC) secara otomatis. Caption **tidak tampil di layar** (disembunyikan bawaan) — cek *tab* **Live** di panel untuk memastikan transkrip masuk. Jika kosong, lihat tombol CC di *toolbar* Meet: ikon tersorot berarti aktif; jika tidak, klik sekali.
2. **Buka Panel:** Klik ikon ekstensi → popup muncul → **Show details** membuka *side panel* (Firefox: klik ikon langsung membuka *sidebar*). *Tab* **Live** akan mulai terisi secara otomatis.
3. **Rekam Audio/Video (Opsional):** Klik ikon ekstensi → **Record** → *Audio only* atau *Audio + video*. Bisa juga lewat klik kanan di halaman, atau pintasan `Alt+Shift+R` / `Alt+Shift+V`.
4. **Hasilkan MoM:** Setelah rapat selesai, buka *tab* **History** → pilih rapat → buka dropdown **Generate MoM** → **Generate MoM** (atau **Paste into Gemini** / **Paste into ChatGPT** tanpa API key; Anda memeriksa prompt dan menekan kirim sendiri). Dropdown **Copy** berisi *Copy transcript* / *Copy prompt + transcript*; dropdown **Download** berisi *.txt*, *.md*, dan audio/video rekaman bila ada.

**Konfigurasi Awal (Settings):**
Sebelum penggunaan pertama, isi menu *Settings*: masukkan API Key LLM, pilih Model, dan sesuaikan *Template* MoM (wajib memuat variabel `{{transcript}}` — Simpan memperingatkan bila hilang). Blok **Speech-to-text engine** dipakai untuk transkrip audio — otomatis (Meet bermode *Record audio*) maupun lewat **Generate transcript** (Chrome/Chromium saja — di Firefox blok ini tidak ada). Tombol **Test connection** menguji endpoint LLM, ditambah endpoint STT bila **Transcript source** = *Record audio*. Izin akses ke alamat STT diminta saat Simpan di mode *Record audio*, atau saat pertama kali menekan **Generate transcript** di mode lain.

---

## 🎙️ Perekaman Audio & Mode STT (Chrome/Chromium saja)

Anda dapat merekam audio *tab* dan mentranskripsikannya via STT, baik secara mandiri maupun bersamaan dengan fitur *caption* bawaan Meet. Fitur di seksi ini tidak tersedia di Firefox.

### Cara Merekam Audio

1. Buka menu **Settings** → konfigurasikan **Speech-to-text engine**. Transkrip otomatis saat Stop berjalan di semua situs meeting bila **Transcript source** = *Record audio* atau *Meet captions + recorded audio*. Dengan *Meet captions*, rekaman disimpan sebagai arsip audio/video; buka entrinya di **History** lalu klik **Generate transcript** bila butuh transkrip audionya (tombol hanya muncul selama audionya masih tersimpan).
2. Di dalam panggilan, mulai rekam lewat salah satu dari tiga jalur: **popup ikon ekstensi** → *Record*, **klik kanan** di halaman, atau pintasan keyboard. Pilihan *Audio + video* ikut merekam tampilan *tab* (720p VP9, ±250 MB/jam, diunduh sebagai satu fail `.webm` lewat tombol **Download video** di Riwayat).
3. Di Google Meet, perekaman berhenti otomatis saat Anda keluar panggilan. **Di Teams, Webex, Slack, Discord, dan Zoom tidak** — tidak ada pelacak sesi di sana, jadi rekaman hanya berhenti sendiri bila tab yang direkam ditutup. Selain itu, hentikan sendiri lewat popup, panel, pintasan `Alt+Shift+S`, atau klik kanan → **Stop recording** (Meet/Discord saja). Setelah Stop, status **Saving recording…** (arsip) atau **Transcribing…** (transkrip otomatis) tampil sampai rekaman selesai diproses.

**Catatan Penting:**

* Karena batasan keamanan Chrome, `tabCapture` menuntut izin per-*tab* yang hanya diberikan oleh *invocation* ekstensi: klik ikon (popup), klik *context menu*, atau pintasan keyboard. Tombol di *side panel* maupun tombol yang disuntik ke halaman **tidak** memenuhi syarat itu — Chrome menolaknya dengan *"Extension has not been invoked for the current page"*. Karena itulah tombol **Record** hidup di popup, bukan di panel; panel hanya memegang **Stop recording**.
* Setiap tombol panel dan popup punya shortcut `Alt` saat halamannya aktif, misalnya `Alt+1` sampai `Alt+3` untuk tab. Tahan `Alt` untuk melihatnya, atau arahkan kursor ke tombol. Saat menu terbuka, tombol di menu itu didahulukan.
* Pintasan bawaan: `Alt+Shift+R` (audio), `Alt+Shift+V` (audio + video), `Alt+Shift+S` (stop). Dapat diubah di `chrome://extensions/shortcuts`. Berguna di Discord, yang menelan *event* `contextmenu` sehingga menu klik kanan bawaan peramban tidak muncul (`Shift`+klik kanan memaksanya muncul).
* Bawaan: hanya suara peserta lain (*tab audio*) yang direkam. Centang **Record microphone** di *Settings* agar suara Anda ikut, lalu klik **Allow microphone** sekali untuk memberi izin (kalau belum, jendela izin muncul otomatis saat rekaman dimulai; rekaman *tab* tetap jalan dan mic bergabung begitu disetujui). Tanpa headset, suara peserta dari speaker bisa ikut terekam lewat mic (dobel).
* Setiap 2 menit, potongan audio disimpan ke IndexedDB untuk mencegah kehilangan data jika peramban tertutup mendadak. **Download audio** memberi satu fail `.webm`, atau satu `.zip` bila potongannya lebih dari satu.
* **Meet captions + recorded audio** pada **Transcript source** menjadikan caption sebagai isi utama, dengan nama pembicara. Saat berhenti, rekaman ditranskrip dan hanya baris yang terlewat oleh caption yang ditambahkan, tanpa nama pembicara. Anda tetap perlu menekan **Record** di setiap meeting, karena Chrome hanya mengizinkannya setelah Anda mengklik. Fitur ini memerlukan layanan STT, dan bila STT gagal caption tetap ada. Baris dengan kata berbeda masih bisa muncul dua kali.
* Secara bawaan **5 rekaman terakhir** disimpan. Ubah lewat **Recordings to keep** di Settings, sampai 100. Saat rekaman baru dimulai, rekaman yang lebih lama di luar jumlah itu dihapus — audio beserta videonya.
* **Import audio file** di tab **History** mentranskrip berkas yang sudah ada di Chrome atau Edge memakai layanan speech-to-text Anda. Biarkan panel terbuka sampai potongannya tersimpan. Impor ini tidak bisa dibatalkan di sana.

### Pilihan Mode STT (Speech-to-Text)

| Mode (label di UI) | Kebutuhan | Audio dikirim ke | Deskripsi |
| --- | --- | --- | --- |
| **Built-in (on this computer)** | Hanya aplikasi desktop | Tidak ke mana pun: tetap di komputer Anda | **[Default desktop]** Memakai mesin whisper.cpp bawaan |
| **Your own Whisper server** | Server Whisper OpenAI-compatible | URL yang **Anda** isi | **[Default]** Terisi `http://localhost:8080/v1` |
| **Online speech-to-text service** | URL + API Key (**wajib diisi**) | 🌐 Endpoint tersebut | Tercepat. Menyediakan opsi Model & Bahasa STT. |

> [!WARNING]
> Pada mode **Online speech-to-text service**, kalau **Speech-to-text address** dibiarkan kosong, ekstensi jatuh ke *Base URL* LLM Anda dan memakai **API key LLM** — audio rapat akan dikirim ke endpoint chat (default `https://api.openai.com/v1`). Isi Speech-to-text address secara eksplisit.

---

## 🔒 Keamanan & Privasi

Ekstensi ini dirancang dengan pendekatan *privacy-first*:

* **Penyimpanan Lokal:** API Key Anda disimpan secara eksklusif di `chrome.storage.local` perangkat Anda dan tidak pernah dikomit ke repositori. Tidak ada telemetri maupun analitik di dalam ekstensi ini.
* **Whisper Lokal:** audio dikirim ke URL yang **Anda sendiri** isi di *Speech-to-text address* (default `http://localhost:8080/v1`). Ekstensi **tidak** memaksa URL itu benar-benar lokal — pastikan isinya memang server Anda. Bila *Online speech-to-text service key* pernah diisi, nilainya tetap ikut sebagai header `Authorization` walaupun field-nya tersembunyi di mode ini.
* **Transparansi Endpoint:** MoM dihasilkan melalui *endpoint* pilihan Anda. Pastikan *endpoint* yang Anda konfigurasikan sesuai dengan kebijakan keamanan data perusahaan atau tim Anda.
* **Cari:** **History** punya kotak cari untuk judul, transkrip, dan MoM.
* **Word dan PDF:** Menu **Download** menyimpan `.docx` atau PDF sebuah meeting.
* **MoM otomatis:** Opsi di Settings membuat MoM saat transkrip siap. Bawaannya mati karena transkrip dikirim ke LLM tanpa bertanya.
* **Hapus meeting:** Buka rapat di **History** lalu pilih **Delete** untuk menghapus transkrip, MoM, dan rekaman tersimpannya secara permanen. Rapat yang masih berjalan tidak bisa dihapus.
* **Copy Prompt / Paste into Gemini / Paste into ChatGPT:** ketiganya menyalin **seluruh transkrip** ke clipboard, dan tombol Gemini/ChatGPT menempelkannya ke `gemini.google.com` / `chatgpt.com` tanpa mengirimnya. Setelah Anda menekan kirim, seluruh isi rapat masuk ke akun Google/OpenAI Anda. Jangan gunakan untuk rapat yang isinya tidak boleh keluar.
* **Fail Backup:** ZIP hasil **Export backup** memuat seluruh transkrip, dan **API key dalam teks polos hanya bila Anda mencentang Include API keys**. Simpan failnya di tempat yang aman dan jangan dibagikan.

---

## 🛠️ Pemecahan Masalah (Troubleshooting)

* **Transkrip tidak muncul meskipun tombol CC Meet aktif:** (caption sendiri tidak tampil di layar karena disembunyikan bawaan — matikan **Hide captions on the Meet screen** di Settings kalau ingin memastikan secara visual.) Google mungkin telah memperbarui struktur DOM Meet. Ekstensi akan menampilkan peringatan jika *caption* aktif namun teks tidak terbaca selama 30 detik. (Bagi *developer*, perbarui penyeleksi pada `content/selectors.js`).
* **Tab Live menunjuk rapat lama, atau perekaman tidak berhenti sendiri:** Google Meet adalah aplikasi SPA — pindah ruang dan keluar panggilan hanya mengganti URL pada dokumen yang sama. Pelacakan sesi ditangani `content/session.js` (murni, diuji pada `test/session.test.mjs`). Ruang Meet dikenali dalam bentuk `meet.google.com/<kode>`, `/meet/<kode>`, dan `/_meet/<kode>`.
* **Tombol Rekam menolak "Buka halaman ruang … dulu":** URL tab tidak dikenali sebagai halaman rapat. Pesannya menyebut URL tab — kirim URL itu agar bentuknya ditambahkan (lihat daftar bentuk URL di bagian *Fitur Utama*).
* **Transkrip audio kosong / berisi `[transcript failed]`:** Panel menampilkan ringkasan penyebabnya, mis. *"3/14 parts failed to transcribe: HTTP 404 …"*. Periksa URL *endpoint* atau model STT di pengaturan Anda — pastikan alamatnya memang server STT, bukan layanan lain di port yang sama. Setelah diperbaiki, klik **Retranscribe** (atau **Generate transcript** untuk rekaman yang belum pernah ditranskrip) pada riwayat rapat terkait (audio asli masih tersimpan).
* **Caption tetap tampil setelah ekstensi di-*reload*:** *Content script* di *tab* yang sudah terbuka menjadi yatim saat ekstensi dimuat ulang, dan ia sengaja melepas sendiri gaya penyembunyi caption (kalau tidak, caption terkunci tersembunyi dan tak terjangkau Settings). Muat ulang *tab* Meet-nya.
* **Bahasa caption tidak berganti:** Ekstensi mencoba maksimal 3 kali per panggilan lalu berhenti. Kalau Google mengubah struktur pemilih bahasa, perbaiki `langCombobox()`/`langOption()` di `content/selectors.js`.
* **Peringatan "Belum ada suara masuk":** Tanpa opsi **Record microphone**, sistem hanya menangkap suara peserta lain. Jika tidak ada orang lain yang berbicara, maka tidak ada audio yang diproses.
* **Tombol Stop hilang / rekaman tampak berhenti sendiri:** sudah diperbaiki. *Service worker* MV3 mati setelah ±30 detik menganggur, dan status rekaman dulu hanya hidup di memorinya — di luar Meet tidak ada *content script* yang menjaganya hidup, jadi UI kembali ke keadaan "tidak merekam" sementara rekamannya jalan terus. Status sekarang ditanyakan ke dokumen *offscreen* tiap *service worker* bangun. Kalau tombolnya tetap tak muncul, `Alt+Shift+S` selalu bekerja.
* **Log Eror:** Jika terjadi kesalahan pada *side panel*, pesan *error* dan *stack trace* dapat disorot dan disalin langsung dari antarmuka panel.

---

## 💻 Pengembangan (Development)

Proyek ini dibangun tanpa *build step* yang kompleks (tanpa `npm install`), menggunakan JavaScript *vanilla* (Manifest V3) yang dioptimalkan.

**Struktur Direktori:**

* `background/` : *Service worker*, manajemen status, penyimpanan, dan siklus hidup.
* `content/` : Logika injeksi DOM Meet (`selectors.js`, `session.js`, `captions.js`, `captionhide.js`, `captionlang.js`). **Semua** penyeleksi DOM Meet tinggal di `selectors.js` — termasuk pola label bahasa.
* `panel/` : Antarmuka pengguna (*Live*, *History*, *Settings*).
* `popup/` : Popup ikon toolbar (Rekam, Bahasa caption, Riwayat) — satu-satunya permukaan UI yang boleh memulai `tabCapture`.
* `offscreen/` : Modul perekaman audio/video *tab* dan orkestrasi STT (service worker MV3 bisa mati di tengah unggahan panjang).
* `lib/` : Utilitas inti (`openai.js`, `stt.js`, `audiostore.js`/IndexedDB, `merge.js`, `ui.js` — helper DOM yang dipakai panel dan popup).
* `manifest.firefox.json` : manifest untuk build Firefox (`sidebar_action`, *event page*, tanpa `tabCapture`/`offscreen`) — versinya wajib sama dengan `manifest.json`.
* `test/` · `scripts/` · `icons/` · `docs/` : pengujian Node, skrip rilis, ikon, dan catatan desain internal.

**Menjalankan Pengujian (Testing):**

```bash
node --test test/*.test.mjs
```

**Membuat Rilis (Khusus Maintainer):**

1. Samakan `"version"` di `manifest.json`, `manifest.firefox.json`, dan `desktop/package.json`.
2. Commit dan push.
3. Jalankan `git tag vX.Y.Z`, lalu `git push origin vX.Y.Z`.

GitHub Actions lalu menguji semuanya, mentranskrip contoh ucapan asli dengan setiap model mesin, membuat penginstal Windows dan kedua aplikasi macOS, membuka setiap aplikasi hasil build, dan menerbitkannya bersama ZIP Chrome sebagai pre-release. Tandai sebagai rilis terbaru di GitHub setelah Anda mencobanya. **Check for updates** di aplikasi hanya melihat rilis penuh.

**Penandatanganan kode:** build tidak ditandatangani sampai Anda menambahkan sertifikat sebagai secret repositori GitHub. Tidak ada hal lain yang berubah.

| Sistem | Yang dibutuhkan | Secret |
| --- | --- | --- |
| macOS | Akun Apple Developer dan sertifikat Developer ID | `MAC_CSC_LINK` (berkas `.p12` dalam base64), `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Windows | Sertifikat penandatanganan kode berupa berkas `.pfx` | `WIN_CSC_LINK` (base64), `WIN_CSC_KEY_PASSWORD` |

Kebanyakan sertifikat Windows baru kini disimpan di token perangkat keras atau layanan cloud, bukan berkas `.pfx`, dan itu perlu langkah penandatanganan tambahan di `.github/workflows/build.yml`.

Firefox terpisah: `./scripts/pack.sh --firefox` membangun ZIP untuk dikirim ke Mozilla.

---

## 📄 Lisensi

[MIT](LICENSE) © zenmz. Berdasarkan Meet Transcript karya zenmz.
