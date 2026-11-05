(() => {
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
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
  const meetingKey = (id) => 'meeting:' + id;
  const patchSettings = async (patch) => {
    const cur = (await chrome.storage.local.get('settings')).settings ?? {};
    await chrome.storage.local.set({ settings: { ...cur, ...patch } });
  };
  globalThis.MeetUi = { el, mkBtn, mkDropdown, patchSettings, meetingKey };
})();
