const M = globalThis.MeetMerge;
const view = document.getElementById('view');
let tab = 'live';
let viewingId = null;
let focusLine = null;
let status = { id: null, inCall: false, captionsOn: false, lastSegmentAt: 0, captionsOnAt: 0 };
let recState = { recording: false, transcribing: false, saving: false, done: 0, total: 0, error: null };

let progressStart = 0;
// Returns the status text shown while a recording is saved, split by speaker, or transcribed.
const busyLabel = () => {
  if (recState.saving) return 'Saving recording…';
  if (recState.speakers) return 'Telling speakers apart…';
  if (!recState.total) return 'Transcribing…';
  const left = progressStart
    ? M.minutesLeft(recState.done, recState.total, Date.now() - progressStart)
    : null;
  const count = `Transcribing… ${recState.done}/${recState.total}`;
  return left ? `${count}, about ${left} min left` : count;
};

const HAS_AUDIO = !!chrome.tabCapture;
const Host = globalThis.PanelHost;

let settingsCache = {};
// Reads the saved settings into settingsCache.
async function loadSettings() {
  settingsCache = (await chrome.storage.local.get('settings')).settings ?? {};
}

const {
  CAPTION_LANGUAGES, el, raw, markLine, mkBtn, mkDropdown, patchSettings, meetingKey, clearShortcut,
} = globalThis.MeetUi;
const { t } = globalThis.MeetI18n;
// Creates an element and copies the given properties onto it.
const mkEl = (tag, props) => Object.assign(document.createElement(tag), props);
// Appends one <option> per [value, text] pair to a select.
const addOptions = (select, pairs) => {
  for (const [value, textContent] of pairs) select.append(mkEl('option', { value, textContent }));
};
// Tells whether the meeting with this id is the one on screen right now.
const isShowing = (id) => (tab === 'live' && id === status.id) || (tab === 'history' && id === viewingId);

// Builds an error for an address that cannot be used at all, so callers can tell it from a denial.
const badUrl = (message) => Object.assign(new Error(message), { invalidUrl: true });
// Asks for host access to each address (OpenAI is already allowed) and throws if one is invalid or denied.
async function ensureOrigins(bases) {
  const patterns = [];
  for (const base of bases) {
    let url;
    try {
      url = new URL(base);
    } catch {
      url = null;
    }
    if (!url || !/^https?:$/.test(url.protocol) || !url.hostname) throw badUrl(`Invalid URL: ${base}`);
    if (url.hostname.startsWith('[') && !Host) {
      throw badUrl(`Chrome does not support IPv6 addresses here: ${base}. Use 127.0.0.1 or a host name.`);
    }
    const pattern = `${url.protocol}//${url.hostname}/*`;
    if (pattern !== 'https://api.openai.com/*') patterns.push(pattern);
  }
  if (!patterns.length) return;
  const granted = await chrome.permissions.request({ origins: [...new Set(patterns)] }).catch(() => false);
  if (!granted) {
    throw new Error(`Access to ${patterns.join(', ')} was denied.`);
  }
}

// Shows an unexpected error with its stack in a box at the top of the page.
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

// Switches to a tab and highlights its button, leaving any open meeting.
function selectTab(name) {
  tab = name;
  viewingId = null;
  document.querySelectorAll('nav button').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === name);
  });
}

document.querySelectorAll('nav button').forEach((button) =>
  button.addEventListener('click', () => {
    if (button.dataset.tab === tab && tab === 'settings') return;
    selectTab(button.dataset.tab);
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
    if (msg.movedFrom && viewingId === msg.movedFrom) viewingId = msg.id;
    if (isShowing(msg.id) || (tab === 'history' && !viewingId)) render();
  } else if (msg.type === 'ai-inject') {
    if (msg.ok || !msg.id) return;
    momErrors.set(msg.id,
      `Could not paste into the AI tab: ${msg.error} The prompt is on your clipboard, so paste it there yourself.`);
    if (isShowing(msg.id)) render();
  } else if (msg.type === 'rec-state') {
    const wasActive = recState.recording || recState.transcribing;
    const isActive = msg.recording || msg.transcribing;
    if (wasActive !== isActive) audioMetaKey = null;
    if (msg.total && !msg.done) progressStart = Date.now();
    if (!msg.transcribing) progressStart = 0;
    recState = {
      recording: msg.recording,
      transcribing: msg.transcribing,
      saving: !!msg.saving,
      muted: msg.muted,
      paused: !!msg.paused,
      importing: !!msg.importing,
      done: msg.done ?? 0,
      total: msg.total ?? 0,
      speakers: !!msg.speakers,
      error: 'error' in msg ? msg.error : recState.error,
    };
    if (tab === 'live' || (tab === 'history' && viewingId)) render();
  }
});

// Loads one meeting from storage, or null when it does not exist.
async function getMeeting(id) {
  const key = meetingKey(id);
  return (await chrome.storage.local.get(key))[key] ?? null;
}

// Replaces characters that are not allowed in file names with a dash.
const safeName = (s) => s.replace(/[\/\\:*?"<>|]/g, '-');

// Builds the MoM prompt for a meeting with the current settings.
const promptText = (meeting) => M.momPrompt(meeting, settingsCache);

// Saves text or a Blob as a file download with a safe file name.
function download(name, data) {
  const link = document.createElement('a');
  const blob = data instanceof Blob ? data : new Blob([data], { type: 'text/plain' });
  link.href = URL.createObjectURL(blob);
  link.download = safeName(name);
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 60000);
}

// Downloads a recording's audio, zipping the parts when there are several, and returns the file count.
async function downloadAudio(meeting, rec, suffix) {
  const saved = await globalThis.MeetAudioStore.loadAudio(rec.recId);
  if (!saved?.blobs?.length) return 0;
  if (saved.meetingId !== meeting.id) return 0;
  const kind = saved.imported ? 'wav' : 'webm';
  if (saved.blobs.length === 1) {
    download(`${meeting.title}${suffix}.${kind}`, saved.blobs[0]);
    return 1;
  }
  const parts = saved.blobs.map((data, i) => {
    const number = String((saved.indices?.[i] ?? i) + 1).padStart(2, '0');
    return { name: `part-${number}.${kind}`, data };
  });
  download(`${meeting.title}${suffix}-audio.zip`, await globalThis.MeetBackup.makeZip(parts));
  return saved.blobs.length;
}

// Downloads a recording's video as one .webm file and tells whether it was found.
async function downloadVideo(meeting, rec, suffix) {
  const saved = await globalThis.MeetAudioStore.loadVideo(rec.recId);
  if (!saved?.blobs?.length) return false;
  if (saved.meetingId !== meeting.id) return false;
  download(`${meeting.title}${suffix}-video.webm`, new Blob(saved.blobs, { type: 'video/webm' }));
  return true;
}

// Downloads a recording's mixed audio as one .webm file and tells whether it was found.
async function downloadMix(meeting, rec, suffix) {
  const saved = await globalThis.MeetAudioStore.loadMix(rec.recId);
  if (!saved?.blobs?.length || saved.meetingId !== meeting.id) return false;
  download(`${meeting.title}${suffix}.webm`, new Blob(saved.blobs, { type: 'audio/webm' }));
  return true;
}
let renderEpoch = 0;
let lastRenderedKey = null;
let editingId = null;
let asking = null;
const askDrafts = new Map();
const EDIT_LINE_CHARS = 40;
let audioMeta = null;
let audioMetaKey = null;
const momErrors = new Map();
const momFailures = new Map();

const CLICK_HOLD_MS = 1000;
let clickHold = null;
let renderWaiting = false;

// Runs a render that was held back while the user was clicking or typing.
function flushRender() {
  if (!renderWaiting) return;
  renderWaiting = false;
  render();
}

// Ends the click hold and runs any render that waited for it.
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
  if (e.target instanceof Element && e.target.matches('[data-title-editor],[data-edit-key]')) flushRender();
});

// Redraws the current tab, unless the user is mid-click or has unsaved typing in a field.
async function render() {
  const editing = document.activeElement;
  const typingTitle = editing?.matches?.('[data-title-editor],[data-edit-key]')
    && editing.type !== 'checkbox'
    && editing.value !== editing.defaultValue;
  if (clickHold || typingTitle) {
    renderWaiting = true;
    return;
  }
  const epoch = ++renderEpoch;
  if (tab === 'live') return renderMeeting(status.id, true, epoch);
  if (tab === 'history') return viewingId ? renderMeeting(viewingId, false, epoch) : renderHistory(epoch);
  return renderSettings(epoch);
}

// Builds the "Get started" card listing what still needs setting up, or nothing when all is ready.
function setupCard(engineReady) {
  const speechReady = Host ? !!engineReady || !!settingsCache.sttMode : true;
  const aiReady = M.canMakeMom(settingsCache);
  if (settingsCache.setupDone || (speechReady && aiReady)) return [];
  const box = el('div', 'info');
  box.append(el('strong', null, 'Get started'));
  let speechText = 'Google Meet captions work with no setup.';
  if (Host) {
    speechText = speechReady ? 'Speech-to-text is ready.' : 'Speech-to-text: choose a service in Settings.';
  }
  box.append(el('div', null, `${speechReady ? '✓' : '○'} ${speechText}`));
  const aiText = aiReady
    ? '✓ AI service is ready.'
    : '○ Minutes of meeting: add an AI service in Settings, or paste the prompt into Gemini or ChatGPT.';
  box.append(el('div', null, aiText));
  const row = el('div', 'actions');
  mkBtn('Open Settings', () => { selectTab('settings'); render(); }, row);
  mkBtn('Not now', () => patchSettings({ setupDone: true }).then(render), row);
  box.append(row);
  return [box];
}

// Draws one meeting (live or from History): recording bar, actions, transcript, and MoM.
async function renderMeeting(id, live, epoch) {
  const meeting = id ? await getMeeting(id) : null;
  const viewKey = `${id}|${live}`;
  const engineReady = !meeting && await Host?.hasEngine();
  let meta = audioMeta;
  let metaKey = audioMetaKey;
  if (meeting?.source !== 'audio') {
    meta = null;
    metaKey = null;
  } else if (audioMetaKey !== viewKey) {
    const res = await globalThis.MeetAudioStore.listRecordings().catch(() => undefined);
    meta = res ?? null;
    metaKey = res === undefined ? null : viewKey;
  }
  if (epoch !== renderEpoch) return;
  audioMeta = meta;
  audioMetaKey = metaKey;
  const sameView = viewKey === lastRenderedKey;
  lastRenderedKey = viewKey;
  const focusKey = document.activeElement?.dataset?.editKey;
  const nearBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
  const stickToBottom = live && editingId !== id && (!sameView || nearBottom);
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
      const pause = el('button', null, recState.paused ? 'Resume recording' : 'Pause recording');
      pause.addEventListener('click',
        () => chrome.runtime.sendMessage({ type: 'set-paused', on: !recState.paused }));
      const stateText = recState.paused ? 'paused, nothing is being recorded' : 'recording';
      bar.append(stop, pause, el('span', 'recording', stateText));
    } else {
      const needsRecord = settingsCache.transcriptSource === 'both' && status.inCall;
      bar.append(needsRecord
        ? el('div', 'err', 'Not recording yet. Press Record on the extension icon so audio can fill what the captions miss.')
        : el('span', 'muted', 'Start recording from the extension icon → Record.'));
    }
    if (recState.error) bar.append(el('div', 'err', ' ' + recState.error));
    view.append(bar);
  }
  if (live && !Host && (recState.recording || status.inCall)) {
    const markRow = el('div', 'actions');
    mkBtn('Mark moment', async () => {
      const res = await chrome.runtime.sendMessage({ type: 'mark-moment' }).catch(() => null);
      if (!res?.ok) recState.error = res?.error ?? 'Could not reach the service worker.';
      render();
    }, markRow);
    view.append(markRow);
  }
  const captionsExpected = settingsCache.transcriptSource !== 'audio' && live && status.inCall;
  if (captionsExpected && !status.captionsOn) {
    view.append(el('p', 'muted',
      'Captions are off. Turn on CC in the Meet toolbar to fill the transcript.'));
  }
  const quietSince = Math.max(status.lastSegmentAt || 0, status.captionsOnAt || 0);
  if (captionsExpected && status.captionsOn && quietSince && Date.now() - quietSince > 30000) {
    view.append(el('p', 'muted',
      'Captions are on, but no text arrived in the last 30 seconds. If someone is speaking, Meet may have changed its page: update content/selectors.js.'));
  }
  if (!meeting) {
    if (live) view.append(...setupCard(engineReady));
    const emptyText = !live
      ? 'Meeting not found.'
      : Host?.emptyLiveText ?? 'No active Meet meeting. Recordings from other tabs, such as Discord, go to History.';
    view.append(el('p', 'muted', emptyText));
    return;
  }
  if (!live) {
    const back = el('button', null, '← History');
    back.addEventListener('click', () => { viewingId = null; render(); });
    view.append(back);
  }
  view.append(titleEditor(meeting));
  const startedText = new Date(meeting.startedAt).toLocaleString();
  if (meeting.title !== startedText) view.append(el('p', 'muted', startedText));
  view.append(tagsEditor(meeting));
  const issues = el('div');
  view.append(issues);
  if (momErrors.has(meeting.id)) issues.append(el('div', 'error', momErrors.get(meeting.id)));
  const recordedHere = (audioMeta ?? []).some((r) => r.meetingId === meeting.id);
  const recError = !live && recState.error && recordedHere ? el('div', 'err', recState.error) : null;
  if (recError) view.append(recError);
  const actions = el('div', 'actions');
  // Adds a button to the main action row (or to the given box).
  const btn = (label, fn, box = actions) => mkBtn(label, fn, box);
  // Shows a short-lived label on a button, then puts its own label back.
  const flash = (button, label, ms = 2000) => {
    const original = button.dataset.label ?? (button.dataset.label = button.textContent);
    button.textContent = label;
    clearTimeout(Number(button.dataset.timer));
    button.dataset.timer = String(setTimeout(() => { button.textContent = original; }, ms));
  };
  // Adds a dropdown menu to the main action row.
  const dropdown = (key, label) => mkDropdown(actions, key, label);
  const copy = dropdown('copy', 'Copy');
  // Makes a click handler that copies the given text and reports the result on the Copy button.
  const copyTo = (text) => async () => {
    try {
      await navigator.clipboard.writeText(text());
      flash(copy.head, 'Copied ✓');
    } catch {
      flash(copy.head, 'Copy failed');
    }
  };
  copy.item('Copy transcript', copyTo(() => M.formatWithMarks(meeting)));
  if (meeting.segments.length) copy.item('Copy prompt + transcript', copyTo(() => promptText(meeting)));
  const mom = dropdown('mom', meeting.mom ? 'Regenerate MoM' : 'Generate MoM');
  // Asks the service worker to make the MoM and remembers any failure to show.
  const makeMom = async () => {
    mom.head.textContent = 'Generating…';
    momErrors.delete(meeting.id);
    momFailures.delete(meeting.id);
    const res = await chrome.runtime.sendMessage({ type: 'generate-mom', id: meeting.id })
      .catch(() => null);
    if (!res?.ok) momFailures.set(meeting.id, res?.error ?? 'Could not reach the service worker.');
    render();
  };
  mom.item(meeting.mom ? 'Regenerate MoM' : 'Generate MoM', makeMom);
  if (momFailures.has(meeting.id)) {
    const card = el('div', 'error', `MoM could not be made: ${momFailures.get(meeting.id)}`);
    mkBtn('Try MoM again', makeMom, card);
    issues.append(card);
  }
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
  if (meeting.mom) {
    // Shows a sharing error above the meeting.
    const showFailure = (e) => {
      momErrors.set(meeting.id, e?.message ?? String(e));
      render();
    };
    // Makes a click handler that sends the MoM to Slack or Notion, one send at a time per meeting.
    const sendTo = (kind, origin) => async () => {
      if (momSending.has(meeting.id)) return;
      momSending.add(meeting.id);
      const previous = mom.head.textContent;
      mom.head.textContent = 'Sending…';
      try {
        if (!Host) await ensureOrigins([origin]);
        const { settings = {} } = await chrome.storage.local.get('settings');
        if (Host) await Host.shareMom(kind, settings, { title: meeting.title, mom: meeting.mom });
        else await globalThis.MeetShare.deliver(kind, settings, meeting);
        momErrors.delete(meeting.id);
        mom.head.textContent = previous;
        flash(mom.head, 'Sent ✓');
      } catch (e) {
        mom.head.textContent = previous;
        showFailure(e);
      } finally {
        momSending.delete(meeting.id);
      }
    };
    mom.item('Email draft', async () => {
      try {
        await navigator.clipboard.writeText(meeting.mom).catch(() => {});
        const url = globalThis.MeetShare.emailUrl(meeting);
        if (Host) await Host.openMail(url);
        else window.open(url);
      } catch (e) {
        showFailure(e);
      }
    });
    mom.item('Send to Slack', sendTo('slack', 'https://hooks.slack.com/'));
    mom.item('Send to Notion', sendTo('notion', 'https://api.notion.com/'));
  }
  const downloads = dropdown('unduh', 'Download');
  downloads.item('Download .txt', () => download(`${meeting.title}.txt`, M.formatWithMarks(meeting)));
  downloads.item('Download .md', () => download(`${meeting.title}.md`, M.formatMarkdown(meeting)));
  downloads.item('Download .docx', async () => {
    download(`${meeting.title}.docx`, await globalThis.MeetExport.makeDocx(meeting));
  });
  // Returns the time the subtitle clock starts from, based on the meeting's recordings.
  const subtitleStart = () => M.subtitleOrigin(meeting, recs.map((r) => r.baseTime));
  downloads.item('Download .srt', () => {
    download(`${meeting.title}.srt`, M.formatSubtitles(meeting.segments, 'srt', subtitleStart()));
  });
  downloads.item('Download .vtt', () => {
    download(`${meeting.title}.vtt`, M.formatSubtitles(meeting.segments, 'vtt', subtitleStart()));
  });
  downloads.item('Save as PDF', async () => {
    if (!Host) {
      const printPage = `panel/print.html?id=${encodeURIComponent(meeting.id)}`;
      chrome.tabs.create({ url: chrome.runtime.getURL(printPage) });
      return;
    }
    try {
      const pdf = new Blob([await Host.makePdf()], { type: 'application/pdf' });
      download(`${meeting.title}.pdf`, pdf);
    } catch (e) {
      flash(downloads.head, 'PDF failed', 3000);
      console.error(e);
    }
  });
  if (!live && recState.transcribing && recordedHere) {
    actions.append(el('span', 'muted', busyLabel()));
  }
  let retry = null;
  const retryable = new Map();
  const recs = (audioMeta ?? []).filter((r) => r.meetingId === meeting.id
    && (r.count > 0 || r.videoCount > 0 || r.mixCount > 0 || r.systemCount > 0 || r.micCount > 0));
  if (recs.length && !recState.recording && !recState.transcribing) {
    const many = recs.length > 1;
    // Formats a time as hours and minutes, used to tell several recordings apart.
    const clockTime = (time) => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    for (const rec of recs) {
      const labelSuffix = many ? ` — ${clockTime(rec.baseTime)}` : '';
      const fileSuffix = many ? `-${clockTime(rec.baseTime).replace(/\D/g, '')}` : '';
      if (rec.mixCount > 0) {
        downloads.item(`Download recording${labelSuffix}`, async () => {
          const ok = await downloadMix(meeting, rec, fileSuffix).catch(() => false);
          flash(downloads.head, ok ? 'Downloaded ✓' : 'Recording not found', 3000);
        });
      }
      if (rec.count > 0) {
        const fileCount = rec.count > 1 ? ` (${rec.count} files)` : '';
        downloads.item(`Download audio${labelSuffix}${fileCount}`, async () => {
          const n = await downloadAudio(meeting, rec, fileSuffix).catch(() => 0);
          const savedCount = n > 1 ? ` (${n} files)` : '';
          flash(downloads.head, n ? `Downloaded ✓${savedCount}` : 'Audio not found', 3000);
        });
      }
      if (rec.videoCount > 0) {
        downloads.item(`Download video${labelSuffix}`, async () => {
          const ok = await downloadVideo(meeting, rec, fileSuffix).catch(() => false);
          flash(downloads.head, ok ? 'Downloaded ✓' : 'Video not found', 3000);
        });
      }
    }
    const transcribable = recs.filter((r) => r.count > 0 || r.systemCount > 0 || r.micCount > 0);
    // Tells whether the meeting already has lines transcribed from this recording.
    const transcribed = (r) => {
      return meeting.segments.some((s) => String(s.id ?? '').startsWith(`audio:${r.baseTime}:`));
    };
    // Picks the button label for transcribing a recording, first time or again.
    const transcribeLabel = (r) => (transcribed(r) ? 'Retranscribe' : 'Generate transcript');
    if (transcribable.length) {
      // Transcribes one recording again after the user agrees to lose edits and speaker names.
      const transcribe = async (r, setLabel) => {
        const prefix = `audio:${r.baseTime}:`;
        const editedHere = meeting.deletedFrom?.includes(r.baseTime)
          || meeting.segments.some((s) => s.edited && String(s.id ?? '').startsWith(prefix));
        if (editedHere
          && !confirm(t('Retranscribing replaces your edits to the lines from this recording. Continue?'))) {
          render();
          return;
        }
        const sttModel = globalThis.MeetStt.sttEndpoint(settingsCache).model;
        if (globalThis.MeetStt.namesCanMove(meeting, sttModel)
          && !confirm(t('Speaker letters can change when retranscribing, so names you gave may land on the wrong person. Continue?'))) {
          render();
          return;
        }
        setLabel('Transcribing…');
        momErrors.delete(meeting.id);
        try {
          const sttBase = globalThis.MeetStt.sttEndpoint(settingsCache).baseUrl;
          await ensureOrigins([sttBase].filter((url) => url && url !== globalThis.MeetStt.BUILTIN_URL));
        } catch (e) {
          momErrors.set(meeting.id, e.message + ' Transcription did not run. Check the Speech-to-text address in Settings.');
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
      retry = transcribe;
      for (const r of transcribable) retryable.set(r.baseTime, r);
      if (transcribable.length === 1) {
        const transcribeBtn = btn(transcribeLabel(transcribable[0]), () => {
          transcribeBtn.disabled = true;
          return transcribe(transcribable[0], (text) => { transcribeBtn.textContent = text; });
        });
      } else {
        const anyTranscribed = transcribable.some(transcribed);
        const menu = dropdown('retranskrip', anyTranscribed ? 'Transcribe audio' : 'Generate transcript');
        for (const r of transcribable) {
          menu.item(`${transcribeLabel(r)} — recording ${clockTime(r.baseTime)}`,
            () => transcribe(r, (text) => { menu.head.textContent = text; }));
        }
      }
    }
  }
  if (!live && !recState.recording && !recState.transcribing) {
    for (const { baseTime, count } of M.failedParts(meeting)) {
      const savedRec = retryable.get(baseTime);
      let text;
      if (savedRec) {
        text = count === 1
          ? 'The recording is saved, but one part could not be transcribed.'
          : `The recording is saved, but ${count} parts could not be transcribed.`;
      } else {
        text = count === 1
          ? 'One part could not be transcribed, and its audio is no longer saved.'
          : `${count} parts could not be transcribed, and their audio is no longer saved.`;
      }
      const card = el('div', 'error', text);
      if (recError) card.append(recError);
      if (savedRec && retry) {
        const again = mkBtn('Try transcription again', () => {
          again.disabled = true;
          return retry(savedRec, (label) => { again.textContent = label; });
        }, card);
      }
      issues.append(card);
    }
  }
  const running = recState.recording || recState.transcribing || (status.inCall && status.id === meeting.id);
  if (running && editingId === meeting.id) editingId = null;
  const editing = editingId === meeting.id;
  const more = el('div', 'actions secondary');
  if (meeting.segments.length && !running) {
    btn(editing ? 'Done editing' : 'Edit transcript', () => {
      editingId = editing ? null : meeting.id;
      render();
    }, more);
  }
  if (!live) {
    const remove = btn('Delete', async () => {
      const question = t('Delete "{}" and its recordings? This cannot be undone.')
        .replace('{}', () => meeting.title);
      if (!confirm(question + t(Host?.deleteNote ?? ''))) return;
      momErrors.delete(meeting.id);
      const res = await chrome.runtime.sendMessage({ type: 'delete-meeting', id: meeting.id })
        .catch(() => null);
      if (res?.ok) viewingId = null;
      else momErrors.set(meeting.id, res?.error ?? 'Could not reach the service worker.');
      render();
    }, more);
    remove.classList.add('danger');
  }
  view.append(actions);
  if (more.childElementCount) view.append(more);
  if (editing) {
    view.append(el('p', 'muted',
      'Changes save when you leave a field. A new speaker name applies to every line with the old name. Empty a line to delete it.'));
    if (meeting.mom) view.append(el('p', 'muted', 'The existing MoM changes only when you regenerate it.'));
    if (Host?.editHint) view.append(el('p', 'muted', Host.editHint));
  }
  if (!editing && meeting.segments.length) view.append(askBox(meeting));
  const shares = editing || live ? [] : M.speakerShares(meeting.segments);
  if (shares.length) view.append(talkShare(shares));
  const list = raw(el('div'));
  const playable = running
    ? []
    : recs.filter((r) => !r.legacy && (r.count > 0 || r.systemCount > 0 || r.micCount > 0));
  // Finds the playable recording that covers a transcript line's time.
  const recordingAt = (time) => playable.find((r) => M.coversLine(r, time));
  if (editing) {
    for (const s of meeting.segments) list.append(segmentEditor(meeting, s));
  } else {
    const settling = (recState.recording || recState.transcribing) && meeting.id === status.id;
    // Tells whether a line came from the recording rather than from captions.
    const fromAudio = (s) => String(s.id ?? '').startsWith('audio:');
    if (settling && meeting.segments.some(fromAudio)) {
      view.append(el('p', 'muted',
        'Lines from the recording may still change. The final transcript replaces them when you stop.'));
    }
    const lines = meeting.segments.map((s, i) => {
      const rec = recordingAt(s.t);
      const next = meeting.segments[i + 1];
      const play = rec && (() => playLine(meeting, s, next, rec));
      return { t: s.t, node: segmentLine(s, play, settling && fromAudio(s)) };
    });
    const marks = (meeting.marks ?? []).map((time) => ({ t: time, node: markLine(time) }));
    for (const { node } of [...lines, ...marks].sort((a, b) => a.t - b.t)) list.append(node);
  }
  if (!meeting.segments.length) view.append(el('p', 'muted', Host?.emptySegmentsText ?? 'No captions yet.'));
  view.append(list);
  if (meeting.mom) {
    view.append(el('h3', null, 'MoM'));
    const momBox = raw(el('div', 'mom'));
    for (const text of meeting.mom.split(/\r?\n/)) {
      const row = el('div', 'mom-line', text);
      const lineId = /^\s*#/.test(text) ? null : M.sourceLine(meeting, text);
      if (lineId !== null) {
        const source = mkBtn(t('Source'), () => {
          focusLine = lineId;
          render();
        }, row);
        source.classList.add('link');
        source.setAttribute('aria-label', t('Show the transcript line behind this'));
      }
      momBox.append(row);
    }
    view.append(momBox);
    if (M.changedSince(meeting, meeting.momBasedOn)) {
      view.append(el('p', 'muted stale', 'The transcript changed after this MoM was made. Regenerate it to update.'));
    }
  }
  if (focusKey) view.querySelector(`[data-edit-key="${CSS.escape(focusKey)}"]`)?.focus();
  view.scrollTop = stickToBottom ? view.scrollHeight : prevTop;
  if (focusLine !== null) {
    const line = view.querySelector(`[data-seg-id="${CSS.escape(String(focusLine))}"]`);
    focusLine = null;
    line?.classList.add('focus');
    line?.scrollIntoView({ block: 'center' });
  }
}

const PLAY_MIN_SECONDS = 3;
const PLAY_MAX_SECONDS = 30;
let playing = null;

// Stops the line that is playing, if any.
function stopPlaying() {
  clearTimeout(playing?.timer);
  playing?.context.close().catch(() => {});
  playing = null;
}

// Loads the saved audio part with this index (system and mic on desktop, one track in the browser).
async function loadLineAudio(rec, index) {
  const loads = Host
    ? [globalThis.MeetAudioStore.loadSystem, globalThis.MeetAudioStore.loadMic]
    : [globalThis.MeetAudioStore.loadAudio];
  const saved = await Promise.all(loads.map((load) => load(rec.recId)));
  return saved.map((s) => s?.blobs[s.indices.indexOf(index)]).filter(Boolean);
}

// Plays the recorded audio behind one transcript line, or stops it when it is already playing.
async function playLine(meeting, s, next, rec) {
  const same = playing?.segmentId === s.id;
  stopPlaying();
  momErrors.delete(meeting.id);
  if (same) return render();
  const session = { segmentId: s.id, context: new AudioContext() };
  playing = session;
  render();
  try {
    const untilNext = next ? (next.t - s.t) / 1000 + 1 : PLAY_MIN_SECONDS * 3;
    const seconds = Math.min(PLAY_MAX_SECONDS, Math.max(PLAY_MIN_SECONDS, untilNext));
    const parts = M.playPlan(s.t, rec.baseTime, rec.chunkMs, seconds);
    const decoded = await Promise.all(parts.map(async (part) => {
      const blobs = await loadLineAudio(rec, part.index);
      const buffers = await Promise.all(
        blobs.map(async (blob) => session.context.decodeAudioData(await blob.arrayBuffer())));
      return { part, buffers: buffers.filter((buffer) => part.offset < buffer.duration) };
    }));
    if (playing !== session) return undefined;
    if (!decoded[0].buffers.length) throw new Error('no audio');
    const startAt = session.context.currentTime;
    for (const { part, buffers } of decoded) {
      for (const buffer of buffers) {
        const source = session.context.createBufferSource();
        source.buffer = buffer;
        source.connect(session.context.destination);
        source.start(startAt + part.wait, part.offset, part.seconds);
      }
    }
    session.timer = setTimeout(() => {
      if (playing !== session) return;
      stopPlaying();
      render();
    }, seconds * 1000);
  } catch {
    if (playing !== session) return undefined;
    stopPlaying();
    momErrors.set(meeting.id, 'This line could not be played.');
    render();
  }
  return undefined;
}

// Builds the meeting title field, which renames the meeting when changed.
function titleEditor(meeting) {
  const input = mkEl('input', { value: meeting.title, defaultValue: meeting.title });
  input.dataset.titleEditor = '';
  input.dataset.editKey = 'title';
  input.setAttribute('aria-label', 'Meeting title');
  input.addEventListener('change', () => {
    if (!input.value.trim()) {
      input.value = input.defaultValue;
      return;
    }
    input.defaultValue = input.value;
    chrome.runtime.sendMessage({ type: 'rename-meeting', id: meeting.id, title: input.value })
      .catch(() => {});
  });
  return input;
}

// Builds the comma-separated tags field, which saves cleaned-up tags when changed.
function tagsEditor(meeting) {
  const text = (meeting.tags ?? []).join(', ');
  const input = mkEl('input', {
    className: 'tags-input',
    value: text,
    defaultValue: text,
    placeholder: t('Tags, separated by commas'),
  });
  input.dataset.editKey = 'tags';
  input.setAttribute('aria-label', t('Tags'));
  input.addEventListener('change', () => {
    const tags = M.cleanTags(input.value);
    input.value = input.defaultValue = tags.join(', ');
    chrome.runtime.sendMessage({ type: 'tag-meeting', id: meeting.id, tags }).catch(() => {});
  });
  return input;
}

// Fills a datalist with the model names the AI service offers, quietly doing nothing on failure.
async function fillModels(list, base, key) {
  const res = await (Host?.fetch ?? fetch)(`${base}/models`, {
    ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (!res?.ok) return;
  const ids = globalThis.MeetOpenAI.modelIds(await res.json().catch(() => null));
  list.replaceChildren(...ids.map((id) => mkEl('option', { value: id })));
}

// Builds the "Ask about this meeting" box with the saved answers below it.
function askBox(meeting) {
  const box = el('div', 'ask');
  const row = el('div', 'ask-row');
  const draft = askDrafts.get(meeting.id) ?? '';
  const input = mkEl('input', { placeholder: 'Ask about this meeting', value: draft, defaultValue: draft });
  input.dataset.editKey = 'ask';
  input.addEventListener('input', () => askDrafts.set(meeting.id, input.value));
  input.setAttribute('aria-label', 'Ask about this meeting');
  // Sends the typed question to the AI service and redraws with the answer or error.
  const send = async () => {
    const question = input.value.trim();
    if (!question || asking) return;
    asking = meeting.id;
    input.value = '';
    input.defaultValue = '';
    askDrafts.delete(meeting.id);
    momErrors.delete(meeting.id);
    render();
    const res = await chrome.runtime.sendMessage({ type: 'ask-meeting', id: meeting.id, question })
      .catch(() => null);
    asking = null;
    if (!res?.ok) momErrors.set(meeting.id, res?.error ?? 'Could not reach the service worker.');
    render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });
  row.append(input);
  mkBtn('Ask', send, row);
  box.append(row);
  if (asking === meeting.id) box.append(el('p', 'muted', 'Thinking…'));
  for (const { question, answer, basedOn } of meeting.answers ?? []) {
    const item = el('div', 'mom');
    item.append(raw(el('strong', null, question)), raw(el('div', null, answer)));
    if (M.changedSince(meeting, basedOn)) {
      item.append(el('p', 'muted', 'The transcript changed after this answer.'));
    }
    const remove = mkBtn('Delete answer', async () => {
      const change = { deleteAnswer: { question, answer } };
      const res = await chrome.runtime.sendMessage({ type: 'edit-transcript', id: meeting.id, change })
        .catch(() => null);
      if (!res?.ok) {
        momErrors.set(meeting.id, res?.error ?? 'Could not reach the service worker.');
        render();
      }
    }, item);
    clearShortcut(remove);
    box.append(item);
  }
  return box;
}

// Empties a key field when its address moves to another host, and brings the key back on return.
function keepKeyWithAddress(addressOf, fields, key, paused = () => false) {
  // Returns the origin of the current address, or '' when it is not a valid URL.
  const hostOf = () => {
    try {
      return new URL(addressOf()).origin;
    } catch {
      return '';
    }
  };
  let saved = { host: hostOf(), key: key.value };
  let cleared = false;
  // Clears or restores the key to match the host now typed in the address field.
  const sync = () => {
    if (paused()) return;
    const sameHost = hostOf() === saved.host;
    if (!sameHost && saved.key && key.value === saved.key) {
      key.value = '';
      cleared = true;
    } else if (sameHost && cleared && !key.value) {
      key.value = saved.key;
      cleared = false;
    }
  };
  for (const input of fields) input.addEventListener('input', sync);
  // Records the current host and key as the saved pair after Save.
  const remember = () => {
    if (paused()) return;
    saved = { host: hostOf(), key: key.value };
    cleared = false;
  };
  return { sync, remember };
}

// Builds the "Who spoke" bars showing each speaker's share of words.
function talkShare(shares) {
  const box = el('div', 'talk');
  box.setAttribute('role', 'list');
  box.setAttribute('aria-label', t('Who spoke'));
  box.append(el('div', 'talk-head muted', 'Who spoke, by share of words'));
  for (const { speaker, share } of shares) {
    const row = el('div', 'talk-row');
    row.setAttribute('role', 'listitem');
    const bar = el('div', 'talk-bar');
    bar.style.setProperty('--share', `${share}%`);
    row.append(raw(el('span', 'who', speaker)), bar, raw(el('span', 'muted', `${share}%`)));
    box.append(row);
  }
  return box;
}

// Builds one transcript line: speaker, guessed tag, time, play button, text, and caption correction.
function segmentLine(s, play, provisional) {
  const seg = el('div', provisional ? 'seg provisional' : 'seg');
  if (s.id !== undefined) seg.dataset.segId = s.id;
  const head = el('div');
  head.append(el('span', 'who', s.speaker));
  if (M.isGuessedSpeaker(s.speaker) || s.matched) {
    const guess = el('span', 'guess', globalThis.MeetI18n.t('guessed'));
    const why = s.matched
      ? 'Matched to a saved voice, so it can be wrong. Rename it in Edit transcript.'
      : 'Told apart by voice, so it can be wrong. Rename it in Edit transcript.';
    guess.title = globalThis.MeetI18n.t(why);
    head.append(guess);
  }
  head.append(el('span', 'time', new Date(s.t).toLocaleTimeString()));
  if (play) {
    const isPlaying = playing?.segmentId === s.id;
    const button = el('button', isPlaying ? 'play playing' : 'play', isPlaying ? '■' : '▶');
    button.setAttribute('aria-label', globalThis.MeetI18n.t(isPlaying ? 'Stop playing' : 'Play this line'));
    button.addEventListener('click', play);
    head.append(button);
  }
  seg.append(head, el('div', null, s.text));
  if (s.captionText) {
    const note = el('details', 'corrected');
    note.append(
      el('summary', null, globalThis.MeetI18n.t('Corrected from audio')),
      raw(el('div', null, s.captionText)),
    );
    seg.append(note);
  }
  return seg;
}

// Builds the editable speaker and text fields for one transcript line.
function segmentEditor(meeting, s) {
  // Sends one transcript edit and shows the error if it was not saved.
  const save = async (change) => {
    const res = await chrome.runtime.sendMessage({ type: 'edit-transcript', id: meeting.id, change })
      .catch(() => null);
    if (res?.ok) return;
    momErrors.set(meeting.id, res?.error ?? 'Could not reach the service worker.');
    render();
  };
  const who = mkEl('input', { value: s.speaker ?? '', placeholder: t('Speaker name') });
  who.defaultValue = who.value;
  who.dataset.editKey = `who:${s.id}`;
  who.setAttribute('aria-label', t('Speaker name'));
  who.addEventListener('change', () => {
    if (!who.value.trim() && !confirm(t('Remove this speaker name from every line?'))) {
      who.value = who.defaultValue;
      return;
    }
    who.defaultValue = who.value;
    save({ from: s.speaker ?? '', to: who.value });
  });
  const text = mkEl('textarea', {
    value: s.text,
    rows: Math.max(1, Math.ceil(s.text.length / EDIT_LINE_CHARS)),
    disabled: !s.id,
  });
  text.defaultValue = s.text;
  text.dataset.editKey = `text:${s.id}`;
  text.setAttribute('aria-label', t('Transcript line'));
  text.addEventListener('change', () => {
    if (!text.value.trim() && !confirm(t('Delete this line?'))) {
      text.value = text.defaultValue;
      return;
    }
    text.defaultValue = text.value;
    save({ segmentId: s.id, text: text.value });
  });
  const seg = el('div', 'seg');
  seg.append(who, el('span', 'time', new Date(s.t).toLocaleTimeString()), text);
  return seg;
}

let historyQuery = '';
let historyTag = null;
// Tells whether a meeting has the tag (ignoring case); no tag matches every meeting.
const hasTag = (m, tag) => !tag || (m.tags ?? []).some((x) => x.toLowerCase() === tag.toLowerCase());

// Builds the row of tag buttons that filter the History list, starting with "All".
function tagChips(tags) {
  const row = el('div', 'tag-chips');
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', t('Filter by tag'));
  for (const tag of [null, ...tags]) {
    const chip = raw(mkEl('button', { className: 'chip', textContent: tag ?? t('All') }));
    chip.setAttribute('aria-pressed', String(historyTag === tag));
    chip.addEventListener('click', () => {
      historyTag = tag;
      render();
    });
    row.append(chip);
  }
  return row;
}
const IMPORT_PART_MS = 120000;
let importNote = null;

// Imports an audio file as a new meeting, saves its parts, and starts transcribing it.
async function importFile(file) {
  // Sends a message to the service worker.
  const send = (msg) => chrome.runtime.sendMessage(msg);
  const store = globalThis.MeetAudioStore;
  importNote = el('span', 'muted', 'Reading the file…');
  render();
  let id = null;
  try {
    const origins = [globalThis.MeetStt.sttEndpoint(settingsCache).baseUrl].filter(Boolean);
    const denied = await ensureOrigins(origins).then(() => null, (e) => e.message);
    const { parts, durationMs } = await globalThis.MeetWav.speechParts(file, IMPORT_PART_MS / 1000);
    if (!parts.length) throw new Error('This file has no audio to transcribe.');
    const baseTime = await store.freeRecId(file.lastModified - durationMs);
    const title = file.name.replace(/\.[^.]*$/, '');
    const added = await send({
      type: 'add-imported-meeting', title, startedAt: baseTime, endedAt: file.lastModified,
    });
    if (!added?.ok) throw new Error(added?.error ?? 'Could not reach the service worker.');
    id = added.id;
    await store.beginAudio({
      meetingId: id, chunkMs: IMPORT_PART_MS, baseTime, keep: settingsCache.keepRecordings, imported: true,
    });
    for (const part of parts) await store.appendChunk(part, baseTime);
    importNote = null;
    audioMetaKey = null;
    viewingId = id;
    if (denied) {
      momErrors.set(id, `${denied} Press Generate transcript to try again.`);
    } else {
      const res = await send({ type: 'regenerate-transcript', id, recId: baseTime }).catch(() => null);
      if (!res?.ok) {
        const reason = res?.error ?? 'Could not reach the service worker.';
        momErrors.set(id, `${reason} Press Generate transcript to try again.`);
      }
    }
  } catch (e) {
    if (id) await send({ type: 'delete-meeting', id }).catch(() => {});
    importNote = el('span', 'err', e.message);
  }
  render();
}

// Builds the action row above History, with the audio import button in the browser.
function historyActions() {
  const box = el('div', 'actions');
  if (!HAS_AUDIO || Host) return box;
  globalThis.MeetUi.mkImportButton(importFile, box);
  if (importNote) box.append(importNote);
  return box;
}

// Builds the History entries that match the search and tag, newest first, under date headings.
function historyList(items) {
  const found = items
    .filter((m) => hasTag(m, historyTag) && M.matchesSearch(m, historyQuery))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  if (!found.length) return [el('p', 'muted', 'No meetings match.')];
  const now = Date.now();
  let group = null;
  return found.flatMap((m) => {
    const heading = M.dateGroup(m.startedAt, now);
    const headed = heading === group ? [] : [el('h3', 'group', heading)];
    group = heading;
    const item = el('button', 'item');
    const count = m.segments.length;
    const segmentWord = count === 1 ? 'segment' : 'segments';
    const momMark = m.mom ? ' — MoM ✓' : '';
    item.append(
      raw(el('div', 'who', m.title)),
      el('div', 'muted', `${new Date(m.startedAt).toLocaleString()} — ${count} ${segmentWord}${momMark}`)
    );
    if (m.tags?.length) item.append(raw(el('div', 'tags muted', m.tags.map((tag) => `#${tag}`).join(' '))));
    const snippet = M.searchSnippet(m, historyQuery);
    if (snippet) item.append(raw(el('div', 'snippet', snippet)));
    item.addEventListener('click', () => { viewingId = m.id; render(); });
    return [...headed, item];
  });
}

const momSending = new Set();
let historyMode = 'list';
let askAllDraft = '';
let askAllState = { asking: false, question: '', answer: '', note: '', error: '' };

// Builds the "Ask all meetings" box with the last answer below it.
function askAllBox() {
  const box = el('div', 'ask');
  box.append(el('h3', null, 'Ask all meetings'));
  box.append(el('p', 'muted', 'Sends your MoMs, or transcripts where there is no MoM, to your AI service.'));
  const row = el('div', 'ask-row');
  const input = mkEl('input', {
    placeholder: 'Ask about all your meetings',
    value: askAllDraft,
    defaultValue: askAllDraft,
  });
  input.dataset.editKey = 'ask-all';
  input.setAttribute('aria-label', t('Ask about all your meetings'));
  input.addEventListener('input', () => { askAllDraft = input.value; });
  // Sends the typed question about all meetings and redraws with the answer or error.
  const send = async () => {
    const question = input.value.trim();
    if (!question || askAllState.asking) return;
    askAllDraft = '';
    input.value = '';
    input.defaultValue = '';
    askAllState = { asking: true, question, answer: '', note: '', error: '' };
    render();
    const res = await chrome.runtime.sendMessage({ type: 'ask-all', question }).catch(() => null);
    const note = res?.ok && res.left
      ? 'Some older or very long meetings did not fit, so they were cut short or left out.'
      : '';
    askAllState = {
      asking: false,
      question,
      answer: res?.ok ? res.answer : '',
      error: res?.ok ? '' : res?.error ?? 'Could not reach the service worker.',
      note,
    };
    render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });
  row.append(input);
  mkBtn('Ask', send, row);
  box.append(row);
  if (askAllState.asking) box.append(el('p', 'muted', 'Thinking…'));
  if (askAllState.error) box.append(el('p', 'err', askAllState.error));
  if (askAllState.answer) {
    const answer = el('div', 'mom');
    answer.append(raw(el('strong', null, askAllState.question)), raw(el('div', null, askAllState.answer)));
    if (askAllState.note) answer.append(el('p', 'muted', askAllState.note));
    box.append(answer);
  }
  return box;
}

// Builds the checklist of action items from every MoM, grouped by meeting, newest first.
function actionItemsView(items) {
  const box = el('div');
  box.append(el('h3', null, 'Action items'));
  const withItems = items
    .map((meeting) => ({ meeting, list: M.actionItems(meeting) }))
    .filter(({ list }) => list.length)
    .sort((a, b) => (b.meeting.startedAt ?? 0) - (a.meeting.startedAt ?? 0));
  if (!withItems.length) {
    box.append(el('p', 'muted', 'No action items yet. They come from the action sections of your MoMs.'));
  }
  for (const { meeting, list } of withItems) {
    box.append(raw(el('div', 'who', meeting.title)));
    for (const { text, done } of list) {
      const check = mkEl('input', { type: 'checkbox', checked: done });
      check.dataset.editKey = `item:${meeting.id}:${text}`;
      check.addEventListener('change', async () => {
        const change = { toggleItem: text };
        const res = await chrome.runtime.sendMessage({ type: 'edit-transcript', id: meeting.id, change })
          .catch(() => null);
        if (!res?.ok) check.checked = !check.checked;
      });
      const label = el('label', done ? 'action-item done' : 'action-item');
      label.append(check, raw(el('span', null, text)));
      const lineId = M.sourceLine(meeting, text);
      if (lineId === null) {
        box.append(label);
        continue;
      }
      const row = el('div', 'action-row');
      const show = mkBtn('Show in transcript', () => {
        viewingId = meeting.id;
        focusLine = lineId;
        render();
      }, row);
      show.classList.add('link');
      row.prepend(label);
      box.append(row);
    }
  }
  return box;
}

// Draws the History tab: import row, mode switch, ask box, tag filter, search, and meeting list.
async function renderHistory(epoch) {
  const { meetings = [] } = await chrome.storage.local.get('meetings');
  const items = (await Promise.all(meetings.map(getMeeting))).filter(Boolean);
  if (epoch !== renderEpoch) return;
  lastRenderedKey = null;
  const focusKey = document.activeElement?.dataset?.editKey;
  const previous = document.getElementById('history-search');
  const wasTyping = document.activeElement === previous && previous;
  const caret = wasTyping ? previous.selectionStart : 0;
  view.replaceChildren(historyActions());
  if (!items.length) {
    view.append(el('p', 'muted', 'No history yet.'));
    return;
  }
  const modeRow = el('div', 'actions');
  mkBtn(historyMode === 'actions' ? 'All meetings' : 'Action items', () => {
    historyMode = historyMode === 'actions' ? 'list' : 'actions';
    render();
  }, modeRow);
  view.append(modeRow);
  // Puts focus back on the field that had it before the redraw.
  const refocus = () => {
    if (focusKey) view.querySelector(`[data-edit-key="${CSS.escape(focusKey)}"]`)?.focus();
  };
  if (historyMode === 'actions') {
    view.append(actionItemsView(items));
    refocus();
    return;
  }
  view.append(askAllBox());
  const tags = M.allTags(items);
  if (historyTag && !tags.some((tag) => tag.toLowerCase() === historyTag.toLowerCase())) historyTag = null;
  if (tags.length) view.append(tagChips(tags));
  const search = mkEl('input', {
    type: 'search',
    id: 'history-search',
    value: historyQuery,
    placeholder: 'Search titles, transcripts, and MoM',
  });
  search.setAttribute('aria-label', 'Search meetings');
  const list = el('div');
  list.append(...historyList(items));
  search.addEventListener('input', () => {
    historyQuery = search.value;
    list.replaceChildren(...historyList(items));
  });
  view.append(search, list);
  refocus();
  if (wasTyping) {
    search.focus();
    search.setSelectionRange(caret, caret);
  }
}

// Draws the Settings tab: language, AI service, transcript, speech-to-text, sharing, storage, backup.
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
  // Adds a labelled row holding the input to the page and returns the input.
  const field = (label, input) => {
    const row = el('div');
    row.append(el('label', null, label), input);
    view.append(row);
    rowOf.set(input, row);
    return input;
  };
  // Shows or hides the row that holds an input.
  const show = (input, on) => {
    rowOf.get(input).hidden = !on;
  };
  const { DEFAULT_BASE_URL: DEFAULT_BASE, DEFAULT_MODEL } = globalThis.MeetOpenAI;
  view.append(el('h3', null, 'AI for minutes of meeting'));
  const preset = field('AI service', document.createElement('select'));
  const { LLM_PRESETS } = globalThis.MeetOpenAI;
  addOptions(preset, [...LLM_PRESETS.map((p) => [p.baseUrl, p.name]), ['', 'Other']]);
  const baseUrl = field('AI service address (OpenAI-compatible)',
    mkEl('input', { value: settings.baseUrl ?? DEFAULT_BASE }));
  // Selects the AI service preset whose address matches the typed one, or "Other".
  const matchPreset = () => {
    const typed = baseUrl.value.trim().replace(/\/+$/, '');
    preset.value = LLM_PRESETS.some((p) => p.baseUrl === typed) ? typed : '';
  };
  matchPreset();
  baseUrl.addEventListener('input', matchPreset);
  preset.addEventListener('change', () => {
    const chosen = LLM_PRESETS.find((p) => p.baseUrl === preset.value);
    if (!chosen) return;
    baseUrl.value = chosen.baseUrl;
    model.value = chosen.model;
    apiKeyGuard.sync();
    sttKeyGuard.sync();
  });
  const apiKey = field('API key',
    mkEl('input', { type: 'password', value: settings.apiKey ?? '' }));
  const apiKeyGuard = keepKeyWithAddress(() => baseUrl.value.trim() || DEFAULT_BASE, [baseUrl], apiKey);
  const model = field('Model',
    mkEl('input', { value: settings.model ?? DEFAULT_MODEL }));
  const modelList = mkEl('datalist', { id: 'llm-models' });
  model.setAttribute('list', modelList.id);
  rowOf.get(model).append(modelList);
  const momType = field('MoM type', document.createElement('select'));
  addOptions(momType, [...M.MOM_PRESETS.map((p) => [p.name, p.name]), ['', 'Custom']]);
  const template = field('MoM template ({{transcript}} = transcript)',
    mkEl('textarea', { value: M.momTemplateOf(settings.momTemplate) }));
  // Selects the MoM type whose template matches the text, or "Custom".
  const matchMomType = () => {
    momType.value = M.MOM_PRESETS.find((p) => p.template === template.value)?.name ?? '';
  };
  matchMomType();
  template.addEventListener('input', matchMomType);
  momType.addEventListener('change', () => {
    const chosen = M.MOM_PRESETS.find((p) => p.name === momType.value);
    if (chosen) template.value = chosen.template;
  });
  const autoMomBox = mkEl('input', { type: 'checkbox', checked: !!settings.autoMom });
  const autoMomLabel = el('label');
  autoMomLabel.append(autoMomBox, 'Make MoM automatically when a transcript is ready (sends it to your LLM)');
  autoMomBox.addEventListener('change', () => patchSettings({ autoMom: autoMomBox.checked }));
  view.append(autoMomLabel);
  view.append(el('h3', null, 'Transcript'));
  const source = field('Transcript source',
    document.createElement('select'));
  addOptions(source, [
    ['caption', 'Meet captions'],
    ['both', 'Meet captions + recorded audio'],
    ['audio', 'Record audio'],
  ]);
  source.value = Host ? 'audio' : settings.transcriptSource ?? 'caption';
  const sourceInfo = el('div', 'muted',
    'Captions keep the speaker names. When you stop, recorded audio fixes lines it clearly heard differently and adds what the captions missed. Press Record in each meeting, and turn on Record microphone so your own voice is covered too.');
  rowOf.get(source).append(sourceInfo);
  source.addEventListener('change', () => applyMode());
  const hideBox = mkEl('input', { type: 'checkbox', checked: settings.hideCaptions !== false });
  const hideLabel = el('label');
  hideLabel.append(hideBox, 'Hide captions on the Meet screen (transcript keeps running)');
  hideBox.addEventListener('change', () => patchSettings({ hideCaptions: hideBox.checked }));
  const hideRow = el('div');
  hideRow.append(hideLabel);
  hideRow.hidden = !!Host;
  view.append(hideRow);
  const captionLang = field('Meet caption language', document.createElement('select'));
  addOptions(captionLang, CAPTION_LANGUAGES);
  captionLang.value = settings.captionLang ?? 'en';
  show(captionLang, !Host);
  captionLang.addEventListener('change', () => patchSettings({ captionLang: captionLang.value }));
  const micWrap = el('div');
  const micOn = Host ? settings.mic !== false : !!settings.mic;
  const micBox = mkEl('input', { type: 'checkbox', checked: micOn });
  micBox.addEventListener('change', () => patchSettings({ mic: micBox.checked }));
  const micLabel = el('label');
  micLabel.append(micBox, 'Record microphone');
  const micBtn = el('button', null, 'Allow microphone');
  micBtn.addEventListener('click',
    () => chrome.runtime.sendMessage({ type: 'open-mic-permission' }).catch(() => {}));
  const micRow = el('div', 'actions');
  micRow.append(micBtn);
  micBtn.hidden = !!Host;
  micWrap.append(micLabel, micRow, el('div', 'muted',
    'Without a headset, voices from your speakers can leak into the mic. Repeated lines are removed where possible.'));
  micWrap.hidden = !HAS_AUDIO;
  view.append(micWrap);
  const ST = globalThis.MeetStt;
  const sttModeSel = field('Speech-to-text engine',
    document.createElement('select'));
  const engineSaved = ST.sttMode(settings) === 'builtin';
  if (hasEngine || engineSaved) addOptions(sttModeSel, [['builtin', 'Built-in (on this computer)']]);
  addOptions(sttModeSel, [
    ['whisper-local', 'Your own Whisper server'],
    ['api', 'Online speech-to-text service'],
  ]);
  sttModeSel.value = ST.sttMode(settings);
  const INFO = {
    builtin: 'Audio stays on this computer, and no server or internet is needed. Speed depends on your computer. Choose higher accuracy below.',
    'whisper-local': 'Audio goes to your own OpenAI-compatible whisper server '
      + '(whisper.cpp, faster-whisper, and others) at the URL below. Audio stays on '
      + 'your network, but the server must be running during transcription. If it is down, '
      + 'transcription fails and the audio stays saved so you can try again.',
  };
  const sttInfo = el('div', 'info');
  view.append(sttInfo);
  const savedMode = ST.sttMode(settings);
  const initialUrl = settings.sttBaseUrl || (savedMode === 'whisper-local' ? ST.WHISPER_DEFAULT : '');
  const sttBaseUrl = field('Speech-to-text address',
    mkEl('input', { value: initialUrl }));
  const sttApiKey = field('Speech-to-text API key (empty if none)',
    mkEl('input', { type: 'password', value: settings.sttApiKey ?? '' }));
  const sttKeyGuard = keepKeyWithAddress(
    () => sttBaseUrl.value.trim() || baseUrl.value.trim() || DEFAULT_BASE,
    [sttBaseUrl, baseUrl],
    sttApiKey,
    () => sttModeSel.value === 'builtin',
  );
  const sttModel = field('Speech-to-text model',
    mkEl('input', { value: settings.sttModel ?? ST.DEFAULT_API_MODEL }));
  const sttLanguage = field('Speech language (empty = detect automatically, or a code such as id, en, ja)',
    mkEl('input', { value: settings.sttLanguage ?? ST.DEFAULT_LANGUAGE }));
  const sttVocabulary = field('Names and terms to spell correctly (optional, separated by commas)',
    mkEl('textarea', { value: settings.sttVocabulary ?? '', rows: 2 }));
  // Shows only the transcript and speech-to-text fields that the chosen source and engine use.
  function applyMode() {
    const audio = HAS_AUDIO;
    const mode = sttModeSel.value;
    show(source, HAS_AUDIO && !Host);
    sourceInfo.hidden = source.value !== 'both';
    show(sttModeSel, audio);
    show(sttBaseUrl, audio && mode !== 'builtin');
    show(sttApiKey, audio && mode === 'api');
    show(sttModel, audio && mode === 'api');
    show(sttLanguage, audio);
    show(sttVocabulary, audio);
    const info = audio && INFO[mode];
    sttInfo.textContent = info ? 'ⓘ ' + INFO[mode] : '';
    sttInfo.hidden = !info;
  }
  const urlByMode = { 'whisper-local': ST.WHISPER_DEFAULT, api: '', builtin: '' };
  let urlMode = savedMode;
  urlByMode[urlMode] = initialUrl;
  if (savedMode === 'builtin' && settings.sttBaseUrl) {
    const urlKind = ST.isLocalUrl(settings.sttBaseUrl) ? 'whisper-local' : 'api';
    urlByMode[urlKind] = settings.sttBaseUrl;
  }
  sttModeSel.addEventListener('change', () => {
    urlByMode[urlMode] = sttBaseUrl.value.trim();
    urlMode = sttModeSel.value;
    sttBaseUrl.value = urlByMode[urlMode];
    sttKeyGuard.sync();
    applyMode();
  });
  applyMode();
  const note = el('span', 'muted', '');
  // Shows a result message next to the Test connection and Save buttons.
  const setNote = (cls, text) => {
    note.className = cls;
    note.textContent = ' ' + text;
  };
  // Returns the AI service address without trailing slashes, falling back to the default.
  const normalizedBase = () => (baseUrl.value.trim() || DEFAULT_BASE).replace(/\/+$/, '');
  // Returns the typed speech-to-text address without trailing slashes.
  const sttBaseValue = () => sttBaseUrl.value.trim().replace(/\/+$/, '');
  // Returns the speech-to-text address to save and test, or '' when no STT server is used.
  const sttBaseForSave = () => {
    const usesSttServer = HAS_AUDIO && source.value !== 'caption' && sttModeSel.value !== 'builtin';
    return usesSttServer ? sttBaseValue() : '';
  };
  // Checks that the speech-to-text server answers, returning a note when it cannot list models.
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
      throw new Error(`STT ${host}: HTTP ${res.status} (wrong or empty Online speech-to-text service key?)`);
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
      const sttBase = sttBaseForSave();
      await ensureOrigins(sttBase ? [base, sttBase] : [base]);
      await globalThis.MeetOpenAI.testConnection({
        apiKey: apiKey.value.trim(),
        model: model.value.trim() || DEFAULT_MODEL,
        baseUrl: base,
      });
      const sttNote = sttBase ? await probeStt(sttBase, sttApiKey.value.trim()) : '';
      const tested = sttBase ? ' (chat + STT)' : '';
      setNote('ok', `✓ Connection OK${tested}: URL, API key, and model are valid.${sttNote}`);
    } catch (e) {
      setNote('err', '✗ Failed: ' + (e?.message ?? e));
    } finally {
      await fillModels(modelList, normalizedBase(), apiKey.value.trim());
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
  // Asks for host access, writes every field to the settings, and reports the outcome.
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
        sttVocabulary: sttVocabulary.value.trim(),
        sttBaseUrl: sttModeSel.value === 'builtin' ? cur.sttBaseUrl ?? '' : sttBaseValue(),
        sttApiKey: sttApiKey.value.trim(),
      },
    });
    apiKeyGuard.remember();
    sttKeyGuard.remember();
    const noPlaceholder = !template.value.includes('{{transcript}}');
    if (warning) {
      setNote('err', `Saved, but ${warning} Requests may fail.`);
    } else if (noPlaceholder) {
      setNote('err', 'Saved, but the MoM template has no {{transcript}}, so MoM will be made without the transcript.');
    } else {
      setNote('ok', 'Saved.');
    }
  }
  const actions = el('div', 'actions');
  actions.append(test, save, note);
  view.append(actions);
  view.append(el('h3', null, 'Sending the MoM'));
  // Adds a field that saves its trimmed value to the given settings key when changed.
  const secretField = (key, label, type) => {
    const input = field(label, mkEl('input', { type, value: settings[key] ?? '' }));
    input.addEventListener('change', () => patchSettings({ [key]: input.value.trim() }));
  };
  secretField('slackWebhook', 'Slack webhook address', 'password');
  secretField('notionToken', 'Notion token', 'password');
  secretField('notionPage', 'Notion page link (new MoMs go under it)', 'text');
  view.append(el('h3', null, 'Storage'));
  const keepDays = field('Delete meetings older than this many days (empty = keep them)',
    mkEl('input', { type: 'number', min: 1, value: settings.deleteAfterDays ?? '' }));
  let keptDays = settings.deleteAfterDays ?? '';
  keepDays.addEventListener('change', async () => {
    const days = Number(keepDays.value);
    if (days > 0
      && !confirm(globalThis.MeetI18n.t('Older meetings and their recordings are deleted now, and whenever the app starts. This cannot be undone. Continue?'))) {
      keepDays.value = keptDays;
      return;
    }
    keptDays = days > 0 ? days : '';
    await patchSettings({ deleteAfterDays: days > 0 ? days : null });
    await chrome.runtime.sendMessage({ type: 'delete-old-meetings' }).catch(() => {});
  });
  const keepRecordings = field('Recordings to keep (older ones are deleted when a new recording starts)',
    mkEl('input', {
      type: 'number',
      min: 1,
      max: 100,
      value: globalThis.MeetAudioStore.keepCount(settings.keepRecordings),
    }));
  show(keepRecordings, HAS_AUDIO);
  keepRecordings.addEventListener('change', () => {
    const count = globalThis.MeetAudioStore.keepCount(keepRecordings.value);
    keepRecordings.value = count;
    patchSettings({ keepRecordings: count });
  });
  for (const row of Host?.settingsRows(settings) ?? []) view.append(row);
  view.append(el('h3', null, 'Backup'));
  const backupNote = el('span', 'muted', '');
  // Shows a result message next to the backup buttons.
  const setBackupNote = (cls, text) => {
    backupNote.className = cls;
    backupNote.textContent = ' ' + text;
  };
  const exportBtn = el('button', null, 'Export backup (.zip)');
  exportBtn.addEventListener('click', async () => {
    if (recState.recording || recState.transcribing || status.inCall) {
      return setBackupNote('err',
        '✗ A recording, transcript, or meeting is running, so the backup would be incomplete. Wait until it finishes.');
    }
    exportBtn.disabled = true;
    setBackupNote('muted', 'Building zip…');
    try {
      const zip = await globalThis.MeetBackup.exportBackup({
        includeKeys: keysBox.checked,
        password: passwordBox.value,
      });
      download(`transcripables-backup-${new Date().toISOString().slice(0, 10)}.zip`, zip);
      const size = zip.size < 1048576
        ? `${Math.max(1, Math.round(zip.size / 1024))} KB`
        : `${(zip.size / 1048576).toFixed(1)} MB`;
      setBackupNote('ok', `✓ Backup ready (${size}).`);
    } catch (e) {
      setBackupNote('err', '✗ Export failed: ' + (e?.message ?? e));
    } finally {
      exportBtn.disabled = false;
    }
  });
  const importInput = mkEl('input', { type: 'file', accept: '.zip,application/zip', hidden: true });
  const importBtn = el('button', null, 'Import backup');
  importBtn.addEventListener('click', () => {
    importInput.value = '';
    importInput.click();
  });
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    if (recState.recording || recState.transcribing || status.inCall) {
      return setBackupNote('err',
        '✗ A recording, transcript, or meeting is running. Stop it or leave before importing.');
    }
    if (!confirm(t('Import REPLACES all current data (history, settings, saved recordings). Continue?'))) return;
    importBtn.disabled = true;
    setBackupNote('muted', 'Importing…');
    try {
      const result = await globalThis.MeetBackup.importBackup(file, { password: passwordBox.value });
      await loadSettings();
      audioMetaKey = null;
      const recordingParts = result.chunks ? `, ${result.chunks} recording parts` : '';
      const message = result.audioError
        ? `Import PARTLY finished: ${result.meetings} meetings restored, but audio and video could not be restored (${result.audioError}). The old data has been replaced.`
        : `Import finished: ${result.meetings} meetings${recordingParts}.`;
      alert(t(message));
      render();
    } catch (e) {
      setBackupNote('err', '✗ Import failed: ' + (e?.message ?? e));
    } finally {
      importBtn.disabled = false;
    }
  });
  const keysBox = mkEl('input', { type: 'checkbox' });
  const keysLabel = el('label');
  keysLabel.append(keysBox, 'Include API keys in the backup, locked with a password');
  const passwordBox = mkEl('input', {
    type: 'password',
    autocomplete: 'new-password',
    placeholder: t('Backup password'),
  });
  passwordBox.setAttribute('aria-label', t('Backup password'));
  const passwordRow = el('label', 'muted',
    'Backup password, needed to export with API keys and to import a backup that has them');
  passwordRow.append(passwordBox);
  view.append(keysLabel, passwordRow);
  const backupRow = el('div', 'actions');
  backupRow.append(exportBtn, importBtn, importInput, backupNote);
  view.append(backupRow);
  view.append(el('div', 'muted',
    'Backups hold transcripts, MoM, and Settings, not recording files. Audio and '
    + 'video are left out because they can reach hundreds of MB each. Download them from '
    + 'the History entry → Download. Importing a backup also DELETES '
    + 'the recordings saved at that moment.'));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    settingsCache = changes.settings.newValue ?? {};
    if (tab === 'live') render();
  }
});

// Loads the language and settings, picks up the active meeting and recording, then draws the panel.
(async () => {
  await globalThis.MeetI18n.follow();
  await loadSettings();
  const active = await chrome.runtime.sendMessage({ type: 'get-active' }).catch(() => null);
  if (active) status = active;
  if (active?.rec) {
    recState = {
      ...recState,
      recording: active.rec.recording,
      transcribing: active.rec.transcribing,
      muted: active.rec.muted,
      paused: !!active.rec.paused,
      saving: active.rec.transcribing && active.rec.autoStt === false,
    };
  }
  if (active?.panelTab) selectTab(active.panelTab);
  if (active?.panelMeetingId) viewingId = active.panelMeetingId;
  render();
})();

// Lists what the Ctrl+K palette can do: switch tabs, press a visible button, or open a meeting.
function paletteEntries(meetings) {
  const tabs = [['live', 'Live'], ['history', 'History'], ['settings', 'Settings']]
    .map(([name, label]) => ({
      kind: 'Tab',
      label: t(`Go to ${label}`),
      run: () => { selectTab(name); render(); },
    }));
  const buttons = [...view.querySelectorAll('button')]
    .filter((b) => !b.disabled && !b.matches('.play, .item') && b.textContent.trim())
    .map((b) => ({ kind: 'Action', label: b.textContent.trim(), run: () => b.click() }));
  const opened = meetings.map((m) => ({
    kind: 'Meeting',
    label: m.title,
    run: () => { selectTab('history'); viewingId = m.id; render(); },
  }));
  return [...tabs, ...buttons, ...opened];
}

// Opens the Ctrl+K palette, which filters entries as you type and runs the chosen one.
async function openPalette() {
  if (document.querySelector('dialog.palette[open]')) return;
  document.querySelectorAll('dialog.palette').forEach((closed) => closed.remove());
  const { meetings: ids = [] } = await chrome.storage.local.get('meetings');
  const stored = ids.length ? await chrome.storage.local.get(ids.map(meetingKey)) : {};
  const entries = paletteEntries(ids.map((id) => stored[meetingKey(id)]).filter(Boolean));
  const palette = el('dialog', 'palette');
  const input = mkEl('input', { type: 'search', placeholder: t('Search actions and meetings') });
  input.setAttribute('aria-label', t('Search actions and meetings'));
  const list = el('div', 'palette-list');
  list.setAttribute('role', 'listbox');
  let shown = [];
  let at = 0;
  // Closes the palette and runs the chosen entry.
  const choose = (entry) => {
    palette.close();
    entry.run();
  };
  // Redraws the list with up to 50 entries that contain every typed word, highlighting the current one.
  const draw = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    shown = entries
      .filter((entry) => words.every((word) => entry.label.toLowerCase().includes(word)))
      .slice(0, 50);
    at = Math.min(at, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.map((entry, i) => {
      const row = el('button', i === at ? 'palette-row active' : 'palette-row');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === at));
      row.append(raw(el('span', null, entry.label)), el('span', 'muted', entry.kind));
      row.addEventListener('click', () => choose(entry));
      return row;
    }));
    if (!shown.length) list.append(el('div', 'muted', 'No matches'));
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => {
    at = 0;
    draw();
  });
  input.addEventListener('keydown', (ev) => {
    if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && shown.length) {
      ev.preventDefault();
      const step = ev.key === 'ArrowDown' ? 1 : -1;
      at = (at + step + shown.length) % shown.length;
      draw();
    } else if (ev.key === 'Enter' && shown[at]) {
      ev.preventDefault();
      choose(shown[at]);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      palette.close();
    }
  });
  palette.addEventListener('close', () => palette.remove());
  palette.append(input, list);
  document.body.append(palette);
  draw();
  palette.showModal();
  input.focus();
}

addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === 'k') {
    ev.preventDefault();
    openPalette().catch((e) => console.error(e));
  }
});
