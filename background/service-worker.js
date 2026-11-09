if (typeof importScripts === 'function') {
  importScripts(
    '/lib/i18n.js', '/content/session.js', '/lib/merge.js',
    '/lib/openai.js', '/lib/stt.js', '/lib/audiostore.js');
}

if (chrome.sidebarAction) {
  // Opens or closes the Firefox sidebar when the toolbar icon is clicked.
  chrome.action?.onClicked.addListener(() => chrome.sidebarAction.toggle());
}

const ACTIVE_IDLE = {
  id: null, inCall: false, captionsOn: false, lastSegmentAt: 0, captionsOnAt: 0, captionsOffAt: 0, joinedAt: 0,
};
let active = { ...ACTIVE_IDLE };

// Returns the storage key that holds a meeting.
const meetingKey = (id) => 'meeting:' + id;

// Creates an empty meeting record, carrying over speaker names when given.
const newMeeting = (id, title, startedAt, speakerNames) => ({
  id, title, startedAt, endedAt: null, segments: [], mom: null,
  ...(speakerNames ? { speakerNames } : {}),
});

// Sends a message to the open panel and popup, ignoring the error when none is open.
function notifyPanel(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

chrome.action?.setBadgeTextColor?.({ color: '#ffffff' });
const QUIET_CAPTIONS_MS = 30000;
const RECORD_PROMPT_QUIET_MS = 60000;
const CAPTIONS_OFF_GRACE_MS = 15000;
const RECORD_REMINDER_MS = 5000;
let transcriptSource = 'caption';

// Returns the caption problem to show on the badge, or null when captions are working.
function captionProblem() {
  if (!active.inCall || transcriptSource === 'audio') return null;
  if (!active.captionsOn) return 'Captions are off';
  const quietSince = Math.max(active.lastSegmentAt || 0, active.captionsOnAt || 0);
  if (quietSince && Date.now() - quietSince > QUIET_CAPTIONS_MS) return 'No captions for 30 seconds';
  return transcriptSource === 'both' && !rec.recording ? 'Not recording yet' : null;
}

// Tells whether captions have been off or silent long enough to suggest recording audio instead.
function captionsFailing() {
  if (!chrome.tabCapture || !active.inCall || transcriptSource === 'audio' || recBusy()) return false;
  if (!active.captionsOn) return Date.now() - active.captionsOffAt >= CAPTIONS_OFF_GRACE_MS;
  const quietSince = Math.max(active.lastSegmentAt || 0, active.captionsOnAt || 0);
  return !!quietSince && Date.now() - quietSince >= RECORD_PROMPT_QUIET_MS;
}

// Tells whether the user joined a call a while ago but has not started the audio recording they need.
function recordingForgotten() {
  if (!chrome.tabCapture || !active.inCall || transcriptSource === 'caption' || recBusy()) return false;
  return Date.now() - active.joinedAt >= RECORD_REMINDER_MS;
}

// Builds the "start recording" banners to show in the Meet tab, with the record shortcut when one is set.
async function recordPrompts() {
  const reasons = [];
  if (recordingForgotten()) {
    reasons.push({ kind: 'record', reason: 'You are in a call but not recording.' });
  }
  if (captionsFailing()) {
    reasons.push({
      kind: 'captions',
      reason: 'Captions stopped, so this part of the meeting may not be saved.',
    });
  }
  if (!reasons.length) return [];
  const commands = await chrome.commands?.getAll?.().catch(() => []) ?? [];
  const shortcut = commands.find((command) => command.name === 'rec-start')?.shortcut;
  const t = globalThis.MeetI18n?.t ?? String;
  return reasons.map(({ kind, reason }) => {
    const text = shortcut
      ? `${reason} Press ${shortcut} to record audio.`
      : `${reason} Press Record on the extension icon.`;
    return { kind, text: t(text) };
  });
}

// Shows on the toolbar icon whether captions or a recording are running, or a warning when something is wrong.
function updateBadge() {
  const problem = captionProblem();
  const running = (active.inCall && active.captionsOn) || rec.recording;
  const t = globalThis.MeetI18n?.t ?? String;
  let badgeText = '';
  if (problem) badgeText = '!';
  else if (running) badgeText = '●';
  chrome.action?.setBadgeBackgroundColor({ color: problem ? '#b45309' : '#d93025' });
  chrome.action?.setBadgeText({ text: badgeText });
  chrome.action?.setTitle?.({ title: problem ? `Transcripables: ${t(problem)}` : 'Transcripables' });
}

let sourceChanged = false;
// Loads the transcript source at startup, unless a settings change already arrived first.
chrome.storage.local.get('settings').then(({ settings }) => {
  if (!sourceChanged) transcriptSource = settings?.transcriptSource ?? 'caption';
  updateBadge();
});

// Follows the transcript source setting and refreshes the badge when it changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  sourceChanged = true;
  transcriptSource = changes.settings.newValue?.transcriptSource ?? 'caption';
  updateBadge();
});

const REC_IDLE = {
  recording: false, transcribing: false, meetingId: null, tabId: null, autoStt: undefined, paused: false,
};
let rec = { ...REC_IDLE };

// Tells whether a recording or transcript is still running.
const recBusy = () => rec.recording || rec.transcribing;

// Forgets the recording state and refreshes the badge.
function resetRec() {
  rec = { ...REC_IDLE };
  updateBadge();
}

// Closes the offscreen recorder page if it is open.
function closeOffscreen() {
  chrome.offscreen?.closeDocument?.().catch(() => {});
}

// Cleans up leftovers from older versions after an install or update.
chrome.runtime.onInstalled.addListener(() => {
  globalThis.caches?.delete('transformers-cache')?.catch(() => {});
  chrome.storage.local.remove('captionsHidden').catch(() => {});
});

// Turns a browser tab title into a meeting title, falling back to the meeting id.
function titleFromTab(tabTitle, meetingId) {
  const title = String(tabTitle ?? '')
    .replace(/^\(\d+\)\s*/, '')
    .replace(/^Meet\s*[-—–]\s*/, '')
    .replace(/\s*[-—–]\s*Google Meet\s*$/, '')
    .trim();
  return !title || title === meetingId ? meetingId : title;
}

// Logs a recording error and shows it in the panel.
function recError(error) {
  console.warn('[rec]', error);
  broadcastRec({ error });
}

// Tells the panel and popup the current recording state, plus any extra fields.
function broadcastRec(extra = {}) {
  notifyPanel({
    type: 'rec-state', recording: rec.recording, transcribing: rec.transcribing,
    saving: rec.transcribing && rec.autoStt === false, paused: !!rec.paused, ...extra,
  });
}

// Tells whether the offscreen recorder page is open.
async function hasOffscreen() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).catch(() => []);
  return contexts.length > 0;
}

// Opens the offscreen recorder page unless it is already open.
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Record Meet tab audio and video for transcripts and recordings.',
  });
}

// Restores the recording state from the offscreen recorder after the service worker restarts.
const recRestored = (async () => {
  if (!(await hasOffscreen())) return;
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', op: 'state' })
    .catch(() => null);
  if (!res?.ok || (!res.recording && !res.transcribing)) return;
  if (recBusy()) return;
  rec = {
    ...REC_IDLE, recording: res.recording, transcribing: res.transcribing, meetingId: res.meetingId,
    tabId: res.tabId ?? null, autoStt: res.autoStt, paused: !!res.paused,
  };
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

// URL-decodes text up to two times, stopping early if it is not valid encoding.
function decodeTwice(text) {
  let out = text;
  for (let i = 0; i < 2; i++) {
    try {
      out = decodeURIComponent(out);
    } catch {
      break;
    }
  }
  return out;
}

// Works out a meeting id from a Meet, Teams, Webex, Slack, Discord or Zoom URL, or null for other pages.
function meetingIdFromUrl(url) {
  try {
    const { hostname, pathname, search, hash } = new URL(url);
    if (hostname === 'discord.com') {
      const match = pathname.match(DISCORD_RE);
      if (!match) return null;
      const channel = match[1] === '@me' ? 'dm' : match[1];
      return `discord-${channel}-${match[2]}`;
    }
    if (hostname === 'zoom.us' || hostname.endsWith('.zoom.us')) {
      const match = pathname.match(ZOOM_RE);
      return match ? `zoom-${match[1]}` : null;
    }
    if (TEAMS_HOSTS.has(hostname)) {
      const thread = decodeTwice(pathname + search + hash).match(TEAMS_THREAD_RE);
      if (thread) return `teams-${thread[1]}`;
      const shortLink = pathname.match(TEAMS_SHORT_RE);
      return shortLink ? `teams-${shortLink[1]}` : null;
    }
    if (hostname.endsWith('.webex.com')) {
      const match = search.match(WEBEX_MTID_RE) ?? pathname.match(WEBEX_HEX_RE);
      if (match) return `webex-${match[1].toLowerCase()}`;
      const room = pathname.match(WEBEX_ROOM_RE);
      return room ? `webex-${hostname.split('.')[0]}-${room[1].toLowerCase()}` : null;
    }
    if (hostname === 'app.slack.com') {
      const match = pathname.match(SLACK_RE);
      return match ? `slack-${match[1]}-${match[2]}` : null;
    }
    if (hostname !== 'meet.google.com') return null;
    return globalThis.MeetSession.meetingIdFrom(pathname);
  } catch {
    return null;
  }
}

// Starts recording the given meeting tab, with or without video.
async function startFromTab(tab, video) {
  await recRestored;
  if (recBusy() || await hasOffscreen()) {
    recError('A recording is still running.');
    return;
  }
  const meetingId = meetingIdFromUrl(tab?.url);
  if (!meetingId) {
    recError('Open a Meet, Teams, or Webex room, a Slack huddle, a Discord channel, or Zoom web'
      + ' (zoom.us/wc/...) first, because recording takes audio from this tab. Tab URL: '
      + (tab?.url ?? '(unreadable)'));
    return;
  }
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const title = titleFromTab(tab?.title, meetingId);
    await startRecording({ streamId, meetingId, title, video, tabId: tab.id });
  } catch (e) {
    recError(e.message);
  }
}

if (!chrome.tabCapture) {
  // Switches the transcript source back to captions, since this browser cannot record tab audio.
  const useCaptionsOnly = async () => {
    const { settings } = await chrome.storage.local.get('settings');
    if (settings?.transcriptSource !== 'audio' && settings?.transcriptSource !== 'both') return;
    await chrome.storage.local.set({ settings: { ...settings, transcriptSource: 'caption' } });
  };
  useCaptionsOnly();
  // Undoes any later change to an audio transcript source.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) useCaptionsOnly();
  });
}

const languageReady = globalThis.MeetI18n?.follow?.() ?? Promise.resolve();

if (chrome.tabCapture) {
  const RECORDABLE = [
    'https://meet.google.com/*', 'https://discord.com/channels/*',
    'https://teams.microsoft.com/*', 'https://teams.live.com/*', 'https://teams.cloud.microsoft/*',
    'https://*.webex.com/*', 'https://app.slack.com/*', 'https://zoom.us/*', 'https://*.zoom.us/*',
  ];
  const MENU = [
    ['rec-start', 'Record meeting audio'],
    ['rec-start-video', 'Record meeting audio + video'],
    ['rec-stop', 'Stop recording'],
  ];
  const { t } = globalThis.MeetI18n;
  // Translates the right-click menu items into the current language.
  const titleMenus = () => {
    for (const [id, title] of MENU) {
      chrome.contextMenus.update(id, { title: t(title) })?.catch(() => {});
    }
  };
  languageReady.then(() => {
    titleMenus();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) titleMenus();
    });
  });
  // Creates the right-click menu items on meeting pages after an install or update.
  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
      for (const [id, title] of MENU) {
        chrome.contextMenus.create({ id, title, contexts: ['page'], documentUrlPatterns: RECORDABLE });
      }
      languageReady.then(titleMenus);
    });
  });
  // Runs a right-click menu item or keyboard shortcut.
  const runCommand = (id, tab) => {
    if (id === 'rec-start' || id === 'rec-start-video') startFromTab(tab, id === 'rec-start-video');
    else if (id === 'rec-stop') stopRecording();
    else if (id === 'mark-moment') markMoment().catch((e) => recError(e.message));
  };
  chrome.contextMenus.onClicked.addListener((info, tab) => runCommand(info.menuItemId, tab));
  chrome.commands?.onCommand.addListener(runCommand);
} else {
  // Runs the mark-moment shortcut, the only one that works without tab recording.
  chrome.commands?.onCommand.addListener((id) => {
    if (id === 'mark-moment') markMoment().catch((e) => recError(e.message));
  });
}

// Reads the speech-to-text and recording settings the offscreen recorder needs.
async function sttConfig() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const stt = globalThis.MeetStt.sttEndpoint(settings);
  return {
    sttMode: stt.mode, baseUrl: stt.baseUrl, apiKey: stt.apiKey,
    sttModel: stt.model, sttLanguage: stt.language, sttVocabulary: stt.vocabulary,
    mic: !!settings.mic,
    transcriptSource: settings.transcriptSource ?? 'caption',
    keepRecordings: settings.keepRecordings,
  };
}

// Tells whether a recording should be transcribed when it stops.
function autoTranscribe(transcriptSource) {
  return transcriptSource === 'audio' || transcriptSource === 'both';
}

let micWin = null;

// Opens the small window that asks for microphone permission, unless it is already open.
async function askMicPermission() {
  if (micWin != null) return;
  micWin = -1;
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('panel/mic.html'), type: 'popup', width: 460, height: 240, focused: true,
  }).catch(() => null);
  micWin = win?.id ?? null;
}

// Notices when the microphone permission window is closed.
chrome.windows?.onRemoved.addListener((id) => {
  if (id === micWin) micWin = null;
});

let startPromise = null;

// Starts recording a meeting tab, and resets the state if the recorder fails to start.
async function startRecording({ streamId, meetingId, title, video, tabId }) {
  if (recBusy()) throw new Error('A recording is still running.');
  const baseTime = Date.now();
  rec = { ...REC_IDLE, recording: true, meetingId, tabId };
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

// Opens the offscreen recorder, tells it to start, and creates the meeting record.
async function startRecordingInner({ streamId, meetingId, title, baseTime, video, tabId }) {
  const stt = await sttConfig();
  await ensureOffscreen();
  broadcastRec({ error: null });
  const transcribe = autoTranscribe(stt.transcriptSource);
  rec.autoStt = transcribe;
  const res = await chrome.runtime.sendMessage({
    target: 'offscreen', op: 'start', streamId, meetingId, ...stt,
    chunkMs: 120000, baseTime, video: !!video, transcribe, tabId,
  }).catch((e) => ({ ok: false, error: e.message }));
  if (!res?.ok) throw new Error(res?.error || 'The recorder did not respond, so recording did not start.');
  enqueueWrite(() => ensureMeeting({ meetingId, title, startedAt: baseTime }));
}

// Transcribes a saved recording of a meeting again.
async function regenerateTranscript(meetingId, recId) {
  await recRestored;
  if (recBusy()) throw new Error('A recording or transcript is still running.');
  if (!Number.isFinite(Number(recId))) {
    throw new Error('No recording was named for retranscribing (empty recId).');
  }
  rec = { ...REC_IDLE, transcribing: true, meetingId, autoStt: true };
  updateBadge();
  broadcastRec({ error: null });
  try {
    const recordings = await globalThis.MeetAudioStore.listRecordings();
    const target = recordings.find((recording) => recording.recId === Number(recId));
    if (!target) {
      throw new Error('That recording is no longer saved. Settings decides how many are kept.');
    }
    if (target.meetingId !== meetingId) {
      throw new Error('That recording belongs to another meeting, so it cannot be retranscribed here.');
    }
    const stt = await sttConfig();
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({
      target: 'offscreen', op: 'retranscribe', meetingId, recId: target.recId, ...stt,
    });
    if (!res?.ok) {
      throw new Error(res?.error || 'The recorder did not respond, so retranscribing did not start.');
    }
  } catch (e) {
    resetRec();
    broadcastRec();
    throw e;
  }
}

// Pauses or resumes the running recording.
async function setRecordingPaused(on) {
  await recRestored;
  if (!rec.recording) return;
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', op: 'pause', on }).catch(() => null);
  rec.paused = !!res?.paused;
  broadcastRec();
}

// Stops the running recording, after which the recorder transcribes or saves it.
async function stopRecording() {
  await recRestored;
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
  broadcastRec({
    error: res?.error ?? 'The recorder did not respond, so recording stopped without a transcript.',
  });
}

// Saves a meeting and puts its id at the front of the meeting list if it is new.
async function storeMeeting(meetingId, meeting, data) {
  const meetings = data.meetings ?? [];
  if (!meetings.includes(meetingId)) meetings.unshift(meetingId);
  await chrome.storage.local.set({ [meetingKey(meetingId)]: meeting, meetings });
}

// Moves an old meeting with the same id to its own archived entry, so a new one can start.
async function archiveIfStale(meetingId, data) {
  const key = meetingKey(meetingId);
  const old = data[key];
  if (!old || !globalThis.MeetMerge.isStaleMeeting(old, Date.now())) return;
  const lastActivity = globalThis.MeetMerge.lastActivityAt(old);
  const archiveId = `${meetingId}@${lastActivity}`;
  const meetings = data.meetings ?? [];
  const index = meetings.indexOf(meetingId);
  if (index !== -1) meetings[index] = archiveId;
  else meetings.unshift(archiveId);
  data.meetings = meetings;
  await chrome.storage.local.set({
    [meetingKey(archiveId)]: { ...old, id: archiveId, endedAt: old.endedAt ?? lastActivity },
  });
  await chrome.storage.local.remove(key);
  delete data[key];
  data.carriedNames = globalThis.MeetMerge.carriedNames(old.speakerNames);
  await globalThis.MeetAudioStore.retagAudioMeta(meetingId, archiveId, lastActivity).catch(() => {});
  notifyPanel({ type: 'meeting-updated', id: archiveId, movedFrom: meetingId });
}

// Creates or reopens the meeting record for a recording that just started.
async function ensureMeeting({ meetingId, title, startedAt }) {
  const key = meetingKey(meetingId);
  const data = await chrome.storage.local.get([key, 'meetings']);
  await archiveIfStale(meetingId, data);
  const meeting = data[key] ?? newMeeting(meetingId, title || meetingId, startedAt, data.carriedNames);
  if (!(meeting.startedAt <= startedAt)) meeting.startedAt = startedAt;
  meeting.source = 'audio';
  meeting.endedAt = null;
  if (title && !meeting.renamed) meeting.title = title;
  await storeMeeting(meetingId, meeting, data);
  notifyPanel({ type: 'meeting-updated', id: meetingId });
}

// Saves an audio transcript into the meeting it belongs to and returns that meeting's id.
async function saveAudioTranscript({ meetingId, segments, baseTime, replace, legacy }) {
  let key = meetingKey(meetingId);
  const data = await chrome.storage.local.get([key, 'meetings']);
  if (data[key] && baseTime && data[key].startedAt > baseTime) {
    const ids = (data.meetings ?? []).filter((id) => String(id).startsWith(meetingId + '@'));
    const archived = await chrome.storage.local.get(ids.map((id) => meetingKey(id)));
    const owner = globalThis.MeetMerge.ownerOfRecording(
      ids.map((id) => archived[meetingKey(id)]), baseTime);
    if (owner) {
      meetingId = owner.id;
      key = meetingKey(meetingId);
      data[key] = owner;
    }
  }
  const meeting = data[key] ?? newMeeting(meetingId, meetingId, baseTime ?? Date.now());
  meeting.source = 'audio';
  const audioOptions = { baseTime: baseTime ?? 0, replace: !!replace, legacy: !!legacy };
  globalThis.MeetMerge.replaceMeetingAudio(meeting, segments, audioOptions);
  await storeMeeting(meetingId, meeting, data);
  notifyPanel({ type: 'meeting-updated', id: meetingId });
  const tag = `audio:${baseTime ?? 0}:`;
  const { settings = {} } = await chrome.storage.local.get('settings');
  const expected = settings.transcriptSource === 'both' && !replace;
  const changedLines = meeting.segments.some((segment) =>
    String(segment.id ?? '').startsWith(tag) || segment.correctedFrom === (baseTime ?? 0));
  if (segments.length && !expected && !changedLines) {
    broadcastRec({ error: 'The audio transcript matches the captions, so no new lines were added.' });
  }
  return meetingId;
}

// Saves caption lines sent by a Meet tab, using the speaker names the user gave.
async function saveSegments({ meetingId, title, segs }) {
  await recRestored;
  if (rec.paused && rec.meetingId === meetingId) return;
  const key = meetingKey(meetingId);
  const data = await chrome.storage.local.get([key, 'meetings']);
  await archiveIfStale(meetingId, data);
  const meeting = data[key] ?? newMeeting(meetingId, title || meetingId, Date.now(), data.carriedNames);
  if (title && !meeting.renamed) meeting.title = title;
  meeting.endedAt = null;
  const names = meeting.speakerNames ?? {};
  for (const seg of segs) {
    const named = Object.hasOwn(names, seg.speaker) ? { ...seg, speaker: names[seg.speaker] } : seg;
    globalThis.MeetMerge.upsertSegment(meeting.segments, named);
  }
  await storeMeeting(meetingId, meeting, data);
  if (!active.id || active.id === meetingId) active.lastSegmentAt = Date.now();
  notifyPanel({ type: 'meeting-updated', id: meetingId });
}

// Makes the minutes of meeting automatically when the setting is on and the transcript changed.
async function autoMom(id) {
  const key = meetingKey(id);
  const { settings = {}, [key]: meeting } = await chrome.storage.local.get(['settings', key]);
  if (!settings.autoMom || !globalThis.MeetMerge.canMakeMom(settings)) return;
  if (!meeting?.segments.length) return;
  if (meeting.mom && !globalThis.MeetMerge.changedSince(meeting, meeting.momBasedOn)) return;
  try {
    await generateMomOnce(id);
    notifyPanel({ type: 'meeting-updated', id });
  } catch (e) {
    broadcastRec({ error: `MoM could not be made automatically: ${e.message}` });
  }
}

// Makes the minutes from the captions when audio and captions were both on but the audio failed.
async function momFromCaptions(id) {
  const key = meetingKey(id);
  const { settings, [key]: meeting } = await chrome.storage.local.get(['settings', key]);
  if (settings?.transcriptSource !== 'both') return;
  const hasCaptionLines = meeting?.segments.some((segment) => !String(segment.id ?? '').startsWith('audio:'));
  if (hasCaptionLines) await autoMom(id);
}

// Marks a meeting as ended and makes its minutes unless an audio transcript is still coming.
async function endMeeting(meetingId, { makeMom = true } = {}) {
  if (active.id === meetingId) {
    active = { ...ACTIVE_IDLE };
    updateBadge();
    notifyPanel({ type: 'status', ...active });
  }
  const key = meetingKey(meetingId);
  await recRestored;
  const data = await chrome.storage.local.get(key);
  if (!data[key]) return;
  data[key].endedAt = Date.now();
  await chrome.storage.local.set({ [key]: data[key] });
  notifyPanel({ type: 'meeting-updated', id: meetingId });
  const transcriptComing = rec.meetingId === meetingId && rec.autoStt && recBusy();
  if (makeMom && !transcriptComing) autoMom(meetingId).catch((e) => console.error(e));
}

// Ends a non-Meet meeting once its recording is done, since those sites have no caption tab to end it.
async function finishOtherSite(id) {
  if (globalThis.MeetSession.isMeetCode(id)) return;
  const key = meetingKey(id);
  const { [key]: meeting } = await chrome.storage.local.get(key);
  if (meeting && !meeting.endedAt) await endMeeting(id, { makeMom: false });
}

const KEEP_AWAKE_MS = 20000;

// Keeps the service worker alive until the given work finishes.
function keepAwake(work) {
  let timer;
  const ping = () => {
    chrome.runtime.getPlatformInfo?.().catch(() => {});
    timer = setTimeout(ping, KEEP_AWAKE_MS);
  };
  timer = setTimeout(ping, KEEP_AWAKE_MS);
  return work.finally(() => clearTimeout(timer));
}

// Asks the AI for the minutes of meeting and saves them with the meeting.
async function generateMom(id) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  if (!globalThis.MeetMerge.canMakeMom(settings)) throw new Error('Add an API key in the Settings tab first.');
  const key = meetingKey(id);
  const data = await chrome.storage.local.get(key);
  const meeting = data[key];
  if (!meeting || !meeting.segments.length) throw new Error('The transcript is empty.');
  const prompt = globalThis.MeetMerge.momPrompt(meeting, settings);
  const momBasedOn = globalThis.MeetMerge.transcriptStamp(meeting);
  const mom = await keepAwake(globalThis.MeetOpenAI.generateMoM({
    stream: true, apiKey: settings.apiKey,
    model: settings.model || globalThis.MeetOpenAI.DEFAULT_MODEL, prompt,
    baseUrl: settings.baseUrl,
  }));
  await new Promise((resolve, reject) => {
    enqueueWrite(async () => {
      try {
        const fresh = (await chrome.storage.local.get(key))[key];
        if (fresh?.startedAt !== meeting.startedAt) throw new Error('Meeting not found.');
        fresh.mom = mom;
        fresh.momBasedOn = momBasedOn;
        await chrome.storage.local.set({ [key]: fresh });
        resolve(null);
      } catch (e) {
        reject(e);
      }
    });
  });
  return mom;
}

const momInFlight = new Map();

// Makes the minutes of a meeting, reusing the request already running for it.
function generateMomOnce(id) {
  let pending = momInFlight.get(id);
  if (!pending) {
    pending = generateMom(id).finally(() => momInFlight.delete(id));
    momInFlight.set(id, pending);
  }
  return pending;
}

let writeChain = Promise.resolve();

// Runs a storage write after all earlier ones, so writes never overlap.
const enqueueWrite = (fn) => {
  writeChain = writeChain.then(fn).catch((e) => console.error('storage write', e));
  return writeChain;
};

const openCalls = new Map();

// Remembers that a Meet tab is in the call.
function joinCall(id, port) {
  if (!openCalls.has(id)) openCalls.set(id, new Set());
  openCalls.get(id).add(port);
}

// Forgets a Meet tab's call and tells whether another tab is still in it.
function leaveCall(id, port) {
  const ports = openCalls.get(id);
  ports?.delete(port);
  if (ports && !ports.size) openCalls.delete(id);
  return openCalls.has(id);
}

// Tells whether a meeting is still being recorded or is open in a call.
const meetingRunning = (id) => rec.meetingId === id
  || String(id).startsWith(`${rec.meetingId}@`)
  || (active.inCall && active.id === id)
  || openCalls.has(id);

// Deletes a meeting and its recordings, unless it is still running.
async function removeMeeting(id) {
  await recRestored;
  if (meetingRunning(id)) throw new Error('This meeting is still running. Stop it before deleting.');
  await globalThis.MeetAudioStore.removeRecordings(id);
  const { meetings = [] } = await chrome.storage.local.get('meetings');
  await chrome.storage.local.set({ meetings: meetings.filter((m) => m !== id) });
  await chrome.storage.local.remove(meetingKey(id));
  notifyPanel({ type: 'meeting-updated', id });
}

// Queues work behind the other storage writes and resolves with its own result.
const whenWritten = (work) => new Promise((resolve, reject) => {
  enqueueWrite(() => work().then(resolve, reject));
});

// Deletes a meeting in turn with the other storage writes.
const deleteMeeting = (id) => whenWritten(() => removeMeeting(id));

// Deletes meetings older than the "delete after" setting allows.
async function deleteOldMeetings() {
  const { settings = {}, meetings = [] } = await chrome.storage.local.get(['settings', 'meetings']);
  if (!(Number(settings.deleteAfterDays) > 0)) return;
  const stored = await chrome.storage.local.get(meetings.map(meetingKey));
  const old = globalThis.MeetMerge.expiredMeetingIds(
    Object.values(stored), settings.deleteAfterDays, Date.now());
  for (const id of old) await deleteMeeting(id).catch(() => {});
}

// Marks the current moment in the running meeting.
async function addMark() {
  await recRestored;
  const id = rec.recording ? rec.meetingId : active.inCall && active.id;
  if (!id) throw new Error('No meeting is running.');
  const key = meetingKey(id);
  const data = await chrome.storage.local.get([key, 'meetings']);
  await archiveIfStale(id, data);
  const meeting = data[key] ?? newMeeting(id, id, Date.now(), data.carriedNames);
  meeting.marks = [...(meeting.marks ?? []), Date.now()];
  await storeMeeting(id, meeting, data);
  notifyPanel({ type: 'meeting-updated', id });
}

// Marks the current moment in turn with the other storage writes.
const markMoment = () => whenWritten(addMark);

// Asks the AI a question about all saved meetings.
async function askAll(question) {
  const { settings = {}, meetings = [] } = await chrome.storage.local.get(['settings', 'meetings']);
  if (!globalThis.MeetMerge.canMakeMom(settings)) throw new Error('Add an API key in the Settings tab first.');
  const keys = meetings.map(meetingKey);
  const stored = Object.values(await chrome.storage.local.get(keys));
  const { prompt, used, left } = globalThis.MeetMerge.askAllPrompt(stored, question);
  if (!used) throw new Error('There are no meetings to ask about yet.');
  const answer = await keepAwake(globalThis.MeetOpenAI.generateMoM({
    stream: true, apiKey: settings.apiKey, baseUrl: settings.baseUrl,
    model: settings.model || globalThis.MeetOpenAI.DEFAULT_MODEL, prompt,
  }));
  return { answer, used, left };
}

// Asks the AI a question about one meeting and saves the answer with it.
async function askMeeting(id, question) {
  const key = meetingKey(id);
  const { settings = {}, [key]: meeting } = await chrome.storage.local.get(['settings', key]);
  if (!globalThis.MeetMerge.canMakeMom(settings)) throw new Error('Add an API key in the Settings tab first.');
  if (!meeting?.segments.length) throw new Error('The transcript is empty.');
  const basedOn = globalThis.MeetMerge.transcriptStamp(meeting);
  const answer = await keepAwake(globalThis.MeetOpenAI.generateMoM({
    stream: true, apiKey: settings.apiKey, baseUrl: settings.baseUrl,
    model: settings.model || globalThis.MeetOpenAI.DEFAULT_MODEL,
    prompt: globalThis.MeetMerge.askPrompt(meeting, question),
  }));
  await whenWritten(async () => {
    const { [key]: current } = await chrome.storage.local.get(key);
    if (current?.startedAt !== meeting.startedAt) throw new Error('Meeting not found.');
    globalThis.MeetMerge.addAnswer(current, question, answer, basedOn);
    await chrome.storage.local.set({ [key]: current });
    notifyPanel({ type: 'meeting-updated', id });
  });
  return { answer };
}

// Applies an edit to a meeting; transcript edits are refused while the meeting is running.
async function saveTranscriptEdit(id, change) {
  const editsTranscript = change.deleteAnswer === undefined && change.toggleItem === undefined;
  if (editsTranscript && meetingRunning(id)) {
    throw new Error('This meeting is still running. Stop it before editing.');
  }
  const key = meetingKey(id);
  const { [key]: meeting } = await chrome.storage.local.get(key);
  if (!meeting) throw new Error('Meeting not found.');
  globalThis.MeetMerge.editMeeting(meeting, change);
  await chrome.storage.local.set({ [key]: meeting });
  notifyPanel({ type: 'meeting-updated', id });
}

// Edits a meeting in turn with the other storage writes.
const editTranscript = (id, change) => whenWritten(() => saveTranscriptEdit(id, change));

// Renames a meeting, ignoring an empty title.
async function saveTitle(id, title) {
  const clean = String(title ?? '').trim();
  if (!clean) return;
  const key = meetingKey(id);
  const { [key]: meeting } = await chrome.storage.local.get(key);
  if (!meeting) throw new Error('Meeting not found.');
  meeting.title = clean;
  meeting.renamed = true;
  await chrome.storage.local.set({ [key]: meeting });
  notifyPanel({ type: 'meeting-updated', id });
}

// Renames a meeting in turn with the other storage writes.
const renameMeeting = (id, title) => whenWritten(() => saveTitle(id, title));

// Replaces a meeting's tags in turn with the other storage writes.
const tagMeeting = (id, tags) => whenWritten(async () => {
  const key = meetingKey(id);
  const { [key]: meeting } = await chrome.storage.local.get(key);
  if (!meeting) throw new Error('Meeting not found.');
  meeting.tags = globalThis.MeetMerge.cleanTags(tags);
  await chrome.storage.local.set({ [key]: meeting });
  notifyPanel({ type: 'meeting-updated', id });
});

// Creates an empty meeting for an imported audio file and returns its id.
const addImportedMeeting = ({ title, startedAt, endedAt }) => whenWritten(async () => {
  await recRestored;
  if (recBusy()) throw new Error('Stop the recording before importing a file.');
  const id = `import-${Date.now()}`;
  const meeting = { ...newMeeting(id, title, startedAt), endedAt, keepFrom: Date.now(), source: 'audio' };
  await storeMeeting(id, meeting, await chrome.storage.local.get('meetings'));
  notifyPanel({ type: 'meeting-updated', id });
  return { id };
});

// Receives caption lines and call status from each Meet tab, and ends the meeting when the tab leaves.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'captions') return;
  let meetingId = null;
  let joined = false;
  let ended = false;
  const finish = () => {
    const id = meetingId;
    const stillOpen = leaveCall(id, port);
    recRestored.then(() => {
      if (ended || !id) return;
      const fromRecordedTab = rec.tabId == null || port.sender?.tab?.id === rec.tabId;
      const recordingThisMeeting = rec.recording && rec.meetingId === id && fromRecordedTab;
      if (!joined && !recordingThisMeeting) return;
      ended = true;
      if ((!rec.meetingId || rec.meetingId === id) && fromRecordedTab) stopRecording();
      if (!stillOpen) enqueueWrite(() => endMeeting(id));
    });
  };
  port.onMessage.addListener((msg) => {
    meetingId = msg.meetingId;
    if (msg.type === 'segments') {
      enqueueWrite(() => saveSegments(msg));
    } else if (msg.type === 'ended') {
      if (msg.joined) joined = true;
      finish();
    } else if (msg.type === 'status') {
      if (msg.inCall) {
        joined = true;
        joinCall(msg.meetingId, port);
      }
      const canClaim = !active.inCall || !active.id || (msg.inCall && active.id === msg.meetingId);
      if (!canClaim) return;
      const joinedNow = msg.inCall && !active.inCall;
      const captionsTurnedOn = msg.captionsOn && !active.captionsOn;
      const captionsTurnedOff = !msg.captionsOn && (active.captionsOn || !active.captionsOffAt);
      if (joinedNow) active.joinedAt = Date.now();
      if (joinedNow || captionsTurnedOn) active.captionsOnAt = Date.now();
      if (joinedNow || captionsTurnedOff) active.captionsOffAt = Date.now();
      active = { ...active, id: msg.meetingId, inCall: msg.inCall, captionsOn: msg.captionsOn };
      updateBadge();
      notifyPanel({ type: 'status', ...active });
      recRestored
        .then(recordPrompts)
        .then((prompts) => port.postMessage({ type: 'record-prompt', prompts }))
        .catch(() => {});
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

// Runs inside the AI site's tab: waits for its prompt box, fills in the text, and reports back.
function injectPrompt(text, editorSelector) {
  if (window.__transcripablesPrompt) return;
  window.__transcripablesPrompt = true;
  const report = (ok, error) => chrome.runtime.sendMessage({ type: 'ai-inject', ok, error }).catch(() => {});
  const deadline = Date.now() + 60000;
  const timer = setInterval(() => {
    const editor = document.querySelector(editorSelector);
    if (!editor) {
      if (Date.now() > deadline) {
        clearInterval(timer);
        report(false, 'The editor did not appear within 60 seconds.');
      }
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
        const paragraph = document.createElement('p');
        paragraph.textContent = line;
        editor.append(paragraph);
      }
    }
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    report(true);
  }, 500);
}

let aiPending = null;

// Opens Gemini or ChatGPT in a new tab and pastes the text into its prompt box.
function sendToAi(text, target, meetingId) {
  const ai = AI_TARGETS[target];
  if (!ai) return;
  aiPending?.done();
  chrome.tabs.create({ url: ai.url }).then((tab) => {
    let release;
    keepAwake(new Promise((resolve) => { release = resolve; }));
    const finish = (ok, error) => {
      done();
      notifyPanel({ type: 'ai-inject', id: meetingId, ok, error });
    };
    const done = () => {
      release();
      clearTimeout(giveUp);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(gone);
      if (aiPending?.tabId === tab.id) aiPending = null;
    };
    const giveUp = setTimeout(
      () => finish(false, 'The AI page did not finish loading within 90 seconds.'), 90000);
    const onUpdated = (id, info, updatedTab) => {
      if (id !== tab.id || info.status !== 'complete') return;
      if (!updatedTab.url?.startsWith(ai.origin)) return;
      chrome.scripting.executeScript({
        target: { tabId: tab.id }, func: injectPrompt, args: [text, ai.editor],
      }).catch((e) => finish(false, e.message));
    };
    function gone(id) {
      if (id === tab.id) done();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(gone);
    aiPending = { tabId: tab.id, done, finish };
  });
}

let pendingPanel = null;

// Answers a message once the promise settles, as { ok: true, ...result } or { ok: false, error }.
const reply = (promise, sendResponse) => {
  promise.then(
    (res) => sendResponse({ ok: true, ...res }),
    (e) => sendResponse({ ok: false, error: e.message }));
  return true;
};

// Sends a command to the offscreen recorder, ignoring the error when it is closed.
const toOffscreen = (op) => chrome.runtime.sendMessage({ target: 'offscreen', op }).catch(() => {});

const HANDLERS = {
  // Asks the panel to switch to a tab (and meeting), remembering it for a panel that is not open yet.
  'open-panel-tab': (msg) => {
    pendingPanel = { tab: msg.tab, id: msg.id ?? null };
    notifyPanel({ type: 'open-panel-tab', ...pendingPanel });
  },
  // Forgets the panel tab request once the panel has shown it.
  'panel-tab-consumed': () => { pendingPanel = null; },
  // Returns the call state, recording state and any pending panel tab request.
  'get-active': (msg, sender, sendResponse) => {
    const panel = pendingPanel;
    pendingPanel = null;
    recRestored.then(() => sendResponse({
      ...active, rec, panelTab: panel?.tab ?? null, panelMeetingId: panel?.id ?? null,
    }));
    return true;
  },
  // Makes the minutes of a meeting.
  'generate-mom': (msg, sender, sendResponse) =>
    reply(generateMomOnce(msg.id).then((mom) => ({ mom })), sendResponse),
  // Deletes a meeting.
  'delete-meeting': (msg, sender, sendResponse) => reply(deleteMeeting(msg.id), sendResponse),
  // Edits a meeting's transcript, minutes or answers.
  'edit-transcript': (msg, sender, sendResponse) => reply(editTranscript(msg.id, msg.change), sendResponse),
  // Renames a meeting.
  'rename-meeting': (msg, sender, sendResponse) => reply(renameMeeting(msg.id, msg.title), sendResponse),
  // Sets a meeting's tags.
  'tag-meeting': (msg, sender, sendResponse) => reply(tagMeeting(msg.id, msg.tags), sendResponse),
  // Creates a meeting for an imported audio file.
  'add-imported-meeting': (msg, sender, sendResponse) => reply(addImportedMeeting(msg), sendResponse),
  // Marks the current moment in the running meeting.
  'mark-moment': (msg, sender, sendResponse) => reply(markMoment(), sendResponse),
  // Answers a question about one meeting.
  'ask-meeting': (msg, sender, sendResponse) => reply(askMeeting(msg.id, msg.question), sendResponse),
  // Answers a question about all meetings.
  'ask-all': (msg, sender, sendResponse) => reply(askAll(msg.question), sendResponse),
  // Deletes meetings past the "delete after" age.
  'delete-old-meetings': (msg, sender, sendResponse) => reply(deleteOldMeetings(), sendResponse),
  // Stops the running recording.
  'stop-recording': () => { stopRecording(); },
  // Pauses or resumes the running recording.
  'set-paused': (msg, sender, sendResponse) => reply(setRecordingPaused(!!msg.on), sendResponse),
  // Starts recording the active tab.
  'start-active-tab-recording': (msg) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
      if (!tab) return recError('Could not read the active tab.');
      return startFromTab(tab, !!msg.video);
    }).catch((e) => recError(e.message));
  },
  // Transcribes a saved recording again.
  'regenerate-transcript': (msg, sender, sendResponse) =>
    reply(regenerateTranscript(msg.id, msg.recId), sendResponse),
  // Passes transcription progress on to the panel, noting a transcript the worker did not know about.
  'audio-progress': (msg) => {
    if (!rec.transcribing) {
      rec = { ...REC_IDLE, transcribing: true, meetingId: msg.meetingId ?? rec.meetingId, autoStt: true };
      updateBadge();
    }
    broadcastRec({ done: msg.done, total: msg.total });
  },
  // Saves a finished audio transcript and makes the minutes.
  'audio-transcript': (msg) => {
    resetRec();
    const error = msg.segments.length
      ? msg.error ?? null
      : 'Empty transcript. STT returned no text, so check the speech-to-text address and model in Settings.';
    broadcastRec({ error });
    enqueueWrite(async () => {
      const id = await saveAudioTranscript(msg);
      await finishOtherSite(id);
      (msg.error ? momFromCaptions(id) : autoMom(id)).catch((e) => console.error(e));
    });
    closeOffscreen();
  },
  // Finishes a recording that was saved without a transcript.
  'audio-saved': (msg) => {
    resetRec();
    broadcastRec();
    const fromOtherSite = msg.meetingId && !globalThis.MeetSession.isMeetCode(msg.meetingId);
    if (fromOtherSite) enqueueWrite(() => endMeeting(msg.meetingId));
    closeOffscreen();
  },
  // Shows a recording failure and falls back to minutes from the captions.
  'audio-error': (msg) => {
    resetRec();
    broadcastRec({ error: msg.error });
    if (msg.meetingId) {
      enqueueWrite(async () => {
        await finishOtherSite(msg.meetingId);
        momFromCaptions(msg.meetingId).catch((e) => console.error(e));
      });
    }
    closeOffscreen();
  },
  // Shows a recorder warning in the panel.
  'audio-warn': (msg) => { broadcastRec({ error: msg.error }); },
  // Opens an AI site with the given text.
  'send-to-ai': (msg) => { sendToAi(msg.text, msg.target, msg.id); },
  // Receives the result of pasting text into the AI site's tab.
  'ai-inject': (msg, sender) => {
    if (aiPending && sender.tab?.id === aiPending.tabId) aiPending.finish(msg.ok, msg.error);
  },
  // Opens the microphone permission window.
  'open-mic-permission': () => { askMicPermission(); },
  // Adds the microphone to a running recording.
  'enable-mic': () => {
    hasOffscreen().then((on) => {
      if (on) toOffscreen('mic-enable');
    });
  },
  // Explains why the recorder could not use the microphone, asking for permission when needed.
  'mic-denied': (msg) => {
    if (msg.name === 'NotAllowedError') {
      askMicPermission();
      broadcastRec({
        error: 'The microphone is not allowed yet. Allow it in the window that opens. Tab recording keeps running.',
      });
    } else {
      broadcastRec({
        error: `The microphone could not be used (${msg.error}). Tab recording keeps running without it.`,
      });
    }
  },
  // Adds the microphone once permission is granted, or warns that the recording goes on without it.
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

const FROM_WEB_PAGES = new Set(['ai-inject']);

// Tells whether a message came from one of the extension's own pages.
const fromExtensionPage = (sender) => sender?.id === chrome.runtime.id
  && String(sender.url ?? '').startsWith(chrome.runtime.getURL(''));

// Routes each message to its handler, accepting web-page messages only for the types that allow it.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const allowed = FROM_WEB_PAGES.has(msg?.type) || fromExtensionPage(sender);
  return allowed && HANDLERS[msg.type]?.(msg, sender, sendResponse) === true;
});

deleteOldMeetings().catch((e) => console.warn('[cleanup]', e.message));
