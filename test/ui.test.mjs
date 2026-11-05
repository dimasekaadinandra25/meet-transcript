import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = {
  addEventListener() {},
  querySelectorAll: () => [],
  createElement: () => ({ dataset: {}, setAttribute() {} }),
  body: { classList: { toggle() {}, remove() {} } },
};
globalThis.addEventListener = () => {};
await import('../lib/ui.js');
const { shortcutFor } = globalThis.MeetUi;

test('tiap tombol mendapat shortcut dari labelnya', () => {
  const expected = {
    Live: '1', Riwayat: '2', Settings: '3', '← Riwayat': 'B', Copy: 'C', 'Copy transkrip': 'T', 'Copy Prompt+Transkrip': 'P',
    'Generate MoM': 'M', 'Regenerate MoM': 'M', 'Tempel ke Gemini': 'G', 'Tempel ke ChatGPT': 'C',
    'Salin & buka Gemini': 'G', 'Salin & buka ChatGPT': 'C', Unduh: 'U', 'Unduh .txt': 'T', 'Unduh .md': 'M',
    'Unduh rekaman — 14:00': 'R', 'Unduh audio (3 file)': 'A', 'Unduh video': 'V', Hapus: 'X',
    'Generate transkrip': 'T', 'Transkrip ulang': 'T', 'Transkrip audio': 'T', 'Stop rekam': 'S',
    'Bisukan mikrofon': 'N', 'Nyalakan mikrofon': 'N', 'Rekam audio': 'R', 'Rekam audio + video': 'V', Mengerti: 'O',
    'Izinkan mikrofon': 'Z', 'Tes koneksi': 'K', Simpan: 'S', 'Export backup (.zip)': 'X', 'Import backup': 'I',
    Rekam: 'R', 'Audio saja': 'A', 'Audio + video': 'V', Mikrofon: 'M', 'Mikrofon  ✓': 'M', 'Bahasa caption': 'B',
    Indonesia: 'I', 'Indonesia  ✓': 'I', English: 'N', 'Tampilkan detail': 'T', 'Riwayat meet': '2', 'Lihat semua (12)': 'L',
  };
  for (const [label, key] of Object.entries(expected)) assert.equal(shortcutFor(label), key, label);
});

test('tombol dengan isi bebas tidak mendapat shortcut', () => {
  assert.equal(shortcutFor('Rapat mingguan produk'), undefined);
});

test('shortcut tidak memakai tombol milik menu Chrome', () => {
  for (const label of ['Copy', 'Unduh', 'Hapus', 'Simpan', 'Export backup', 'Import backup', 'Rekam audio']) {
    assert.ok(!['D', 'E', 'F'].includes(shortcutFor(label)), label);
  }
});
