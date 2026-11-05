globalThis.MeetI18n.follow().catch(() => {});
const msg = document.getElementById('msg');
navigator.mediaDevices.getUserMedia({ audio: true }).then(
  (s) => { s.getTracks().forEach((t) => t.stop()); return true; },
  () => false,
).then((granted) => {
  msg.textContent = granted
    ? 'Microphone allowed ✓ This window closes by itself.'
    : 'Microphone permission denied. Recording continues without your microphone. '
      + 'Try again from Settings → "Allow microphone", or check chrome://settings/content/microphone.';
  chrome.runtime.sendMessage({ type: 'mic-permission', granted }).catch(() => {});
  setTimeout(() => chrome.windows.getCurrent().then((w) => chrome.windows.remove(w.id)).catch(() => {}),
    granted ? 500 : 4000);
});
