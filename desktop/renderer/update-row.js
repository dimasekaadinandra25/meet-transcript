(() => {
  const UPDATE_TEXT = {
    // Says which newer version is out.
    available: ({ latest }) => `Version ${latest} is available.`,
    // Says the app is up to date.
    current: () => 'You have the latest version.',
    // Says nothing has been released yet.
    none: () => 'No releases have been published yet.',
    // Says the update check failed and why.
    failed: ({ error }) => `Could not check for updates (${error}).`,
  };

  // Builds the settings row with a "Check for updates" button and its result.
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
