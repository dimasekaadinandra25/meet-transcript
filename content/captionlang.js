(() => {
  const S = globalThis.MeetSelectors;
  let want = 'en';
  let applied = false;
  let attempts = 0;
  let busy = false;
  let wasInCall = false;
  let goneTicks = 0;

  // Forgets earlier attempts so the caption language is set again.
  function reset() {
    applied = false;
    attempts = 0;
  }

  // Follows the caption language setting and retries when it changes.
  globalThis.MeetSession.watchSettings((settings, isChange) => {
    want = settings.captionLang ?? 'en';
    if (isChange) reset();
  });

  // Opens Meet's caption language dropdown and picks the wanted language.
  function apply() {
    const combo = S.langCombobox();
    if (!combo) return;
    const pattern = S.LANG_PATTERN[want];
    if (!pattern) return;
    if (pattern.test(combo.textContent.trim())) {
      applied = true;
      return;
    }
    attempts++;
    busy = true;
    combo.click();
    setTimeout(() => {
      const option = S.langOption(pattern);
      if (option) option.click();
      else combo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      busy = false;
    }, 300);
  }

  // Every two seconds, sets the caption language once per call (up to three tries).
  const timer = setInterval(() => {
    if (!chrome.runtime?.id) {
      clearInterval(timer);
      return;
    }
    if (!S.inCall()) {
      if (++goneTicks >= 2) {
        wasInCall = false;
        reset();
      }
      return;
    }
    goneTicks = 0;
    if (!wasInCall) {
      wasInCall = true;
      reset();
    }
    if (applied || busy || attempts >= 3) return;
    apply();
  }, 2000);
})();
