(() => {
  const { desktop } = window;
  const { el, raw, mkBtn } = globalThis.MeetUi;
  let controller;

  const shim = globalThis.createChromeShim({ store: desktop.store, handle: (msg) => controller.handle(msg) });
  globalThis.chrome = shim;

  const recorder = globalThis.createRecorder({
    AudioContext,
    MediaRecorder,
    MediaStream,
    store: globalThis.MeetAudioStore,
    getDisplayMedia: (constraints) => navigator.mediaDevices.getDisplayMedia(constraints),
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    warn: (message) => controller.warn(message),
    onLevels: (levels) => showLevels(levels),
    onChunkSaved: () => controller.chunkSaved(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
  });

  controller = globalThis.createController({
    recorder,
    audioStore: globalThis.MeetAudioStore,
    storage: shim.storage.local,
    merge: globalThis.MeetMerge,
    stt: globalThis.MeetStt,
    tracks: globalThis.MeetTracks,
    openai: globalThis.MeetOpenAI,
    notify: (msg) => shim.runtime.emit(msg),
    openExternal: (url) => desktop.openExternal(url),
    onState: (state) => desktop.recState?.(state),
    onWarning: () => desktop.revealWindow(),
    probeStt: (url, key) => desktop.net.probe(url, key),
    startEngine: () => desktop.engine.start(),
    splitAudio: (file, seconds) => globalThis.MeetWav.speechParts(file, seconds),
    saveFile: async (name, blob, first) => desktop.recordings.write(name, await blob.arrayBuffer(), first),
    now: () => Date.now(),
  });
  controller.recover().catch((e) => console.error(e));

  async function useEngineByDefault() {
    const stored = await shim.storage.local.get(['settings', 'meetings']);
    if (!globalThis.MeetStt.neverConfigured(stored) || !await desktop.engine.available()) return;
    await globalThis.MeetUi.patchSettings({ sttMode: 'builtin' });
  }
  useEngineByDefault().catch((e) => console.error(e));

  const tellLanguage = (settings) => desktop.setLanguage(settings?.uiLang);
  shim.storage.local.get('settings').then(({ settings }) => tellLanguage(settings));
  shim.storage.onChanged.addListener((changes) => {
    if (changes.settings) tellLanguage(changes.settings.newValue);
  });

  const send = (msg) => shim.runtime.sendMessage(msg);
  let chosenSource = '';
  let chosenName = '';
  let consentShown = true;

  async function redrawLive() {
    const { rec, ...status } = await send({ type: 'get-active' });
    shim.runtime.emit({ type: 'status', ...status });
  }

  shim.storage.local.get('consentShown').then((data) => {
    if (data.consentShown) return;
    consentShown = false;
    redrawLive();
  });
  desktop.onWarn((message) => controller.warn(message));

  function consentNotice() {
    const box = el('div', 'info');
    box.append(el('div', null, 'Before recording, make sure everyone in the meeting agrees. Getting their permission is your responsibility.'));
    mkBtn('Got it', async () => {
      await shim.storage.local.set({ consentShown: true });
      consentShown = true;
      redrawLive();
    }, box);
    return box;
  }

  function sourcePicker() {
    const select = el('select');
    select.setAttribute('aria-label', 'Screen or window for video');
    const current = Object.assign(document.createElement('option'), { value: chosenSource, textContent: chosenName || 'Main screen' });
    select.append(chosenName ? raw(current) : current);
    select.addEventListener('focus', async () => {
      const sources = await desktop.capture.sources();
      select.replaceChildren(...sources.map(({ id, name }) =>
        raw(Object.assign(document.createElement('option'), { value: id, textContent: name }))));
      select.value = chosenSource || sources.find((s) => s.id.startsWith('screen:'))?.id;
    }, { once: true });
    select.addEventListener('change', () => {
      chosenSource = select.value;
      chosenName = select.selectedOptions[0].textContent;
      desktop.capture.use(chosenSource);
    });
    return select;
  }

  function importButton(box) {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'audio/*,video/*', hidden: true });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      if (globalThis.MeetWav.isLargeFile(file.size) && !confirm(globalThis.MeetI18n.t('This file is very large, and importing it may run out of memory. Continue?'))) return;
      send({ type: 'import-audio', file });
    });
    mkBtn('Import audio file', () => {
      input.value = '';
      input.click();
    }, box);
    box.append(input);
  }

  const meters = { system: null, mic: null };

  function levelRow(name, label) {
    const row = el('div', 'level');
    const meter = Object.assign(document.createElement('meter'), { min: 0, max: 1, value: 0 });
    meter.setAttribute('aria-label', `${label} level`);
    meters[name] = meter;
    row.append(el('span', 'muted', label), meter);
    return row;
  }

  function levelBars() {
    const box = el('div', 'levels');
    box.append(levelRow('system', 'Computer'), levelRow('mic', 'Microphone'));
    return box;
  }

  function showLevels(levels) {
    for (const [name, meter] of Object.entries(meters)) {
      if (!meter) continue;
      meter.parentElement.hidden = levels[name] === undefined;
      meter.value = Math.sqrt(levels[name] ?? 0);
    }
  }

  function recordControls(rec, busyText) {
    const box = el('div', 'actions');
    if (rec.transcribing) {
      box.append(el('span', 'muted', busyText));
      if (rec.importing) mkBtn('Cancel import', () => send({ type: 'cancel-import' }), box);
    } else if (rec.recording) {
      mkBtn('Stop recording', () => send({ type: 'stop-recording' }), box).classList.add('danger');
      mkBtn(rec.muted ? 'Unmute microphone' : 'Mute microphone', () => send({ type: 'set-muted', on: !rec.muted }), box);
      mkBtn('Mark moment', () => send({ type: 'mark-moment' }), box);
      box.append(el('span', 'recording', rec.muted ? 'recording, microphone muted' : 'recording'));
      box.append(levelBars());
      box.append(el('div', 'muted', 'Muting in the meeting app does not stop the microphone recording. Use the Mute button here.'));
    } else {
      if (!consentShown) box.append(consentNotice());
      mkBtn('Record audio', () => send({ type: 'start-recording', video: false }), box).classList.add('primary');
      mkBtn('Record audio + video', () => send({ type: 'start-recording', video: true }), box);
      box.append(sourcePicker());
      importButton(box);
      box.append(el('div', 'muted', 'Without a headset, other people can leak into your microphone and appear twice as "You".'));
    }
    return box;
  }

  function titleEditor(meeting) {
    const input = Object.assign(document.createElement('input'), { value: meeting.title, defaultValue: meeting.title });
    input.dataset.titleEditor = '';
    input.setAttribute('aria-label', 'Meeting title');
    input.addEventListener('change', () => {
      input.defaultValue = input.value;
      send({ type: 'rename-meeting', id: meeting.id, title: input.value });
    });
    return input;
  }

  function settingToggle(key, label, on) {
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: on });
    box.addEventListener('change', () => globalThis.MeetUi.patchSettings({ [key]: box.checked }));
    const row = el('label');
    row.append(box, label);
    return row;
  }

  function settingsRows(settings) {
    const open = el('div', 'actions');
    mkBtn('Open recordings folder', () => desktop.recordings.open(), open);
    return [
      el('h3', null, 'Recordings'),
      settingToggle('autoSave', 'Save each recording to Documents/Transcripables', settings.autoSave !== false),
      open,
      settingToggle('liveTranscript', 'Show the transcript during the meeting (sends audio to speech-to-text every 2 minutes)', settings.liveTranscript !== false),
      el('h3', null, 'Updates'),
      globalThis.createUpdateRow({ el, mkBtn, check: () => desktop.checkForUpdate(), open: () => desktop.openUpdate() }),
    ];
  }

  const COMMANDS = {
    'rec-start': () => send({ type: 'start-recording', video: false }),
    'rec-start-video': () => send({ type: 'start-recording', video: true }),
    'rec-stop': () => send({ type: 'stop-recording' }),
    'mute-toggle': async () => {
      const { rec } = await send({ type: 'get-active' });
      await send({ type: 'set-muted', on: !rec.muted });
    },
    mark: () => send({ type: 'mark-moment' }),
    'quit-after-stop': async () => {
      await send({ type: 'stop-recording', transcribe: false });
      await desktop.quitNow();
    },
  };

  async function runCommand(command) {
    await COMMANDS[command]();
  }

  globalThis.PanelHost = {
    runCommand,
    recordControls,
    titleEditor,
    makePdf: () => desktop.makePdf(),
    hasEngine: () => desktop.engine.available(),
    settingsRows,
    fetch: (url, init) => globalThis.bridgeFetch(url, init),
    aiLabel: (name) => `Copy & open ${name}`,
    emptyLiveText: 'No recording yet. Press Record audio when the meeting starts.',
    emptySegmentsText: 'The transcript appears about every 2 minutes, and finishes when you stop.',
    deleteNote: ' Copies in your Documents/Transcripables folder stay.',
    backupWarning: 'The backup file holds your API key in plain text. Keep it somewhere safe and do not share it.',
  };
})();
