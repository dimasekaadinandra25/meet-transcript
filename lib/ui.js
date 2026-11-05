(() => {
  const SHORTCUTS = [
    ['Live', '1'], ['Riwayat', '2'], ['Settings', '3'], ['← Riwayat', 'B'],
    ['Copy transkrip', 'T'], ['Copy Prompt', 'P'], ['Copy', 'C'],
    ['Generate MoM', 'M'], ['Regenerate MoM', 'M'],
    ['Tempel ke Gemini', 'G'], ['Salin & buka Gemini', 'G'], ['Tempel ke ChatGPT', 'C'], ['Salin & buka ChatGPT', 'C'],
    ['Unduh .txt', 'T'], ['Unduh .md', 'M'], ['Unduh rekaman', 'R'], ['Unduh audio', 'A'], ['Unduh video', 'V'], ['Unduh', 'U'],
    ['Hapus', 'X'], ['Generate transkrip', 'T'], ['Transkrip', 'T'],
    ['Stop rekam', 'S'], ['Bisukan mikrofon', 'N'], ['Nyalakan mikrofon', 'N'],
    ['Rekam audio + video', 'V'], ['Rekam audio', 'R'], ['Rekam', 'R'], ['Mengerti', 'O'],
    ['Izinkan mikrofon', 'Z'], ['Tes koneksi', 'K'], ['Simpan', 'S'], ['Export backup', 'X'], ['Import backup', 'I'],
    ['Audio saja', 'A'], ['Audio + video', 'V'], ['Mikrofon', 'M'], ['Bahasa caption', 'B'],
    ['Indonesia', 'I'], ['English', 'N'], ['Tampilkan detail', 'T'], ['Lihat semua', 'L'],
  ];
  const shortcutFor = (label) => SHORTCUTS.find(([prefix]) => label.startsWith(prefix))?.[1];
  const setShortcut = (e, label) => {
    const key = shortcutFor(label);
    if (!key) return;
    e.dataset.shortcut = key;
    e.title = `Alt+${key}`;
    e.setAttribute('aria-keyshortcuts', `Alt+${key}`);
  };
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (text != null && (tag === 'button' || tag === 'summary')) setShortcut(e, text);
    return e;
  };
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
    const item = (text, fn) => mkBtn(text, () => { menu.open = false; fn(); }, list);
    return { head, list, item, label };
  };
  document.addEventListener('click', (e) => {
    document.querySelectorAll('details.menu[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
  });
  document.querySelectorAll('nav button').forEach((b) => setShortcut(b, b.textContent));
  const usable = (root, key) => [...root.querySelectorAll(`[data-shortcut="${key}"]`)]
    .find((e) => e.checkVisibility() && !e.disabled);
  document.addEventListener('keydown', (e) => {
    const plainAlt = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    document.body.classList.toggle('show-keys', plainAlt);
    if (!plainAlt || e.repeat) return;
    const key = e.code.replace(/^(Key|Digit)/, '');
    const menu = document.querySelector('details.menu[open] > .menu-list');
    const target = (menu && usable(menu, key)) ?? usable(document, key);
    if (!target) return;
    e.preventDefault();
    target.click();
  });
  const hideKeys = () => document.body.classList.remove('show-keys');
  document.addEventListener('keyup', (e) => { if (e.key === 'Alt') hideKeys(); });
  globalThis.addEventListener('blur', hideKeys);
  const meetingKey = (id) => 'meeting:' + id;
  const patchSettings = async (patch) => {
    const cur = (await chrome.storage.local.get('settings')).settings ?? {};
    await chrome.storage.local.set({ settings: { ...cur, ...patch } });
  };
  globalThis.MeetUi = { el, mkBtn, mkDropdown, patchSettings, meetingKey, shortcutFor };
})();
