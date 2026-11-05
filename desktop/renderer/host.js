(() => {
  const { desktop } = window;
  const { el, mkBtn } = globalThis.MeetUi;
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
    now: () => Date.now(),
  });
  controller.recover().catch((e) => console.error(e));

  const send = (msg) => shim.runtime.sendMessage(msg);
  let chosenSource = '';
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
    select.append(Object.assign(document.createElement('option'), { value: chosenSource, textContent: 'Main screen' }));
    select.addEventListener('focus', async () => {
      const sources = await desktop.capture.sources();
      select.replaceChildren(...sources.map(({ id, name }) =>
        Object.assign(document.createElement('option'), { value: id, textContent: name })));
      select.value = chosenSource || sources.find((s) => s.id.startsWith('screen:'))?.id;
    }, { once: true });
    select.addEventListener('change', () => {
      chosenSource = select.value;
      desktop.capture.use(chosenSource);
    });
    return select;
  }

  function recordControls(rec, busyText) {
    const box = el('div', 'actions');
    if (rec.transcribing) {
      box.append(el('span', 'muted', busyText));
    } else if (rec.recording) {
      mkBtn('Stop recording', () => send({ type: 'stop-recording' }), box).classList.add('danger');
      mkBtn(rec.muted ? 'Unmute microphone' : 'Mute microphone', () => send({ type: 'set-muted', on: !rec.muted }), box);
      box.append(el('span', 'recording', rec.muted ? 'recording, microphone muted' : 'recording'));
      box.append(el('div', 'muted', 'Muting in the meeting app does not stop the microphone recording. Use the Mute button here.'));
    } else {
      if (!consentShown) box.append(consentNotice());
      mkBtn('Record audio', () => send({ type: 'start-recording', video: false }), box).classList.add('primary');
      mkBtn('Record audio + video', () => send({ type: 'start-recording', video: true }), box);
      box.append(sourcePicker());
      box.append(el('div', 'muted', 'Without a headset, other people can leak into your microphone and appear twice as "You".'));
    }
    return box;
  }

  function titleEditor(meeting) {
    const input = Object.assign(document.createElement('input'), { value: meeting.title });
    input.setAttribute('aria-label', 'Meeting title');
    input.addEventListener('change', () => send({ type: 'rename-meeting', id: meeting.id, title: input.value }));
    return input;
  }

  const COMMANDS = {
    'rec-start': () => send({ type: 'start-recording', video: false }),
    'rec-start-video': () => send({ type: 'start-recording', video: true }),
    'rec-stop': () => send({ type: 'stop-recording' }),
    'mute-toggle': async () => {
      const { rec } = await send({ type: 'get-active' });
      await send({ type: 'set-muted', on: !rec.muted });
    },
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
    fetch: (url, init) => globalThis.bridgeFetch(url, init),
    aiLabel: (name) => `Copy & open ${name}`,
    emptyLiveText: 'No recording yet. Press Record audio when the meeting starts.',
    emptySegmentsText: 'The transcript appears after you stop recording.',
    backupWarning: 'The backup file holds your API key in plain text. Keep it somewhere safe and do not share it.',
  };
})();
