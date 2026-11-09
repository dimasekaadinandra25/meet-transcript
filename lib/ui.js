(() => {
  const SHORTCUTS = [
    ['Live', '1'], ['History', '2'], ['Settings', '3'], ['← History', 'B'],
    ['Copy transcript', 'T'], ['Copy prompt', 'P'], ['Copy & open Gemini', 'G'], ['Copy & open ChatGPT', 'C'], ['Copy', 'C'],
    ['Generate MoM', 'M'], ['Regenerate MoM', 'M'], ['Paste into Gemini', 'G'], ['Paste into ChatGPT', 'C'],
    ['Download .txt', 'T'], ['Download .md', 'M'], ['Download recording', 'R'], ['Download audio', 'A'],
    ['Download video', 'V'], ['Download .docx', 'W'], ['Download .srt', 'B'], ['Download .vtt', 'K'],
    ['Download', 'U'], ['Save as PDF', 'P'],
    ['Delete', 'X'], ['Generate transcript', 'T'], ['Retranscribe', 'T'], ['Transcribe audio', 'T'],
    ['Stop recording', 'Q'], ['Mute microphone', 'N'], ['Unmute microphone', 'N'],
    ['Record audio + video', 'V'], ['Record audio', 'R'], ['Record', 'R'], ['Got it', 'O'],
    ['Open recordings folder', 'O'], ['Check for updates', 'U'], ['Open download page', 'D'], ['Allow microphone', 'A'],
    ['Test connection', 'T'], ['Save', 'S'], ['Export backup', 'X'], ['Import backup', 'I'],
    ['Import audio file', 'I'], ['Mark moment', 'H'], ['Ask', 'Y'], ['Open Settings', 'K'], ['Not now', 'Z'],
    ['Cancel import', 'Q'], ['Edit transcript', 'J'], ['Done editing', 'J'],
    ['Audio only', 'A'], ['Audio + video', 'V'], ['Microphone', 'M'], ['Caption language', 'L'],
    ['Indonesia', 'I'], ['English', 'N'], ['Show details', 'T'], ['See all', 'L'],
  ];
  const CAPTION_LANGUAGES = [
    ['keep', 'Leave as Meet has it'], ['en', 'English'], ['id', 'Indonesia'], ['ms', 'Bahasa Melayu'],
    ['zh', '中文'], ['ja', '日本語'], ['ko', '한국어'],
    ['hi', 'हिन्दी'], ['ar', 'العربية'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['pt', 'Português'],
  ];

  // Finds the Alt shortcut letter for a button label, if it has one.
  const shortcutFor = (label) => SHORTCUTS.find(([prefix]) => label.startsWith(prefix))?.[1];

  // Gives an element the Alt shortcut that matches its label.
  const setShortcut = (element, label) => {
    const key = shortcutFor(label);
    if (!key) return;
    element.dataset.shortcut = key;
    element.title = `Alt+${key}`;
    element.setAttribute('aria-keyshortcuts', `Alt+${key}`);
  };

  // Removes the Alt shortcut from an element.
  const clearShortcut = (element) => {
    delete element.dataset.shortcut;
    element.removeAttribute('title');
    element.removeAttribute('aria-keyshortcuts');
  };

  // Creates an element with an optional class and text, adding a shortcut to buttons.
  const el = (tag, cls, text) => {
    const element = document.createElement(tag);
    if (cls) element.className = cls;
    if (text != null) element.textContent = text;
    if (text != null && (tag === 'button' || tag === 'summary')) setShortcut(element, text);
    return element;
  };

  // Marks an element so the translator leaves its text alone.
  const raw = (element) => {
    element.dataset.raw = '';
    return element;
  };

  // Creates the transcript line that shows a marked moment.
  const markLine = (t) => {
    const label = `${globalThis.MeetMerge.markLabel()} ${new Date(t).toLocaleTimeString()}`;
    return raw(el('div', 'mark', label));
  };

  // Creates a button that runs fn on click and adds it to box.
  const mkBtn = (label, fn, box) => {
    const button = el('button', null, label);
    button.addEventListener('click', fn);
    box.append(button);
    return button;
  };

  // Adds an "Import audio file" button that asks for a file and hands it to onFile.
  const mkImportButton = (onFile, box) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'audio/*,video/*', hidden: true });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      const tooLarge = globalThis.MeetWav.isLargeFile(file.size);
      if (tooLarge && !confirm(globalThis.MeetI18n.t('This file is very large, and importing it may run out of memory. Continue?'))) {
        return;
      }
      onFile(file);
    });
    mkBtn('Import audio file', () => {
      input.value = '';
      input.click();
    }, box);
    box.append(input);
  };

  let openMenu = null;

  // Creates a dropdown menu that stays open across redraws and returns a way to add items.
  const mkDropdown = (container, key, label, opts = {}) => {
    const menu = el('details', 'menu' + (opts.cls ? ' ' + opts.cls : ''));
    const head = el('summary', null, label);
    const list = el('div', 'menu-list');
    menu.append(head, list);
    menu.open = openMenu === key;
    menu.addEventListener('toggle', () => {
      if (menu.open) openMenu = key;
      else if (openMenu === key) openMenu = null;
    });
    container.append(menu);
    const item = (text, fn) => {
      const button = mkBtn(text, () => {
        menu.open = false;
        openMenu = null;
        fn();
      }, list);
      const shortcut = button.dataset.shortcut;
      if (shortcut && list.querySelectorAll(`[data-shortcut="${shortcut}"]`).length > 1) clearShortcut(button);
      return button;
    };
    return { head, list, item, label };
  };

  document.addEventListener('click', (e) => {
    document.querySelectorAll('details.menu[open]').forEach((details) => {
      const clickedInside = e.target instanceof Node && details.contains(e.target);
      if (!clickedInside) details.open = false;
    });
  });
  document.querySelectorAll('nav button').forEach((button) => setShortcut(button, button.textContent));

  // Finds the first visible, enabled element under root with the given shortcut letter.
  const usable = (root, key) => [...root.querySelectorAll(`[data-shortcut="${key}"]`)]
    .find((element) => element.checkVisibility() && !element.disabled);

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

  // Hides the shortcut letters shown while Alt is held.
  const hideKeys = () => document.body.classList.remove('show-keys');

  document.addEventListener('keyup', (e) => {
    if (e.key !== 'Alt') return;
    e.preventDefault();
    hideKeys();
  });
  globalThis.addEventListener('blur', hideKeys);

  // Returns the storage key of a meeting.
  const meetingKey = (id) => 'meeting:' + id;

  // Merges a change into the saved settings.
  const patchSettings = async (patch) => {
    const current = (await chrome.storage.local.get('settings')).settings ?? {};
    await chrome.storage.local.set({ settings: { ...current, ...patch } });
  };

  globalThis.MeetUi = {
    CAPTION_LANGUAGES, el, raw, markLine, mkBtn, mkImportButton, mkDropdown, patchSettings, meetingKey, shortcutFor, clearShortcut,
  };
})();
