const { el, raw, mkBtn, mkDropdown, patchSettings, meetingKey, clearShortcut } = globalThis.MeetUi;
globalThis.MeetI18n.follow().catch(() => {});
const view = document.getElementById('view');

let rec = { recording: false, transcribing: false, error: null };

let tabId = null;

const SVG_NS = 'http://www.w3.org/2000/svg';

function icon(paths, cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  if (cls) svg.setAttribute('class', cls);
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

let captionLang = 'id';

let micOn = false;

const ICON = {
  rekam: () => icon(['M12 6a6 6 0 110 12 6 6 0 010-12z'], 'solid'),
  stop: () => icon(['M7.5 7.5h9v9h-9z'], 'solid'),
  detail: () => icon(['M4 5h16v14H4z', 'M14 5v14']),
  riwayat: () => icon(['M3.5 12a8.5 8.5 0 1 0 17 0 8.5 8.5 0 1 0-17 0', 'M12 7.5V12l3 2']),
  mic: () => icon([
    'M12 4a2.5 2.5 0 0 1 2.5 2.5v4.5a2.5 2.5 0 0 1-5 0V6.5A2.5 2.5 0 0 1 12 4z',
    'M6.5 11a5.5 5.5 0 0 0 11 0',
    'M12 16.5V20',
  ]),
  bahasa: () => icon([
    'M3.5 12a8.5 8.5 0 1 0 17 0 8.5 8.5 0 1 0-17 0',
    'M3.5 12h17',
    'M12 3.5c2.1 2.3 3.2 5.2 3.2 8.5s-1.1 6.2-3.2 8.5c-2.1-2.3-3.2-5.2-3.2-8.5S9.9 5.8 12 3.5z',
  ]),
};

async function setCaptionLang(code) {
  captionLang = code;
  render();
  await patchSettings({ captionLang: code });
}

async function setMic(on) {
  micOn = on;
  render();
  await patchSettings({ mic: on });
  if (on) chrome.runtime.sendMessage({ type: 'enable-mic' }).catch(() => {});
}

function openPanel(panelTab, meetingId) {
  if (panelTab) {
    chrome.runtime.sendMessage({ type: 'open-panel-tab', tab: panelTab, id: meetingId }).catch(() => {});
  }
  if (tabId != null) chrome.sidePanel?.open({ tabId }).catch(() => {});
  window.close();
}

const RIWAYAT_MAX = 8;

async function fillRiwayat(d) {
  const { meetings: ids = [] } = await chrome.storage.local.get('meetings');
  if (!ids.length) {
    d.list.replaceChildren(el('div', 'muted', 'No history yet.'));
    return;
  }
  const top = ids.slice(0, RIWAYAT_MAX);
  const data = await chrome.storage.local.get(top.map(meetingKey));
  d.list.replaceChildren();
  for (const id of top) {
    const m = data[meetingKey(id)];
    if (!m) continue;
    clearShortcut(raw(d.item(m.title || id, () => openPanel('history', id))));
  }
  if (ids.length > top.length) d.item(`See all (${ids.length})`, () => openPanel('history'));
}

function row(label, iconEl, fn) {
  const b = mkBtn(label, fn, view);
  b.prepend(iconEl);
  return b;
}

function render() {
  view.replaceChildren();
  if (rec.transcribing) {
    view.append(el('div', 'muted state', rec.saving ? 'Saving recording…' : 'Transcribing…'));
  } else if (rec.recording) {
    row('Stop recording', ICON.stop(), () => chrome.runtime.sendMessage({ type: 'stop-recording' }));
    view.append(el('div', 'recording state', 'Recording'));
  } else {
    const d = mkDropdown(view, 'rec', 'Record', { cls: 'inline' });
    d.head.prepend(ICON.rekam());
    const start = (video) => chrome.runtime.sendMessage({ type: 'start-active-tab-recording', video });
    d.item('Audio only', () => start(false));
    d.item('Audio + video', () => start(true));
  }
  row(micOn ? 'Microphone  ✓' : 'Microphone', ICON.mic(), () => {
    if (micOn && rec.recording) {
      rec = { ...rec, error: 'The microphone cannot be turned off during a recording. Stop recording first.' };
      render();
      return;
    }
    setMic(!micOn);
  });
  const l = mkDropdown(view, 'bahasa', 'Caption language', { cls: 'inline' });
  l.head.prepend(ICON.bahasa());
  for (const [code, label] of globalThis.MeetUi.CAPTION_LANGUAGES) {
    l.item(code === captionLang ? label + '  ✓' : label, () => setCaptionLang(code));
  }
  row('Show details', ICON.detail(), () => openPanel());
  if (rec.error) view.append(el('div', 'err', rec.error));
  view.append(el('div', 'sep'));
  const h = mkDropdown(view, 'riwayat', 'History', { cls: 'inline' });
  h.head.prepend(ICON.riwayat());
  h.list.append(el('div', 'muted', 'Loading…'));
  const menu = h.head.parentElement;
  let filled = false;
  const fill = () => {
    if (!menu.open || filled) return;
    filled = true;
    fillRiwayat(h);
  };
  menu.addEventListener('toggle', fill);
  fill();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'rec-state') return;
  rec = { recording: msg.recording, transcribing: msg.transcribing, saving: !!msg.saving,
    error: 'error' in msg ? msg.error : rec.error };
  render();
});

render();
chrome.tabs.query({ active: true, currentWindow: true })
  .then(([t]) => { tabId = t?.id ?? null; })
  .catch(() => {});
chrome.storage.local.get('settings').then((d) => {
  captionLang = d.settings?.captionLang ?? 'id';
  micOn = !!d.settings?.mic;
  render();
}).catch(() => {});
chrome.runtime.sendMessage({ type: 'get-active' }).then((d) => {
  if (!d?.rec) return;
  rec = { ...rec, recording: d.rec.recording, transcribing: d.rec.transcribing,
    saving: d.rec.transcribing && d.rec.autoStt === false };
  render();
}).catch(() => {});
