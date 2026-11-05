(() => {
  const S = globalThis.MeetSelectors;
  const SESS = globalThis.MeetSession;
  let sourceMode = 'caption';
  SESS.watchSettings((s) => { sourceMode = s.transcriptSource ?? 'caption'; });
  let port = null;
  let statusTimer = null;
  let flushTimer = null;
  function connect() {
    const p = chrome.runtime.connect({ name: 'captions' });
    p.onDisconnect.addListener(() => { if (port === p) port = null; });
    port = p;
  }
  function stopAll() {
    clearInterval(statusTimer);
    clearInterval(flushTimer);
    observer?.disconnect();
    observer = null;
  }
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
  function openSession() {
    ccAttempts = 0;
    blockIds = new WeakMap();
    dirty.clear();
    firstSeen.clear();
    observer?.disconnect();
    observer = null;
    observedRegion = null;
  }
  function closeSession(endedId, hadJoined) {
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
  function scan(region) {
    for (const block of S.captionBlocks(region)) {
      if (!block) continue;
      let id = blockIds.get(block);
      if (!id) { id = `${sessionTag}:${nextId++}`; blockIds.set(block, id); }
      const text = S.blockText(block);
      if (!text) continue;
      if (!firstSeen.has(id)) firstSeen.set(id, Date.now());
      dirty.set(id, { id, speaker: S.blockSpeaker(block), text, t: firstSeen.get(id) });
    }
  }
  function tick() {
    if (!chrome.runtime?.id) { stopAll(); return; }
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
    if (sourceMode !== 'audio' && !region && inCall && !S.ccEnabled() && ccAttempts < 3) {
      S.ccButton()?.click();
      ccAttempts++;
    }
    post({ type: 'status', meetingId: sess.curId, inCall, captionsOn: !!region });
  }
  flushTimer = setInterval(() => {
    if (!sess.report || !dirty.size) return;
    const sent = post({ type: 'segments', meetingId: sess.curId, title: S.meetingTitle(), segs: [...dirty.values()] });
    if (sent) dirty.clear();
  }, 500);
  statusTimer = setInterval(tick, 2000);
  tick();
})();
