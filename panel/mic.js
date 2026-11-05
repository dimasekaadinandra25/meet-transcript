const msg = document.getElementById('msg');
navigator.mediaDevices.getUserMedia({ audio: true }).then(
  (s) => { s.getTracks().forEach((t) => t.stop()); return true; },
  () => false,
).then((granted) => {
  msg.textContent = granted
    ? 'Mikrofon diizinkan ✓ — jendela ini menutup sendiri.'
    : 'Izin mikrofon ditolak. Rekaman tetap jalan tanpa suara mikrofon. '
      + 'Ulangi dari Settings → "Izinkan mikrofon", atau cek chrome://settings/content/microphone.';
  chrome.runtime.sendMessage({ type: 'mic-permission', granted }).catch(() => {});
  setTimeout(() => chrome.windows.getCurrent().then((w) => chrome.windows.remove(w.id)).catch(() => {}),
    granted ? 500 : 4000);
});
