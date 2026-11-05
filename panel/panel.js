const M = globalThis.MeetMerge;
const view = document.getElementById('view');
let tab = 'live';
let viewingId = null;
let status = { id: null, inCall: false, captionsOn: false, lastSegmentAt: 0, captionsOnAt: 0 };
let recState = { recording: false, transcribing: false, saving: false, done: 0, total: 0, error: null };

const busyLabel = () => (recState.saving ? 'Saving recording…'
  : recState.total ? `Transcribing… ${recState.done}/${recState.total}` : 'Transcribing…');

const HAS_AUDIO = !!chrome.tabCapture;
const Host = globalThis.PanelHost;

let settingsCache = {};
async function loadSettings() { settingsCache = (await chrome.storage.local.get('settings')).settings ?? {}; }

const { el, raw, mkBtn, mkDropdown, patchSettings, meetingKey } = globalThis.MeetUi;
const { t } = globalThis.MeetI18n;
const mkEl = (tag, props) => Object.assign(document.createElement(tag), props);
const addOptions = (select, pairs) => {
  for (const [value, textContent] of pairs) select.append(mkEl('option', { value, textContent }));
};
const isShowing = (id) => (tab === 'live' && id === status.id) || (tab === 'history' && id === viewingId);

const badUrl = (m) => Object.assign(new Error(m), { invalidUrl: true });
async function ensureOrigins(bases) {
  const patterns = [];
  for (const b of bases) {
    let u;
    try { u = new URL(b); } catch { u = null; }
    if (!u || !/^https?:$/.test(u.protocol) || !u.hostname) throw badUrl(`Invalid URL: ${b}`);
    if (u.hostname.startsWith('[') && !Host) {
      throw badUrl(`Chrome does not support IPv6 addresses here: ${b}. Use 127.0.0.1 or a host name.`);
    }
    const p = `${u.protocol}//${u.hostname}/*`;
    if (p !== 'https://api.openai.com/*') patterns.push(p);
  }
  if (!patterns.length) return;
  if (!await chrome.permissions.request({ origins: [...new Set(patterns)] }).catch(() => false)) {
    throw new Error(`Access to ${patterns.join(', ')} was denied.`);
  }
}

function reportError(what, e) {
  let box = document.getElementById('crash');
  if (!box) {
    box = el('div', 'error');
    box.id = 'crash';
    document.body.prepend(box);
  }
  box.textContent = `${what}: ${e?.message || e}\n${e?.stack ?? ''}`;
}

addEventListener('unhandledrejection', (ev) => reportError('Promise failed', ev.reason));
addEventListener('error', (ev) => reportError('Error', ev.error ?? ev.message));

function selectTab(name) {
  tab = name;
  viewingId = null;
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
}

document.querySelectorAll('nav button').forEach((b) =>
  b.addEventListener('click', () => {
    if (b.dataset.tab === tab && tab === 'settings') return;
    selectTab(b.dataset.tab);
    render();
  })
);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'open-panel-tab') {
    selectTab(msg.tab);
    if (msg.id) viewingId = msg.id;
    chrome.runtime.sendMessage({ type: 'panel-tab-consumed' }).catch(() => {});
    render();
    return;
  }
  if (msg.type === 'status') {
    if (msg.id !== status.id) recState.error = null;
    status = msg;
    if (tab === 'live') render();
  } else if (msg.type === 'meeting-updated') {
    if (isShowing(msg.id)) render();
  } else if (msg.type === 'ai-inject') {
    if (msg.ok || !msg.id) return;
    momErrors.set(msg.id, `Could not paste into the AI tab: ${msg.error} The prompt is on your clipboard, so paste it there yourself.`);
    if (isShowing(msg.id)) render();
  } else if (msg.type === 'rec-state') {
    const wasActive = recState.recording || recState.transcribing;
    if (wasActive !== (msg.recording || msg.transcribing)) audioMetaKey = null;
    recState = { recording: msg.recording, transcribing: msg.transcribing, saving: !!msg.saving, muted: msg.muted,
      done: msg.done ?? 0, total: msg.total ?? 0,
      error: 'error' in msg ? msg.error : recState.error };
    if (tab === 'live' || (tab === 'history' && viewingId)) render();
  }
});

async function getMeeting(id) {
  const key = meetingKey(id);
  return (await chrome.storage.local.get(key))[key] ?? null;
}

const safeName = (s) => s.replace(/[\/\\:*?"<>|]/g, '-');

const promptText = (meeting) => M.fillTemplate(
  settingsCache.momTemplate || M.DEFAULT_MOM_TEMPLATE,
  M.formatTranscript(meeting.segments));

function download(name, data) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type: 'text/plain' }));
  a.download = safeName(name);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

async function downloadAudio(meeting, rec, suffix) {
  const saved = await globalThis.MeetAudioStore.loadAudio(rec.recId);
  if (!saved?.blobs?.length) return 0;
  if (saved.meetingId !== meeting.id) return 0;
  saved.blobs.forEach((blob, i) => download(
    saved.blobs.length > 1
      ? `${meeting.title}${suffix}-${String((saved.indices?.[i] ?? i) + 1).padStart(2, '0')}.webm`
      : `${meeting.title}${suffix}.webm`,
    blob));
  return saved.blobs.length;
}

async function downloadVideo(meeting, rec, suffix) {
  const saved = await globalThis.MeetAudioStore.loadVideo(rec.recId);
  if (!saved?.blobs?.length) return false;
  if (saved.meetingId !== meeting.id) return false;
  download(`${meeting.title}${suffix}-video.webm`, new Blob(saved.blobs, { type: 'video/webm' }));
  return true;
}

async function downloadMix(meeting, rec, suffix) {
  const saved = await globalThis.MeetAudioStore.loadMix(rec.recId);
  if (!saved?.blobs?.length || saved.meetingId !== meeting.id) return false;
  download(`${meeting.title}${suffix}.webm`, new Blob(saved.blobs, { type: 'audio/webm' }));
  return true;
}
let renderEpoch = 0;
let lastRenderedKey = null;
let audioMeta = null;
let audioMetaKey = null;
const momErrors = new Map();

const CLICK_HOLD_MS = 1000;
let clickHold = null;
let renderWaiting = false;

function flushRender() {
  if (!renderWaiting) return;
  renderWaiting = false;
  render();
}

function endClickHold() {
  clearTimeout(clickHold);
  clickHold = null;
  setTimeout(flushRender);
}

document.addEventListener('pointerdown', () => {
  clearTimeout(clickHold);
  clickHold = setTimeout(endClickHold, CLICK_HOLD_MS);
}, true);
addEventListener('pointerup', endClickHold);
addEventListener('pointercancel', endClickHold);

view.addEventListener('focusout', (e) => {
  if (e.target.matches?.('[data-title-editor]')) flushRender();
});

async function render() {
  const editing = document.activeElement;
  const typingTitle = editing?.matches?.('[data-title-editor]') && editing.value !== editing.defaultValue;
  if (clickHold || typingTitle) {
    renderWaiting = true;
    return;
  }
  const epoch = ++renderEpoch;
  if (tab === 'live') return renderMeeting(status.id, true, epoch);
  if (tab === 'history') return viewingId ? renderMeeting(viewingId, false, epoch) : renderHistory(epoch);
  return renderSettings(epoch);
}

async function renderMeeting(id, live, epoch) {
  const meeting = id ? await getMeeting(id) : null;
  const viewKey = `${id}|${live}`;
  let meta = audioMeta;
  let metaKey = audioMetaKey;
  if (meeting?.source !== 'audio') { meta = null; metaKey = null; }
  else if (audioMetaKey !== viewKey) {
    const res = await globalThis.MeetAudioStore.listRecordings().catch(() => undefined);
    meta = res ?? null;
    metaKey = res === undefined ? null : viewKey;
  }
  if (epoch !== renderEpoch) return;
  audioMeta = meta;
  audioMetaKey = metaKey;
  const sameView = viewKey === lastRenderedKey;
  lastRenderedKey = viewKey;
  const stickToBottom = live && (!sameView || view.scrollHeight - view.scrollTop - view.clientHeight < 40);
  const prevTop = sameView ? view.scrollTop : 0;
  view.replaceChildren();
  if (live && HAS_AUDIO) {
    const bar = el('div', 'actions');
    if (Host) {
      bar.append(Host.recordControls(recState, busyLabel()));
    } else if (recState.transcribing) {
      bar.append(el('span', 'muted', busyLabel()));
    } else if (recState.recording) {
      const stop = el('button', null, 'Stop recording');
      stop.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'stop-recording' }));
      stop.classList.add('danger');
      bar.append(stop, el('span', 'recording', 'recording'));
    } else {
      bar.append(el('span', 'muted', 'Start recording from the extension icon → Record.'));
    }
    if (recState.error) bar.append(el('div', 'err', ' ' + recState.error));
    view.append(bar);
  }
  if (settingsCache.transcriptSource !== 'audio' && live && status.inCall && !status.captionsOn) {
    view.append(el('p', 'muted',
      'Captions are off. Turn on CC in the Meet toolbar to fill the transcript.'));
  }
  const quietSince = Math.max(status.lastSegmentAt || 0, status.captionsOnAt || 0);
  if (settingsCache.transcriptSource !== 'audio' && live && status.inCall && status.captionsOn && quietSince && Date.now() - quietSince > 30000) {
    view.append(el('p', 'muted',
      'Captions are on, but no text arrived in the last 30 seconds. If someone is speaking, Meet may have changed its page: update content/selectors.js.'));
  }
  if (!meeting) {
    view.append(el('p', 'muted',
      !live ? 'Meeting not found.'
        : Host?.emptyLiveText ?? 'No active Meet meeting. Recordings from other tabs, such as Discord, go to History.'));
    return;
  }
  if (!live) {
    const back = el('button', null, '← History');
    back.addEventListener('click', () => { viewingId = null; render(); });
    view.append(back);
  }
  view.append(Host ? Host.titleEditor(meeting) : raw(el('h2', null, meeting.title)));
  const startedText = new Date(meeting.startedAt).toLocaleString();
  if (meeting.title !== startedText) view.append(el('p', 'muted', startedText));
  if (momErrors.has(meeting.id)) view.append(el('div', 'error', momErrors.get(meeting.id)));
  if (!live && recState.error && (audioMeta ?? []).some((r) => r.meetingId === meeting.id)) {
    view.append(el('div', 'err', recState.error));
  }
  const actions = el('div', 'actions');
  const btn = (label, fn, box = actions) => mkBtn(label, fn, box);
  const flash = (b, label, ms = 2000) => {
    const asli = b.dataset.label ?? (b.dataset.label = b.textContent);
    b.textContent = label;
    clearTimeout(Number(b.dataset.timer));
    b.dataset.timer = String(setTimeout(() => { b.textContent = asli; }, ms));
  };
  const dropdown = (key, label) => mkDropdown(actions, key, label);
  const copy = dropdown('copy', 'Copy');
  const copyTo = (text) => async () => {
    try {
      await navigator.clipboard.writeText(text());
      flash(copy.head, 'Copied ✓');
    } catch {
      flash(copy.head, 'Copy failed');
    }
  };
  copy.item('Copy transcript', copyTo(() => M.formatTranscript(meeting.segments)));
  if (meeting.segments.length) copy.item('Copy prompt + transcript', copyTo(() => promptText(meeting)));
  const mom = dropdown('mom', meeting.mom ? 'Regenerate MoM' : 'Generate MoM');
  mom.item(meeting.mom ? 'Regenerate MoM' : 'Generate MoM', async () => {
    mom.head.textContent = 'Generating…';
    momErrors.delete(meeting.id);
    const res = await chrome.runtime.sendMessage({ type: 'generate-mom', id: meeting.id })
      .catch(() => null);
    if (!res?.ok) momErrors.set(meeting.id, res?.error ?? 'Could not reach the service worker.');
    render();
  });
  if (meeting.segments.length) {
    for (const [name, target] of [['Gemini', 'gemini'], ['ChatGPT', 'chatgpt']]) {
      mom.item(Host ? Host.aiLabel(name) : 'Paste into ' + name, async () => {
        mom.head.textContent = `Opening ${name}…`;
        const prompt = promptText(meeting);
        await navigator.clipboard.writeText(prompt).catch(() => {});
        chrome.runtime.sendMessage({ type: 'send-to-ai', target, text: prompt, id: meeting.id });
        setTimeout(() => { mom.head.textContent = mom.label; }, 3000);
      });
    }
  }
  const dl = dropdown('unduh', 'Download');
  dl.item('Download .txt', () => download(`${meeting.title}.txt`, M.formatTranscript(meeting.segments)));
  dl.item('Download .md', () => download(`${meeting.title}.md`, M.formatMarkdown(meeting)));
  dl.item('Download .docx', async () => download(`${meeting.title}.docx`, await globalThis.MeetExport.makeDocx(meeting)));
  dl.item('Save as PDF', async () => {
    if (!Host) {
      chrome.tabs.create({ url: chrome.runtime.getURL(`panel/print.html?id=${encodeURIComponent(meeting.id)}`) });
      return;
    }
    try {
      download(`${meeting.title}.pdf`, new Blob([await Host.makePdf()], { type: 'application/pdf' }));
    } catch (e) {
      flash(dl.head, 'PDF failed', 3000);
      console.error(e);
    }
  });
  if (!live && recState.transcribing && (audioMeta ?? []).some((r) => r.meetingId === meeting.id)) {
    actions.append(el('span', 'muted', busyLabel()));
  }
  const recs = (audioMeta ?? []).filter((r) => r.meetingId === meeting.id
    && (r.count > 0 || r.videoCount > 0 || r.mixCount > 0 || r.systemCount > 0 || r.micCount > 0));
  if (recs.length && !recState.recording && !recState.transcribing) {
    const many = recs.length > 1;
    const jam = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    for (const r of recs) {
      const tag = many ? ` — ${jam(r.baseTime)}` : '';
      const sfx = many ? `-${jam(r.baseTime).replace(/\D/g, '')}` : '';
      if (r.mixCount > 0) {
        dl.item(`Download recording${tag}`, async () => {
          const ok = await downloadMix(meeting, r, sfx).catch(() => false);
          flash(dl.head, ok ? 'Downloaded ✓' : 'Recording not found', 3000);
        });
      }
      if (r.count > 0) {
        dl.item(`Download audio${tag}${r.count > 1 ? ` (${r.count} files)` : ''}`, async () => {
          const n = await downloadAudio(meeting, r, sfx).catch(() => 0);
          flash(dl.head, n ? `Downloaded ✓${n > 1 ? ` (${n} files)` : ''}` : 'Audio not found', 3000);
        });
        if (r.count > 1) dl.list.append(el('span', 'muted',
          'Several files: allow "Download multiple files" if Chrome asks.'));
      }
      if (r.videoCount > 0) {
        dl.item(`Download video${tag}`, async () => {
          const ok = await downloadVideo(meeting, r, sfx).catch(() => false);
          flash(dl.head, ok ? 'Downloaded ✓' : 'Video not found', 3000);
        });
      }
    }
    const reable = recs.filter((r) => r.count > 0 || r.systemCount > 0 || r.micCount > 0);
    const transcribed = (r) => meeting.segments.some((s) => String(s.id ?? '').startsWith(`audio:${r.baseTime}:`));
    const label = (r) => (transcribed(r) ? 'Retranscribe' : 'Generate transcript');
    if (reable.length) {
      const jalankan = async (r, setLabel) => {
        setLabel('Transcribing…');
        momErrors.delete(meeting.id);
        try {
          await ensureOrigins([globalThis.MeetStt.sttEndpoint(settingsCache).baseUrl].filter((url) => url && url !== globalThis.MeetStt.BUILTIN_URL));
        } catch (e) {
          momErrors.set(meeting.id, e.message + ' Transcription did not run. Check the STT Base URL in Settings.');
          render();
          return;
        }
        const res = await chrome.runtime.sendMessage(
          { type: 'regenerate-transcript', id: meeting.id, recId: r.recId }).catch(() => null);
        if (!res?.ok) {
          momErrors.set(meeting.id, res?.error ?? 'Could not reach the service worker.');
          render();
        }
      };
      if (reable.length === 1) {
        const reBtn = btn(label(reable[0]), () => {
          reBtn.disabled = true;
          return jalankan(reable[0], (t) => { reBtn.textContent = t; });
        });
      } else {
        const re = dropdown('retranskrip', reable.some(transcribed) ? 'Transcribe audio' : 'Generate transcript');
        for (const r of reable) {
          re.item(`${label(r)} — recording ${jam(r.baseTime)}`,
            () => jalankan(r, (t) => { re.head.textContent = t; }));
        }
      }
    }
  }
  if (!live) {
    const remove = btn('Delete', async () => {
      if (!confirm(`${t(`Delete "${meeting.title}" and its recordings? This cannot be undone.`)}${t(Host?.deleteNote ?? '')}`)) return;
      momErrors.delete(meeting.id);
      const res = await chrome.runtime.sendMessage({ type: 'delete-meeting', id: meeting.id }).catch(() => null);
      if (res?.ok) viewingId = null;
      else momErrors.set(meeting.id, res?.error ?? 'Could not reach the service worker.');
      render();
    });
    remove.classList.add('danger');
  }
  view.append(actions);
  const list = raw(el('div'));
  for (const s of meeting.segments) {
    const seg = el('div', 'seg');
    const head = el('div');
    head.append(el('span', 'who', s.speaker), el('span', 'time', new Date(s.t).toLocaleTimeString()));
    seg.append(head, el('div', null, s.text));
    list.append(seg);
  }
  if (!meeting.segments.length) view.append(el('p', 'muted', Host?.emptySegmentsText ?? 'No captions yet.'));
  view.append(list);
  if (meeting.mom) {
    view.append(el('h3', null, 'MoM'));
    view.append(raw(el('div', 'mom', meeting.mom)));
  }
  view.scrollTop = stickToBottom ? view.scrollHeight : prevTop;
}

let historyQuery = '';

function historyList(items) {
  const found = items.filter((m) => M.matchesSearch(m, historyQuery));
  if (!found.length) return [el('p', 'muted', 'No meetings match.')];
  return found.map((m) => {
    const item = el('button', 'item');
    item.append(
      raw(el('div', 'who', m.title)),
      el('div', 'muted',
        `${new Date(m.startedAt).toLocaleString()} — ${m.segments.length} ${m.segments.length === 1 ? 'segment' : 'segments'}${m.mom ? ' — MoM ✓' : ''}`)
    );
    const snippet = M.searchSnippet(m, historyQuery);
    if (snippet) item.append(raw(el('div', 'snippet', snippet)));
    item.addEventListener('click', () => { viewingId = m.id; render(); });
    return item;
  });
}

async function renderHistory(epoch) {
  const { meetings = [] } = await chrome.storage.local.get('meetings');
  const items = (await Promise.all(meetings.map(getMeeting))).filter(Boolean);
  if (epoch !== renderEpoch) return;
  lastRenderedKey = null;
  const previous = document.getElementById('history-search');
  const wasTyping = document.activeElement === previous && previous;
  const caret = wasTyping ? previous.selectionStart : 0;
  view.replaceChildren();
  if (!items.length) {
    view.append(el('p', 'muted', 'No history yet.'));
    return;
  }
  const search = mkEl('input', { type: 'search', id: 'history-search', value: historyQuery, placeholder: 'Search titles, transcripts, and MoM' });
  search.setAttribute('aria-label', 'Search meetings');
  const list = el('div');
  list.append(...historyList(items));
  search.addEventListener('input', () => {
    historyQuery = search.value;
    list.replaceChildren(...historyList(items));
  });
  view.append(search, list);
  if (wasTyping) {
    search.focus();
    search.setSelectionRange(caret, caret);
  }
}

async function renderSettings(epoch) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const hasEngine = await Host?.hasEngine();
  if (epoch !== renderEpoch) return;
  lastRenderedKey = null;
  view.replaceChildren();
  view.append(el('h2', null, 'Settings'));
  view.append(el('p', 'muted', 'Hold Alt to see the shortcut for each button.'));
  const language = mkEl('select', {});
  addOptions(language, [['en', 'English'], ['id', 'Bahasa Indonesia']]);
  language.value = settings.uiLang === 'id' ? 'id' : 'en';
  language.addEventListener('change', () => patchSettings({ uiLang: language.value }));
  const languageRow = el('div');
  languageRow.append(el('label', null, 'Language'), language);
  view.append(languageRow);
  const rowOf = new WeakMap();
  const field = (label, input) => {
    const row = el('div');
    row.append(el('label', null, label), input);
    view.append(row);
    rowOf.set(input, row);
    return input;
  };
  const show = (input, on) => { rowOf.get(input).hidden = !on; };
  const { DEFAULT_BASE_URL: DEFAULT_BASE, DEFAULT_MODEL } = globalThis.MeetOpenAI;
  const baseUrl = field('Base URL (OpenAI-compatible)',
    mkEl('input', { value: settings.baseUrl ?? DEFAULT_BASE }));
  const apiKey = field('API key',
    mkEl('input', { type: 'password', value: settings.apiKey ?? '' }));
  const model = field('Model',
    mkEl('input', { value: settings.model ?? DEFAULT_MODEL }));
  const template = field('MoM template ({{transcript}} = transcript)',
    mkEl('textarea', { value: settings.momTemplate ?? M.DEFAULT_MOM_TEMPLATE }));
  const source = field('Transcript source',
    document.createElement('select'));
  addOptions(source, [['caption', 'Meet captions'], ['audio', 'Record audio']]);
  source.value = Host ? 'audio' : settings.transcriptSource ?? 'caption';
  const hideBox = mkEl('input', { type: 'checkbox', checked: settings.hideCaptions !== false });
  const hideLabel = el('label');
  hideLabel.append(hideBox, 'Hide captions on the Meet screen (transcript keeps running)');
  hideBox.addEventListener('change', () => patchSettings({ hideCaptions: hideBox.checked }));
  const hideRow = el('div');
  hideRow.append(hideLabel);
  hideRow.hidden = !!Host;
  view.append(hideRow);
  const captionLang = field('Meet caption language', document.createElement('select'));
  addOptions(captionLang, [['id', 'Indonesia'], ['en', 'English']]);
  captionLang.value = settings.captionLang ?? 'id';
  show(captionLang, !Host);
  captionLang.addEventListener('change', () => patchSettings({ captionLang: captionLang.value }));
  const micWrap = el('div');
  const micBox = mkEl('input', { type: 'checkbox', checked: Host ? settings.mic !== false : !!settings.mic });
  micBox.addEventListener('change', () => patchSettings({ mic: micBox.checked }));
  const micLabel = el('label');
  micLabel.append(micBox, 'Record microphone');
  const micBtn = el('button', null, 'Allow microphone');
  micBtn.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open-mic-permission' }).catch(() => {}));
  const micRow = el('div', 'actions');
  micRow.append(micBtn);
  micBtn.hidden = !!Host;
  micWrap.append(micLabel, micRow, el('div', 'muted',
    'Without a headset, voices from your speakers can leak into the mic and appear twice.'));
  micWrap.hidden = !HAS_AUDIO;
  view.append(micWrap);
  const ST = globalThis.MeetStt;
  const sttModeSel = field('STT mode',
    document.createElement('select'));
  const engineSaved = ST.sttMode(settings) === 'builtin';
  if (hasEngine || engineSaved) addOptions(sttModeSel, [['builtin', 'Built-in (on this computer)']]);
  addOptions(sttModeSel, [['whisper-local', 'Local Whisper (your own server)'], ['api', 'STT API']]);
  sttModeSel.value = ST.sttMode(settings);
  const INFO = {
    builtin: 'Audio stays on this computer, and no server or internet is needed. Speed depends on your computer, and accuracy is lower than larger models on your own server.',
    'whisper-local': 'Audio goes to your own OpenAI-compatible whisper server '
      + '(whisper.cpp, faster-whisper, and others) at the URL below. Audio stays on '
      + 'your network, but the server must be running during transcription. If it is down, '
      + 'transcription fails and the audio stays saved so you can try again.',
  };
  const sttInfo = el('div', 'info');
  view.append(sttInfo);
  const savedMode = ST.sttMode(settings);
  const initialUrl = settings.sttBaseUrl || (savedMode === 'whisper-local' ? ST.WHISPER_DEFAULT : '');
  const sttBaseUrl = field('STT Base URL',
    mkEl('input', { value: initialUrl }));
  const sttApiKey = field('STT API key (empty = no auth)',
    mkEl('input', { type: 'password', value: settings.sttApiKey ?? '' }));
  const sttModel = field('STT model',
    mkEl('input', { value: settings.sttModel ?? ST.DEFAULT_API_MODEL }));
  const sttLanguage = field('STT language (such as id or en; empty = auto)',
    mkEl('input', { value: settings.sttLanguage ?? ST.DEFAULT_LANGUAGE }));
  function applyMode() {
    const audio = HAS_AUDIO;
    const m = sttModeSel.value;
    show(source, HAS_AUDIO && !Host);
    show(sttModeSel, audio);
    show(sttBaseUrl, audio && m !== 'builtin');
    show(sttApiKey, audio && m === 'api');
    show(sttModel, audio && m === 'api');
    show(sttLanguage, audio);
    const info = audio && INFO[m];
    sttInfo.textContent = info ? 'ⓘ ' + INFO[m] : '';
    sttInfo.hidden = !info;
  }
  const urlByMode = { 'whisper-local': ST.WHISPER_DEFAULT, api: '', builtin: '' };
  let urlMode = savedMode;
  urlByMode[urlMode] = initialUrl;
  sttModeSel.addEventListener('change', () => {
    urlByMode[urlMode] = sttBaseUrl.value.trim();
    urlMode = sttModeSel.value;
    sttBaseUrl.value = urlByMode[urlMode];
    applyMode();
  });
  applyMode();
  const note = el('span', 'muted', '');
  const setNote = (cls, text) => { note.className = cls; note.textContent = ' ' + text; };
  const normalizedBase = () => (baseUrl.value.trim() || DEFAULT_BASE).replace(/\/+$/, '');
  const sttBaseValue = () => sttBaseUrl.value.trim().replace(/\/+$/, '');
  const sttBaseForSave = () => (HAS_AUDIO && source.value === 'audio' ? sttBaseValue() : '');
  const sttBaseForTest = sttBaseForSave;
  async function probeStt(base, key) {
    const host = new URL(base).hostname;
    let res;
    try {
      res = await (Host?.fetch ?? fetch)(`${base}/models`, {
        ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      if (e?.name === 'TimeoutError') throw new Error(`STT ${host} did not answer within 15 seconds.`);
      throw new Error(`Could not connect to STT ${host}.`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`STT ${host}: HTTP ${res.status} (wrong or empty STT API key?)`);
    }
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      return ` (STT ${host}: the server does not support /models, HTTP ${res.status}. Check it yourself.)`;
    }
    if (!res.ok) throw new Error(`STT ${host}: HTTP ${res.status}`);
    return '';
  }
  const test = el('button', null, 'Test connection');
  test.addEventListener('click', async () => {
    test.disabled = true;
    setNote('muted', 'Testing…');
    try {
      const base = normalizedBase();
      const sttBase = sttBaseForTest();
      await ensureOrigins(sttBase ? [base, sttBase] : [base]);
      await globalThis.MeetOpenAI.testConnection({
        apiKey: apiKey.value.trim(),
        model: model.value.trim() || DEFAULT_MODEL,
        baseUrl: base,
      });
      const sttNote = sttBase ? await probeStt(sttBase, sttApiKey.value.trim()) : '';
      setNote('ok', `✓ Connection OK${sttBase ? ' (chat + STT)' : ''}: URL, API key, and model are valid.${sttNote}`);
    } catch (e) {
      setNote('err', '✗ Failed: ' + (e?.message ?? e));
    } finally {
      test.disabled = false;
    }
  });
  const save = el('button', null, 'Save');
  save.addEventListener('click', async () => {
    if (save.disabled) return;
    save.disabled = true;
    try {
      await doSave();
    } finally {
      save.disabled = false;
    }
  });
  async function doSave() {
    const base = normalizedBase();
    const sttBase = sttBaseForSave();
    let warning = null;
    try {
      await ensureOrigins(sttBase ? [base, sttBase] : [base]);
    } catch (e) {
      if (e.invalidUrl) return setNote('err', e.message);
      warning = e.message;
    }
    const cur = (await chrome.storage.local.get('settings')).settings ?? {};
    await chrome.storage.local.set({
      settings: {
        ...cur,
        apiKey: apiKey.value.trim(),
        baseUrl: base,
        model: model.value.trim() || DEFAULT_MODEL,
        momTemplate: template.value,
        transcriptSource: source.value,
        hideCaptions: cur.hideCaptions ?? hideBox.checked,
        captionLang: cur.captionLang ?? captionLang.value,
        mic: cur.mic ?? micBox.checked,
        sttMode: sttModeSel.value,
        sttModel: sttModel.value.trim() || ST.DEFAULT_API_MODEL,
        sttLanguage: sttLanguage.value.trim(),
        sttBaseUrl: sttBaseValue(),
        sttApiKey: sttApiKey.value.trim(),
      },
    });
    const noPlaceholder = !template.value.includes('{{transcript}}');
    if (warning) setNote('err', `Saved, but ${warning} Requests may fail.`);
    else if (noPlaceholder) setNote('err', 'Saved, but the MoM template has no {{transcript}}, so MoM will be made without the transcript.');
    else setNote('ok', 'Saved.');
  }
  const actions = el('div', 'actions');
  actions.append(test, save, note);
  view.append(actions);
  const autoMomBox = mkEl('input', { type: 'checkbox', checked: !!settings.autoMom });
  const autoMomLabel = el('label');
  autoMomLabel.append(autoMomBox, 'Make MoM automatically when a transcript is ready (sends it to your LLM)');
  autoMomBox.addEventListener('change', () => patchSettings({ autoMom: autoMomBox.checked }));
  view.append(autoMomLabel);
  for (const row of Host?.settingsRows(settings) ?? []) view.append(row);
  view.append(el('h3', null, 'Backup'));
  const bnote = el('span', 'muted', '');
  const setBnote = (cls, text) => { bnote.className = cls; bnote.textContent = ' ' + text; };
  const exportBtn = el('button', null, 'Export backup (.zip)');
  exportBtn.addEventListener('click', async () => {
    if (recState.recording || recState.transcribing || status.inCall) {
      return setBnote('err', '✗ A recording, transcript, or meeting is running, so the backup would be incomplete. Wait until it finishes.');
    }
    exportBtn.disabled = true;
    setBnote('muted', 'Building zip…');
    try {
      const zip = await globalThis.MeetBackup.exportBackup();
      download(`transcripables-backup-${new Date().toISOString().slice(0, 10)}.zip`, zip);
      setBnote('ok', `✓ Backup ready (${zip.size < 1048576
        ? `${Math.max(1, Math.round(zip.size / 1024))} KB`
        : `${(zip.size / 1048576).toFixed(1)} MB`}).`);
    } catch (e) {
      setBnote('err', '✗ Export failed: ' + (e?.message ?? e));
    } finally {
      exportBtn.disabled = false;
    }
  });
  const importInput = mkEl('input', { type: 'file', accept: '.zip,application/zip', hidden: true });
  const importBtn = el('button', null, 'Import backup');
  importBtn.addEventListener('click', () => { importInput.value = ''; importInput.click(); });
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    if (recState.recording || recState.transcribing || status.inCall) {
      return setBnote('err', '✗ A recording, transcript, or meeting is running. Stop it or leave before importing.');
    }
    if (!confirm(t('Import REPLACES all current data (history, settings, saved recordings). Continue?'))) return;
    importBtn.disabled = true;
    setBnote('muted', 'Importing…');
    try {
      const r = await globalThis.MeetBackup.importBackup(file);
      await loadSettings();
      audioMetaKey = null;
      alert(t(r.audioError
        ? `Import PARTLY finished: ${r.meetings} meetings restored, but audio and video could not be restored (${r.audioError}). The old data has been replaced.`
        : `Import finished: ${r.meetings} meetings${r.chunks ? `, ${r.chunks} recording parts` : ''}.`));
      render();
    } catch (e) {
      setBnote('err', '✗ Import failed: ' + (e?.message ?? e));
    } finally {
      importBtn.disabled = false;
    }
  });
  const backupRow = el('div', 'actions');
  backupRow.append(exportBtn, importBtn, importInput, bnote);
  view.append(backupRow);
  if (Host) view.append(el('div', 'err', Host.backupWarning));
  view.append(el('div', 'muted',
    'Backups hold transcripts, MoM, and Settings, not recording files. Audio and '
    + 'video are left out because they can reach hundreds of MB each. Download them from '
    + 'the History entry → Download. Only the last 5 recordings are kept; older '
    + 'ones are removed when a new recording starts. Importing a backup also DELETES '
    + 'the recordings saved at that moment.'));
}

chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && c.settings) { settingsCache = c.settings.newValue ?? {}; if (tab === 'live') render(); }
});

(async () => {
  await globalThis.MeetI18n.follow();
  await loadSettings();
  const a = await chrome.runtime.sendMessage({ type: 'get-active' }).catch(() => null);
  if (a) status = a;
  if (a?.rec) recState = { ...recState, recording: a.rec.recording, transcribing: a.rec.transcribing, muted: a.rec.muted,
    saving: a.rec.transcribing && a.rec.autoStt === false };
  if (a?.panelTab) selectTab(a.panelTab);
  if (a?.panelMeetingId) viewingId = a.panelMeetingId;
  render();
})();
