(() => {
  const UPDATE_TEXT = {
    available: ({ latest }) => `Version ${latest} is available.`,
    current: () => 'You have the latest version.',
    none: () => 'No releases have been published yet.',
    failed: ({ error }) => `Could not check for updates (${error}).`,
  };

  function createUpdateRow({ el, mkBtn, check, open }) {
    const box = el('div', 'actions');
    const note = el('span', 'muted');
    let openPage;
    const button = mkBtn('Check for updates', async () => {
      button.disabled = true;
      note.textContent = 'Checking…';
      const result = await check();
      button.disabled = false;
      note.textContent = UPDATE_TEXT[result.status](result);
      if (result.status === 'available') openPage ??= mkBtn('Open download page', open, box);
    }, box);
    box.append(note);
    return box;
  }

  globalThis.createUpdateRow = createUpdateRow;
})();
