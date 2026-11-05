(() => {
  const S = globalThis.MeetSelectors;
  let want = 'id';
  let applied = false;
  let attempts = 0;
  let busy = false;
  let wasInCall = false;
  let goneTicks = 0;
  function reset() { applied = false; attempts = 0; }
  globalThis.MeetSession.watchSettings((s, isChange) => {
    want = s.captionLang ?? 'id';
    if (isChange) reset();
  });
  function apply() {
    const combo = S.langCombobox();
    if (!combo) return;
    const re = S.LANG_PATTERN[want];
    if (!re) return;
    if (re.test(combo.textContent.trim())) { applied = true; return; }
    attempts++;
    busy = true;
    combo.click();
    setTimeout(() => {
      const opt = S.langOption(re);
      if (opt) opt.click();
      else combo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      busy = false;
    }, 300);
  }
  const timer = setInterval(() => {
    if (!chrome.runtime?.id) { clearInterval(timer); return; }
    if (!S.inCall()) {
      if (++goneTicks >= 2) { wasInCall = false; reset(); }
      return;
    }
    goneTicks = 0;
    if (!wasInCall) { wasInCall = true; reset(); }
    if (applied || busy || attempts >= 3) return;
    apply();
  }, 2000);
})();
