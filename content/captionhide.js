(() => {
  const S = globalThis.MeetSelectors;
  const style = document.createElement('style');
  style.textContent = S.CAPTION_REGION.join(', ') + ' { display: none !important; }';
  let on = true;
  let goneTicks = 0;
  const sync = (tick = false) => {
    if (on && S.inCall()) {
      goneTicks = 0;
      if (!style.isConnected) document.documentElement.append(style);
    } else if (!on || (tick && ++goneTicks >= 2)) {
      style.remove();
    }
  };
  globalThis.MeetSession.watchSettings((s) => {
    on = s.hideCaptions !== false;
    sync();
  });
  const timer = setInterval(() => {
    if (!chrome.runtime?.id) { clearInterval(timer); style.remove(); return; }
    sync(true);
  }, 2000);
})();
