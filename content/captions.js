(() => {
  const S = globalThis.MeetSelectors;
  const SESS = globalThis.MeetSession;
  let sourceMode = 'caption';
  SESS.watchSettings((settings) => { sourceMode = settings.transcriptSource ?? 'caption'; });
  let port = null;
  let statusTimer = null;
  let flushTimer = null;
  let recordPrompt = null;
  let recordPromptKind = null;
  const closedPrompts = new Set();

  // Removes the "start recording" banner from the page.
  function hideRecordPrompt() {
    recordPrompt?.remove();
    recordPrompt = null;
    recordPromptKind = null;
  }

  // Shows the first banner the user has not closed yet, or hides the banner when none is left.
  function showRecordPrompt(prompts) {
    const next = prompts.find((prompt) => !closedPrompts.has(prompt.kind));
    if (!next) return hideRecordPrompt();
    if (recordPromptKind === next.kind) return;
    hideRecordPrompt();
    recordPromptKind = next.kind;
    recordPrompt = document.createElement('div');
    recordPrompt.setAttribute('role', 'alert');
    recordPrompt.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;display:flex;gap:12px;align-items:center;max-width:min(560px,90vw);padding:12px 16px;border-radius:8px;background:#b45309;color:#fff;font:14px/1.4 sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.4)';
    const message = document.createElement('span');
    message.textContent = next.text;
    const close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close');
    close.style.cssText = 'min-width:32px;min-height:32px;border:0;border-radius:4px;background:transparent;color:inherit;font:20px sans-serif;cursor:pointer';
    close.addEventListener('click', () => {
      closedPrompts.add(next.kind);
      hideRecordPrompt();
    });
    recordPrompt.append(message, close);
    document.body.append(recordPrompt);
  }

  // Opens the 'captions' port to the service worker.
  function connect() {
    const newPort = chrome.runtime.connect({ name: 'captions' });
    newPort.onDisconnect.addListener(() => {
      if (port === newPort) port = null;
    });
    newPort.onMessage.addListener((msg) => {
      if (msg.type === 'record-prompt') showRecordPrompt(msg.prompts);
    });
    port = newPort;
  }

  // Stops all timers and the caption observer once the extension is gone.
  function stopAll() {
    clearInterval(statusTimer);
    clearInterval(flushTimer);
    observer?.disconnect();
    observer = null;
  }

  // Sends a message to the service worker and returns whether it went out.
  function post(msg) {
    if (!chrome.runtime?.id) {
      stopAll();
      return false;
    }
    try {
      if (!port) connect();
      port.postMessage(msg);
      return true;
    } catch {
      port = null;
      return false;
    }
  }

  let blockIds = new WeakMap();
  const firstSeen = new Map();
  const sessionTag = crypto.randomUUID().slice(0, 8);
  let nextId = 1;
  const dirty = new Map();
  let observer = null;
  let observedRegion = null;
  let ccAttempts = 0;
  let sess = { ...SESS.INITIAL };

  // Clears per-meeting state when a new meeting starts.
  function openSession() {
    closedPrompts.clear();
    ccAttempts = 0;
    blockIds = new WeakMap();
    dirty.clear();
    firstSeen.clear();
    observer?.disconnect();
    observer = null;
    observedRegion = null;
  }

  // Sends any unsent lines, tells the service worker the meeting ended, and closes the port.
  function closeSession(endedId, hadJoined) {
    hideRecordPrompt();
    if (dirty.size && endedId) {
      post({ type: 'segments', meetingId: endedId, title: '', segs: [...dirty.values()] });
    }
    dirty.clear();
    observer?.disconnect();
    observer = null;
    observedRegion = null;
    if (endedId) post({ type: 'ended', meetingId: endedId, joined: !!hadJoined });
    port?.disconnect();
    port = null;
  }

  // Reads every caption block in the region and queues new or changed lines to send.
  function scan(region) {
    for (const block of S.captionBlocks(region)) {
      if (!block) continue;
      let id = blockIds.get(block);
      if (!id) {
        id = `${sessionTag}:${nextId++}`;
        blockIds.set(block, id);
      }
      const text = S.blockText(block);
      if (!text) continue;
      if (!firstSeen.has(id)) firstSeen.set(id, Date.now());
      dirty.set(id, { id, speaker: S.blockSpeaker(block), text, t: firstSeen.get(id) });
    }
  }

  // Checks the call state, watches the captions area, turns captions on, and reports status.
  function tick() {
    if (!chrome.runtime?.id) {
      stopAll();
      return;
    }
    const inCall = S.inCall();
    const prevId = sess.curId;
    const prevJoined = sess.sawInCall;
    sess = SESS.step(sess, { id: SESS.meetingIdFrom(location.pathname), inCall });
    if (sess.close) closeSession(prevId, prevJoined);
    if (sess.open) openSession();
    if (!sess.report) return;
    const region = S.captionsRegion();
    if (region && region !== observedRegion) {
      observer?.disconnect();
      observer = new MutationObserver(() => scan(region));
      observer.observe(region, { childList: true, subtree: true, characterData: true });
      observedRegion = region;
      scan(region);
    } else if (!region && observer) {
      observer.disconnect();
      observer = null;
      observedRegion = null;
    }
    const shouldTurnOnCaptions = sourceMode !== 'audio' && !region && inCall
      && !S.ccEnabled() && ccAttempts < 3;
    if (shouldTurnOnCaptions) {
      S.ccButton()?.click();
      ccAttempts++;
    }
    post({ type: 'status', meetingId: sess.curId, inCall, captionsOn: !!region });
  }

  // Every half second, sends the caption lines that changed since the last send.
  flushTimer = setInterval(() => {
    if (!sess.report || !dirty.size) return;
    const segs = [...dirty.values()];
    const sent = post({ type: 'segments', meetingId: sess.curId, title: S.meetingTitle(), segs });
    if (sent) dirty.clear();
  }, 500);
  statusTimer = setInterval(tick, 2000);
  tick();
})();
