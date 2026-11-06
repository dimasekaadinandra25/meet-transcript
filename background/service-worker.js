if (typeof importScripts === 'function') {
  importScripts('/lib/i18n.js', '/content/session.js', '/lib/merge.js', '/lib/openai.js', '/lib/stt.js', '/lib/audiostore.js');
}

if (chrome.sidebarAction) {
  chrome.action?.onClicked.addListener(() => chrome.sidebarAction.toggle());
}

const ACTIVE_IDLE = { id: null, inCall: false, captionsOn: false, lastSegmentAt: 0, captionsOnAt: 0 };
let active = { ...ACTIVE_IDLE };
const meetingKey = (id) => 'meeting:' + id;
const newMeeting = (id, title, startedAt) => ({ id, title, startedAt, endedAt: null, segments: [], mom: null });

function notifyPanel(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

chrome.action?.setBadgeBackgroundColor({ color: '#d93025' });
chrome.action?.setBadgeTextColor?.({ color: '#ffffff' });
function updateBadge() {
  const recording = (active.inCall && active.captionsOn) || rec.recording;
  chrome.action?.setBadgeText({ text: recording ? '●' : '' });
}

const REC_IDLE = { recording: false, transcribing: false, meetingId: null };
let rec = { ...REC_IDLE };
const recBusy = () => rec.recording || rec.transcribing;

function resetRec() {
  rec = { ...REC_IDLE };
  updateBadge();
}

function closeOffscreen() {
  chrome.offscreen?.closeDocument?.().catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => {
  globalThis.caches?.delete('transformers-cache')?.catch(() => {});
  chrome.storage.local.remove('captionsHidden').catch(() => {});
});

function titleFromTab(tabTitle, meetingId) {
  const t = String(tabTitle ?? '')
    .replace(/^\(\d+\)\s*/, '')
    .replace(/^Meet\s*[-—–]\s*/, '')
    .replace(/\s*[-—–]\s*Google Meet\s*$/, '')
    .trim();
  return !t || t === meetingId ? meetingId : t;
}

function recError(error) {
  console.warn('[rec]', error);
  broadcastRec({ error });
}

function broadcastRec(extra = {}) {
  notifyPanel({ type: 'rec-state', recording: rec.recording, transcribing: rec.transcribing,
    saving: rec.transcribing && rec.autoStt === false, ...extra });
}

async function hasOffscreen() {
  if (!chrome.runtime.getContexts) return false;
  const c = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).catch(() => []);
  return c.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Record Meet tab audio and video for transcripts and recordings.',
  });
}

const recRestored = (async () => {
  if (!(await hasOffscreen())) return;
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', op: 'state' })
    .catch(() => null);
  if (!res?.ok || (!res.recording && !res.transcribing)) return;
  if (recBusy()) return;
  rec = { recording: res.recording, transcribing: res.transcribing, meetingId: res.meetingId,
    tabId: res.tabId ?? null, autoStt: res.autoStt };
  updateBadge();
  broadcastRec();
})().catch((e) => console.warn('[rec] could not restore state', e.message));

const DISCORD_RE = /^\/channels\/(@me|\d+)\/(\d+)/;
const ZOOM_RE = /^\/wc\/(?:join\/)?(\d+)(?:\/(?:join|start))?/;
const TEAMS_HOSTS = new Set(['teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft']);
const TEAMS_THREAD_RE = /19:meeting_([A-Za-z0-9_-]+)@thread\.v2/;
const TEAMS_SHORT_RE = /^\/meet\/(\d+)\/?$/;
const WEBEX_MTID_RE = /[?&]MTID=m([0-9a-f]{32})(?![0-9a-f])/i;
const WEBEX_HEX_RE = /\/([0-9a-f]{32})(?=[/?#]|$)/i;
const WEBEX_ROOM_RE = /^\/(?:meet|join)\/([A-Za-z0-9._-]+)\/?$/;
const SLACK_RE = /^\/(?:client|huddle)\/([TE][A-Z0-9]+)\/([CDG][A-Z0-9]+)(?=[/?#]|$)/;

function decodeTwice(s) {
  let out = s;
  for (let i = 0; i < 2; i++) {
    try { out = decodeURIComponent(out); } catch { break; }
  }
  return out;
}

function meetingIdFromUrl(url) {
  try {
    const { hostname, pathname, search, hash } = new URL(url);
    if (hostname === 'discord.com') {
      const m = pathname.match(DISCORD_RE);
      return m ? `discord-${m[1] === '@me' ? 'dm' : m[1]}-${m[2]}` : null;
    }
    if (hostname === 'zoom.us' || hostname.endsWith('.zoom.us')) {
      const m = pathname.match(ZOOM_RE);
      return m ? `zoom-${m[1]}` : null;
    }
    if (TEAMS_HOSTS.has(hostname)) {
      const t = decodeTwice(pathname + search + hash).match(TEAMS_THREAD_RE);
      if (t) return `teams-${t[1]}`;
      const s = pathname.match(TEAMS_SHORT_RE);
      return s ? `teams-${s[1]}` : null;
    }
    if (hostname.endsWith('.webex.com')) {
      const m = search.match(WEBEX_MTID_RE) ?? pathname.match(WEBEX_HEX_RE);
      if (m) return `webex-${m[1].toLowerCase()}`;
      const r = pathname.match(WEBEX_ROOM_RE);
      return r ? `webex-${hostname.split('.')[0]}-${r[1].toLowerCase()}` : null;
    }
    if (hostname === 'app.slack.com') {
      const m = pathname.match(SLACK_RE);
      return m ? `slack-${m[1]}-${m[2]}` : null;
    }
    if (hostname !== 'meet.google.com') return null;
    return globalThis.MeetSession.meetingIdFrom(pathname);
  } catch {
    return null;
  }
}

async function startFromTab(tab, video) {
  if (recBusy() || await hasOffscreen()) {
    recError('A recording is still running.');
    return;
  }
  const meetingId = meetingIdFromUrl(tab?.url);
  if (!meetingId) {
    recError('Open a Meet, Teams, or Webex room, a Slack huddle, a Discord channel, or Zoom web'
      + ' (zoom.us/wc/...) first, because recording takes audio from this tab. Tab URL: ' + (tab?.url ?? '(unreadable)'));
    return;
  }
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    await startRecording({ streamId, meetingId, title: titleFromTab(tab?.title, meetingId), video, tabId: tab.id });
  } catch (e) {
    recError(e.message);
  }
}

if (!chrome.tabCapture) {
  const useCaptionsOnly = async () => {
    const { settings } = await chrome.storage.local.get('settings');
    if (settings?.transcriptSource !== 'audio') return;
    await chrome.storage.local.set({ settings: { ...settings, transcriptSource: 'caption' } });
  };
  useCaptionsOnly();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) useCaptionsOnly();
  });
}

if (chrome.tabCapture) {
  const RECORDABLE = ['https://meet.google.com/*', 'https://discord.com/channels/*'];
  const MENU = [
    ['rec-start', 'Record meeting audio'],
    ['rec-start-video', 'Record meeting audio + video'],
    ['rec-stop', 'Stop recording'],
  ];
  const { t, follow } = globalThis.MeetI18n;
  const languageReady = follow();
  const titleMenus = () => {
    for (const [id, title] of MENU) chrome.contextMenus.update(id, { title: t(title) })?.catch(() => {});
  };
  languageReady.then(() => {
    titleMenus();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) titleMenus();
    });
  });
  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
      for (const [id, title] of MENU) {
        chrome.contextMenus.create({ id, title, contexts: ['page'], documentUrlPatterns: RECORDABLE });
      }
      languageReady.then(titleMenus);
    });
  });
  const runCommand = (id, tab) => {
    if (id === 'rec-start' || id === 'rec-start-video') startFromTab(tab, id === 'rec-start-video');
    else if (id === 'rec-stop') stopRecording();
  };
  chrome.contextMenus.onClicked.addListener((info, tab) => runCommand(info.menuItemId, tab));
  chrome.commands?.onCommand.addListener(runCommand);
}

async function sttConfig() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const stt = globalThis.MeetStt.sttEndpoint(settings);
  return {
    sttMode: stt.mode, baseUrl: stt.baseUrl, apiKey: stt.apiKey,
    sttModel: stt.model, sttLanguage: stt.language,
    mic: !!settings.mic,
    transcriptSource: settings.transcriptSource ?? 'caption',
  };
}

function autoTranscribe(meetingId, transcriptSource) {
  return globalThis.MeetSession.isMeetCode(meetingId) && (transcriptSource === 'audio' || transcriptSource === 'both');
}

let micWin = null;
async function askMicPermission() {
  if (micWin != null) return;
  micWin = -1;
  const w = await chrome.windows.create({
    url: chrome.runtime.getURL('panel/mic.html'), type: 'popup', width: 460, height: 240, focused: true,
  }).catch(() => null);
  micWin = w?.id ?? null;
}
chrome.windows?.onRemoved.addListener((id) => { if (id === micWin) micWin = null; });

let startPromise = null;

async function startRecording({ streamId, meetingId, title, video, tabId }) {
  if (recBusy()) throw new Error('A recording is still running.');
  const baseTime = Date.now();
  rec = { recording: true, transcribing: false, meetingId, tabId };
  updateBadge();
  startPromise = (async () => {
    if (await hasOffscreen()) throw new Error('A recording is still running.');
    await startRecordingInner({ streamId, meetingId, title, baseTime, video, tabId });
  })();
  try {
    await startPromise;
  } catch (e) {
    resetRec();
    closeOffscreen();
    broadcastRec();
    throw e;
  } finally {
    startPromise = null;
  }
}

async function startRecordingInner({ streamId, meetingId, title, baseTime, video, tabId }) {
  const stt = await sttConfig();
  await ensureOffscreen();
  broadcastRec({ error: null });
  const transcribe = autoTranscribe(meetingId, stt.transcriptSource);
  rec.autoStt = transcribe;
  const res = await chrome.runtime.sendMessage({
    target: 'offscreen', op: 'start', streamId, meetingId, ...stt,
    chunkMs: 600000, baseTime, video: !!video, transcribe, tabId,
  }).catch((e) => ({ ok: false, error: e.message }));
  if (!res?.ok) throw new Error(res?.error || 'The recorder did not respond, so recording did not start.');
  enqueueWrite(() => ensureMeeting({ meetingId, title, startedAt: baseTime }));
}

async function regenerateTranscript(meetingId, recId) {
  if (recBusy()) throw new Error('A recording or transcript is still running.');
  if (!Number.isFinite(Number(recId))) {
    throw new Error('No recording was named for retranscribing (empty recId).');
  }
  rec = { recording: false, transcribing: true, meetingId };
  updateBadge();
  broadcastRec({ error: null });
  try {
    const target = (await globalThis.MeetAudioStore.listRecordings())
      .find((r) => r.recId === Number(recId));
    if (!target) {
      throw new Error('That recording is no longer saved. Only the last 5 recordings are kept.');
    }
    if (target.meetingId !== meetingId) {
      throw new Error('That recording belongs to another meeting, so it cannot be retranscribed here.');
    }
    const stt = await sttConfig();
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({
      target: 'offscreen', op: 'retranscribe', meetingId, recId: target.recId, ...stt,
    });
    if (!res?.ok) throw new Error(res?.error || 'The recorder did not respond, so retranscribing did not start.');
  } catch (e) {
    resetRec();
    broadcastRec();
    throw e;
  }
}

async function stopRecording() {
  if (startPromise) await startPromise.catch(() => {});
  if (rec.transcribing || (!rec.recording && !(await hasOffscreen()))) return;
  rec.recording = false;
  rec.transcribing = true;
  updateBadge();
  broadcastRec();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', op: 'stop' })
    .catch(() => null);
  if (res?.ok) return;
  if (res?.busy) {
    broadcastRec({ error: res.error });
    return;
  }
  resetRec();
  broadcastRec({ error: res?.error ?? 'The recorder did not respond, so recording stopped without a transcript.' });
}

async function storeMeeting(meetingId, meeting, data) {
  const meetings = data.meetings ?? [];
  if (!meetings.includes(meetingId)) meetings.unshift(meetingId);
  await chrome.storage.local.set({ [meetingKey(meetingId)]: meeting, meetings });
}

async function archiveIfStale(meetingId, data) {
  const key = meetingKey(meetingId);
  const old = data[key];
  if (!old || !globalThis.MeetMerge.isStaleMeeting(old, Date.now())) return;
  const lastActivity = globalThis.MeetMerge.lastActivityAt(old);
  const archiveId = `${meetingId}@${lastActivity}`;
  const meetings = data.meetings ?? [];
  const i = meetings.indexOf(meetingId);
  if (i !== -1) meetings[i] = archiveId; else meetings.unshift(archiveId);
  data.meetings = meetings;
  await chrome.storage.local.set({
    [meetingKey(archiveId)]: { ...old, id: archiveId, endedAt: old.endedAt ?? lastActivity },
  });
  await chrome.storage.local.remove(key);
  delete data[key];
  await globalThis.MeetAudioStore.retagAudioMeta(meetingId, archiveId, lastActivity).catch(() => {});
  notifyPanel({ type: 'meeting-updated', id: archiveId });
}

async function ensureMeeting({ meetingId, title, startedAt }) {
  const key = meetingKey(meetingId);
  const data = await chrome.storage.local.get([key, 'meetings']);
  await archiveIfStale(meetingId, data);
  const meeting = data[key] ?? newMeeting(meetingId, title || meetingId, startedAt);
  if (!(meeting.startedAt <= startedAt)) meeting.startedAt = startedAt;
  meeting.source = 'audio';
  meeting.endedAt = null;
  if (title) meeting.title = title;
  await storeMeeting(meetingId, meeting, data);
  notifyPanel({ type: 'meeting-updated', id: meetingId });
}

async function saveAudioTranscript({ meetingId, segments, baseTime, replace, legacy }) {
  let key = meetingKey(meetingId);
  const data = await chrome.storage.local.get([key, 'meetings']);
  if (data[key] && baseTime && data[key].startedAt > baseTime) {
    const ids = (data.meetings ?? []).filter((m) => String(m).startsWith(meetingId + '@'));
    const recs = await chrome.storage.local.get(ids.map((id) => meetingKey(id)));
    const owner = globalThis.MeetMerge.ownerOfRecording(
      ids.map((id) => recs[meetingKey(id)]), baseTime);
    if (owner) {
      meetingId = owner.id;
      key = meetingKey(meetingId);
      data[key] = owner;
    }
  }
  const meeting = data[key] ?? newMeeting(meetingId, meetingId, baseTime ?? Date.now());
  meeting.source = 'audio';
  meeting.segments = globalThis.MeetMerge.replaceAudioSegments(
    meeting.segments, segments, { baseTime: baseTime ?? 0, replace: !!replace, legacy: !!legacy });
  await storeMeeting(meetingId, meeting, data);
  notifyPanel({ type: 'meeting-updated', id: meetingId });
  const tag = `audio:${baseTime ?? 0}:`;
  const { settings = {} } = await chrome.storage.local.get('settings');
  const expected = settings.transcriptSource === 'both' && !replace;
  if (segments.length && !expected && !meeting.segments.some((s) => String(s.id ?? '').startsWith(tag))) {
    broadcastRec({ error: 'The audio transcript matches the captions, so no new lines were added.' });
  }
  return meetingId;
}

async function saveSegments({ meetingId, title, segs }) {
  const key = meetingKey(meetingId);
  const data = await chrome.storage.local.get([key, 'meetings']);
  await archiveIfStale(meetingId, data);
  const meeting = data[key] ?? newMeeting(meetingId, title || meetingId, Date.now());
  if (title) meeting.title = title;
  meeting.endedAt = null;
  for (const seg of segs) globalThis.MeetMerge.upsertSegment(meeting.segments, seg);
  await storeMeeting(meetingId, meeting, data);
  if (!active.id || active.id === meetingId) active.lastSegmentAt = Date.now();
  notifyPanel({ type: 'meeting-updated', id: meetingId });
}

async function autoMom(id) {
  const key = meetingKey(id);
  const { settings = {}, [key]: meeting } = await chrome.storage.local.get(['settings', key]);
  if (!settings.autoMom || !globalThis.MeetMerge.canMakeMom(settings) || !meeting?.segments.length) return;
  try {
    await generateMomOnce(id);
    notifyPanel({ type: 'meeting-updated', id });
  } catch (e) {
    broadcastRec({ error: `MoM could not be made automatically: ${e.message}` });
  }
}

async function endMeeting(meetingId) {
  if (active.id === meetingId) {
    active = { ...ACTIVE_IDLE };
    updateBadge();
    notifyPanel({ type: 'status', ...active });
  }
  const key = meetingKey(meetingId);
  const { settings = {}, ...data } = await chrome.storage.local.get([key, 'settings']);
  if (!data[key]) return;
  data[key].endedAt = Date.now();
  await chrome.storage.local.set({ [key]: data[key] });
  notifyPanel({ type: 'meeting-updated', id: meetingId });
  const transcriptComing = data[key].source === 'audio' && autoTranscribe(meetingId, settings.transcriptSource);
  if (!transcriptComing) autoMom(meetingId).catch((e) => console.error(e));
}

async function generateMom(id) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  if (!globalThis.MeetMerge.canMakeMom(settings)) throw new Error('Add an API key in the Settings tab first.');
  const key = meetingKey(id);
  const data = await chrome.storage.local.get(key);
  const meeting = data[key];
  if (!meeting || !meeting.segments.length) throw new Error('The transcript is empty.');
  const transcript = globalThis.MeetMerge.formatTranscript(meeting.segments);
  const prompt = globalThis.MeetMerge.fillTemplate(
    globalThis.MeetMerge.momTemplateOf(settings.momTemplate), transcript);
  const mom = await globalThis.MeetOpenAI.generateMoM({
    apiKey: settings.apiKey, model: settings.model || globalThis.MeetOpenAI.DEFAULT_MODEL, prompt,
    baseUrl: settings.baseUrl,
  });
  await new Promise((resolve, reject) => {
    enqueueWrite(async () => {
      try {
        const fresh = (await chrome.storage.local.get(key))[key];
        if (!fresh) throw new Error('Meeting not found.');
        fresh.mom = mom;
        await chrome.storage.local.set({ [key]: fresh });
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
  return mom;
}

const momInFlight = new Map();
function generateMomOnce(id) {
  let p = momInFlight.get(id);
  if (!p) {
    p = generateMom(id).finally(() => momInFlight.delete(id));
    momInFlight.set(id, p);
  }
  return p;
}

let writeChain = Promise.resolve();
const enqueueWrite = (fn) => {
  writeChain = writeChain.then(fn).catch((e) => console.error('storage write', e));
  return writeChain;
};

const meetingRunning = (id) => rec.meetingId === id || String(id).startsWith(`${rec.meetingId}@`) || (active.inCall && active.id === id);

async function removeMeeting(id) {
  if (meetingRunning(id)) throw new Error('This meeting is still running. Stop it before deleting.');
  await globalThis.MeetAudioStore.removeRecordings(id);
  const { meetings = [] } = await chrome.storage.local.get('meetings');
  await chrome.storage.local.set({ meetings: meetings.filter((m) => m !== id) });
  await chrome.storage.local.remove(meetingKey(id));
  notifyPanel({ type: 'meeting-updated', id });
}

const deleteMeeting = (id) => new Promise((resolve, reject) => {
  enqueueWrite(() => removeMeeting(id).then(resolve, reject));
});

async function saveTranscriptEdit(id, change) {
  if (meetingRunning(id)) throw new Error('This meeting is still running. Stop it before editing.');
  const key = meetingKey(id);
  const { [key]: meeting } = await chrome.storage.local.get(key);
  if (!meeting) throw new Error('Meeting not found.');
  meeting.segments = globalThis.MeetMerge.applyTranscriptEdit(meeting.segments, change);
  await chrome.storage.local.set({ [key]: meeting });
  notifyPanel({ type: 'meeting-updated', id });
}

const editTranscript = (id, change) => new Promise((resolve, reject) => {
  enqueueWrite(() => saveTranscriptEdit(id, change).then(resolve, reject));
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'captions') return;
  let meetingId = null;
  let joined = false;
  let ended = false;
  const finish = () => {
    if (ended || !joined || !meetingId) return;
    ended = true;
    const fromRecordedTab = rec.tabId == null || port.sender?.tab?.id === rec.tabId;
    if ((!rec.meetingId || rec.meetingId === meetingId) && fromRecordedTab) stopRecording();
    enqueueWrite(() => endMeeting(meetingId));
  };
  port.onMessage.addListener((msg) => {
    meetingId = msg.meetingId;
    if (msg.type === 'segments') {
      enqueueWrite(() => saveSegments(msg));
    } else if (msg.type === 'ended') {
      if (msg.joined) joined = true;
      finish();
    } else if (msg.type === 'status') {
      if (msg.inCall) joined = true;
      const canClaim = !active.inCall || !active.id || (msg.inCall && active.id === msg.meetingId);
      if (!canClaim) return;
      if (msg.captionsOn && !active.captionsOn) active.captionsOnAt = Date.now();
      active = { ...active, id: msg.meetingId, inCall: msg.inCall, captionsOn: msg.captionsOn };
      updateBadge();
      notifyPanel({ type: 'status', ...active });
    }
  });
  port.onDisconnect.addListener(finish);
});

const AI_TARGETS = {
  gemini: {
    url: 'https://gemini.google.com/app', origin: 'https://gemini.google.com/',
    editor: 'div.ql-editor',
  },
  chatgpt: {
    url: 'https://chatgpt.com/', origin: 'https://chatgpt.com/',
    editor: '#prompt-textarea, textarea[name="prompt"], div.ProseMirror[contenteditable="true"]',
  },
};

function injectPrompt(text, editorSelector) {
  if (window.__transcripablesPrompt) return;
  window.__transcripablesPrompt = true;
  const report = (ok, error) => chrome.runtime.sendMessage({ type: 'ai-inject', ok, error }).catch(() => {});
  const deadline = Date.now() + 60000;
  const timer = setInterval(() => {
    const editor = document.querySelector(editorSelector);
    if (!editor) {
      if (Date.now() > deadline) { clearInterval(timer); report(false, 'The editor did not appear within 60 seconds.'); }
      return;
    }
    clearInterval(timer);
    editor.focus();
    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
      const proto = editor.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(editor, text);
    } else {
      editor.replaceChildren();
      for (const line of text.split('\n')) {
        const p = document.createElement('p');
        p.textContent = line;
        editor.append(p);
      }
    }
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    report(true);
  }, 500);
}

let aiPending = null;

function sendToAi(text, target, meetingId) {
  const ai = AI_TARGETS[target];
  if (!ai) return;
  aiPending?.done();
  chrome.tabs.create({ url: ai.url }).then((tab) => {
    const finish = (ok, error) => {
      done();
      notifyPanel({ type: 'ai-inject', id: meetingId, ok, error });
    };
    const done = () => {
      clearTimeout(giveUp);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(gone);
      if (aiPending?.tabId === tab.id) aiPending = null;
    };
    const giveUp = setTimeout(() => finish(false, 'The AI page did not finish loading within 90 seconds.'), 90000);
    const onUpdated = (id, info, t) => {
      if (id !== tab.id || info.status !== 'complete') return;
      if (!t.url?.startsWith(ai.origin)) return;
      chrome.scripting.executeScript({
        target: { tabId: tab.id }, func: injectPrompt, args: [text, ai.editor],
      }).catch((e) => finish(false, e.message));
    };
    function gone(id) { if (id === tab.id) done(); }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(gone);
    aiPending = { tabId: tab.id, done, finish };
  });
}

let pendingPanel = null;

const reply = (promise, sendResponse) => {
  promise.then(
    (res) => sendResponse({ ok: true, ...res }),
    (e) => sendResponse({ ok: false, error: e.message }));
  return true;
};

const toOffscreen = (op) => chrome.runtime.sendMessage({ target: 'offscreen', op }).catch(() => {});

const HANDLERS = {
  'open-panel-tab': (msg) => {
    pendingPanel = { tab: msg.tab, id: msg.id ?? null };
    notifyPanel({ type: 'open-panel-tab', ...pendingPanel });
  },
  'panel-tab-consumed': () => { pendingPanel = null; },
  'get-active': (msg, sender, sendResponse) => {
    const panel = pendingPanel;
    pendingPanel = null;
    recRestored.then(() => sendResponse({
      ...active, rec, panelTab: panel?.tab ?? null, panelMeetingId: panel?.id ?? null }));
    return true;
  },
  'generate-mom': (msg, sender, sendResponse) =>
    reply(generateMomOnce(msg.id).then((mom) => ({ mom })), sendResponse),
  'delete-meeting': (msg, sender, sendResponse) => reply(deleteMeeting(msg.id), sendResponse),
  'edit-transcript': (msg, sender, sendResponse) => reply(editTranscript(msg.id, msg.change), sendResponse),
  'stop-recording': () => { stopRecording(); },
  'start-active-tab-recording': (msg) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
      if (!tab) return recError('Could not read the active tab.');
      return startFromTab(tab, !!msg.video);
    }).catch((e) => recError(e.message));
  },
  'regenerate-transcript': (msg, sender, sendResponse) =>
    reply(regenerateTranscript(msg.id, msg.recId), sendResponse),
  'audio-progress': (msg) => {
    if (!rec.transcribing) {
      rec = { recording: false, transcribing: true, meetingId: msg.meetingId ?? rec.meetingId, autoStt: true };
      updateBadge();
    }
    broadcastRec({ done: msg.done, total: msg.total });
  },
  'audio-transcript': (msg) => {
    resetRec();
    broadcastRec({ error: msg.segments.length
      ? msg.error ?? null
      : 'Empty transcript. STT returned no text, so check the STT endpoint and model in Settings.' });
    enqueueWrite(async () => {
      const id = await saveAudioTranscript(msg);
      if (!msg.error) autoMom(id).catch((e) => console.error(e));
    });
    closeOffscreen();
  },
  'audio-saved': (msg) => {
    resetRec();
    broadcastRec();
    if (msg.meetingId && !globalThis.MeetSession.isMeetCode(msg.meetingId)) enqueueWrite(() => endMeeting(msg.meetingId));
    closeOffscreen();
  },
  'audio-error': (msg) => {
    resetRec();
    broadcastRec({ error: msg.error });
    closeOffscreen();
  },
  'audio-warn': (msg) => { broadcastRec({ error: msg.error }); },
  'send-to-ai': (msg) => { sendToAi(msg.text, msg.target, msg.id); },
  'ai-inject': (msg, sender) => {
    if (aiPending && sender.tab?.id === aiPending.tabId) aiPending.finish(msg.ok, msg.error);
  },
  'open-mic-permission': () => { askMicPermission(); },
  'enable-mic': () => {
    hasOffscreen().then((on) => { if (on) toOffscreen('mic-enable'); });
  },
  'mic-denied': (msg) => {
    if (msg.name === 'NotAllowedError') {
      askMicPermission();
      broadcastRec({ error: 'The microphone is not allowed yet. Allow it in the window that opens. Tab recording keeps running.' });
    } else {
      broadcastRec({ error: `The microphone could not be used (${msg.error}). Tab recording keeps running without it.` });
    }
  },
  'mic-permission': (msg) => {
    hasOffscreen().then((on) => {
      if (!on) return;
      if (msg.granted) {
        toOffscreen('mic-join');
        broadcastRec({ error: null });
      } else {
        broadcastRec({ error: 'Microphone permission denied. Recording continues without your microphone.' });
      }
    });
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) =>
  HANDLERS[msg.type]?.(msg, sender, sendResponse) === true);
