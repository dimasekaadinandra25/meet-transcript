(() => {
  const S = globalThis.MeetSelectors;
  const style = document.createElement('style');
  style.textContent = S.CAPTION_REGION.join(', ') + ' { display: none !important; }';
  let on = true;
  let goneTicks = 0;

  // Hides Meet's caption overlay while in a call, and shows it again once the call is over.
  const sync = (tick = false) => {
    if (on && S.inCall()) {
      goneTicks = 0;
      if (!style.isConnected) document.documentElement.append(style);
    } else if (!on || (tick && ++goneTicks >= 2)) {
      style.remove();
    }
  };

  // Follows the "hide captions" setting.
  globalThis.MeetSession.watchSettings((settings) => {
    on = settings.hideCaptions !== false;
    sync();
  });

  // Rechecks every two seconds, and stops once the extension is reloaded or removed.
  const timer = setInterval(() => {
    if (!chrome.runtime?.id) {
      clearInterval(timer);
      style.remove();
      return;
    }
    sync(true);
  }, 2000);
})();
