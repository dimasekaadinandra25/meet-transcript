(() => {
  const MEET_CODE = '[a-z]{3}-[a-z]{4}-[a-z]{3}';
  const MEET_CODE_RE = new RegExp(`^${MEET_CODE}$`);
  const MEET_PATH_RE = new RegExp(`^/(?:_?meet/)?(${MEET_CODE})$`);
  const LEAVE_TICKS = 2;
  function meetingIdFrom(pathname) {
    const m = String(pathname ?? '').match(MEET_PATH_RE);
    return m ? m[1] : null;
  }
  const isMeetCode = (id) => MEET_CODE_RE.test(id);
  function watchSettings(apply) {
    let changed = false;
    chrome.storage.onChanged.addListener((c, area) => {
      if (area !== 'local' || !c.settings) return;
      changed = true;
      apply(c.settings.newValue ?? {}, true);
    });
    chrome.storage.local.get('settings').then((d) => {
      if (!changed) apply(d.settings ?? {}, false);
    }).catch(() => {});
  }
  const INITIAL = { curId: null, reporting: false, sawInCall: false, goneTicks: 0 };
  function step(s, { id, inCall }) {
    let { curId, reporting, sawInCall, goneTicks } = s;
    let open = false;
    let close = false;
    if (id && id !== curId) {
      close = reporting;
      curId = id;
      reporting = true; sawInCall = false; goneTicks = 0;
      open = true;
    }
    if (!curId) return { ...INITIAL, open, close, report: false };
    if (inCall) {
      if (!reporting) { open = true; reporting = true; goneTicks = 0; }
      sawInCall = true;
      goneTicks = 0;
      return { curId, reporting, sawInCall, goneTicks, open, close, report: true };
    }
    const leaving = !id || sawInCall;
    if (reporting && leaving && ++goneTicks >= LEAVE_TICKS) {
      return { curId: id ?? null, reporting: false, sawInCall: false, goneTicks: 0,
        open, close: true, report: false };
    }
    return { curId, reporting, sawInCall, goneTicks, open, close, report: reporting };
  }
  globalThis.MeetSession = { step, meetingIdFrom, isMeetCode, watchSettings, INITIAL };
})();
