(() => {
  const MEET_CODE = '[a-z]{3}-[a-z]{4}-[a-z]{3}';
  const MEET_CODE_RE = new RegExp(`^${MEET_CODE}$`);
  const MEET_PATH_RE = new RegExp(`^/(?:_?meet/)?(${MEET_CODE})$`);
  const LEAVE_TICKS = 2;

  // Returns the Meet code from a page path, or null when the path is not a meeting room.
  function meetingIdFrom(pathname) {
    const match = String(pathname ?? '').match(MEET_PATH_RE);
    return match ? match[1] : null;
  }

  // Tells whether an id looks like a Google Meet code such as abc-defg-hij.
  const isMeetCode = (id) => MEET_CODE_RE.test(id);

  // Calls apply with the saved settings now and again every time they change.
  function watchSettings(apply) {
    let changed = false;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      changed = true;
      apply(changes.settings.newValue ?? {}, true);
    });
    chrome.storage.local.get('settings').then((data) => {
      if (!changed) apply(data.settings ?? {}, false);
    }).catch(() => {});
  }

  const INITIAL = { curId: null, reporting: false, sawInCall: false, goneTicks: 0 };

  // Advances the meeting session by one tick and says whether to open, close or report it.
  function step(state, { id, inCall }) {
    let { curId, reporting, sawInCall, goneTicks } = state;
    let open = false;
    let close = false;
    if (id && id !== curId) {
      close = reporting;
      curId = id;
      reporting = true;
      sawInCall = false;
      goneTicks = 0;
      open = true;
    }
    if (!curId) return { ...INITIAL, open, close, report: false };
    if (inCall) {
      if (!reporting) {
        open = true;
        reporting = true;
        goneTicks = 0;
      }
      sawInCall = true;
      goneTicks = 0;
      return { curId, reporting, sawInCall, goneTicks, open, close, report: true };
    }
    const leaving = !id || sawInCall;
    if (reporting && leaving && ++goneTicks >= LEAVE_TICKS) {
      return {
        curId: id ?? null, reporting: false, sawInCall: false, goneTicks: 0,
        open, close: true, report: false,
      };
    }
    return { curId, reporting, sawInCall, goneTicks, open, close, report: reporting };
  }

  globalThis.MeetSession = { step, meetingIdFrom, isMeetCode, watchSettings, INITIAL };
})();
