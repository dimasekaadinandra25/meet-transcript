(() => {
  const SHORTCUTS = [
    ['Live', '1'], ['History', '2'], ['Settings', '3'], ['← History', 'B'],
    ['Copy transcript', 'T'], ['Copy prompt', 'P'], ['Copy & open Gemini', 'G'], ['Copy & open ChatGPT', 'C'], ['Copy', 'C'],
    ['Generate MoM', 'M'], ['Regenerate MoM', 'M'], ['Paste into Gemini', 'G'], ['Paste into ChatGPT', 'C'],
    ['Download .txt', 'T'], ['Download .md', 'M'], ['Download recording', 'R'], ['Download audio', 'A'], ['Download video', 'V'], ['Download .docx', 'W'], ['Download .srt', 'B'], ['Download .vtt', 'K'], ['Download', 'U'], ['Save as PDF', 'P'],
    ['Delete', 'X'], ['Generate transcript', 'T'], ['Retranscribe', 'T'], ['Transcribe audio', 'T'],
    ['Stop recording', 'Q'], ['Mute microphone', 'N'], ['Unmute microphone', 'N'],
    ['Record audio + video', 'V'], ['Record audio', 'R'], ['Record', 'R'], ['Got it', 'O'],
    ['Open recordings folder', 'O'], ['Check for updates', 'U'], ['Open download page', 'D'], ['Allow microphone', 'A'], ['Test connection', 'T'], ['Save', 'S'], ['Export backup', 'X'], ['Import backup', 'I'], ['Import audio file', 'I'], ['Mark moment', 'H'], ['Ask', 'Y'], ['Open Settings', 'K'], ['Not now', 'Z'], ['Cancel import', 'Q'], ['Edit transcript', 'J'], ['Done editing', 'J'],
    ['Audio only', 'A'], ['Audio + video', 'V'], ['Microphone', 'M'], ['Caption language', 'L'],
    ['Indonesia', 'I'], ['English', 'N'], ['Show details', 'T'], ['See all', 'L'],
  ];
  const shortcutFor = (label) => SHORTCUTS.find(([prefix]) => label.startsWith(prefix))?.[1];
  const setShortcut = (e, label) => {
    const key = shortcutFor(label);
    if (!key) return;
    e.dataset.shortcut = key;
    e.title = `Alt+${key}`;
    e.setAttribute('aria-keyshortcuts', `Alt+${key}`);
  };
  const clearShortcut = (e) => {
    delete e.dataset.shortcut;
    e.removeAttribute('title');
    e.removeAttribute('aria-keyshortcuts');
  };
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (text != null && (tag === 'button' || tag === 'summary')) setShortcut(e, text);
    return e;
  };
  const raw = (e) => {
    e.dataset.raw = '';
    return e;
  };
  const markLine = (t) => raw(el('div', 'mark', `${globalThis.MeetMerge.markLabel()} ${new Date(t).toLocaleTimeString()}`));
  const mkBtn = (label, fn, box) => {
    const b = el('button', null, label);
    b.addEventListener('click', fn);
    box.append(b);
    return b;
  };
  let openMenu = null;
  const mkDropdown = (container, key, label, opts = {}) => {
    const menu = el('details', 'menu' + (opts.cls ? ' ' + opts.cls : ''));
    const head = el('summary', null, label);
    const list = el('div', 'menu-list');
    menu.append(head, list);
    menu.open = openMenu === key;
    menu.addEventListener('toggle', () => {
      if (menu.open) openMenu = key; else if (openMenu === key) openMenu = null;
    });
    container.append(menu);
    const item = (text, fn) => {
      const button = mkBtn(text, () => { menu.open = false; fn(); }, list);
      const key = button.dataset.shortcut;
      if (key && list.querySelectorAll(`[data-shortcut="${key}"]`).length > 1) clearShortcut(button);
      return button;
    };
    return { head, list, item, label };
  };
  document.addEventListener('click', (e) => {
    document.querySelectorAll('details.menu[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
  });
  document.querySelectorAll('nav button').forEach((b) => setShortcut(b, b.textContent));
  const usable = (root, key) => [...root.querySelectorAll(`[data-shortcut="${key}"]`)]
    .find((e) => e.checkVisibility() && !e.disabled);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Alt') e.preventDefault();
    const plainAlt = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    document.body.classList.toggle('show-keys', plainAlt);
    if (!plainAlt || e.repeat) return;
    const key = e.code.replace(/^(Key|Digit)/, '');
    const menu = document.querySelector('details.menu[open] > .menu-list');
    const target = (menu && usable(menu, key)) ?? usable(document, key);
    if (!target) return;
    e.preventDefault();
    document.activeElement?.blur?.();
    target.click();
  });
  const hideKeys = () => document.body.classList.remove('show-keys');
  document.addEventListener('keyup', (e) => {
    if (e.key !== 'Alt') return;
    e.preventDefault();
    hideKeys();
  });
  globalThis.addEventListener('blur', hideKeys);
  const meetingKey = (id) => 'meeting:' + id;
  const patchSettings = async (patch) => {
    const cur = (await chrome.storage.local.get('settings')).settings ?? {};
    await chrome.storage.local.set({ settings: { ...cur, ...patch } });
  };
  globalThis.MeetUi = { el, raw, markLine, mkBtn, mkDropdown, patchSettings, meetingKey, shortcutFor, clearShortcut };
})();
