(() => {
  const { desktop } = window;
  const { el, raw, mkBtn } = globalThis.MeetUi;
  let controller;

  const shim = globalThis.createChromeShim({ store: desktop.store, handle: (msg) => controller.handle(msg) });
  globalThis.chrome = shim;

  let chosenApp = null;
  let appSound = null;
  desktop.appAudio.onData((bytes) => appSound?.source.push(bytes));
  desktop.appAudio.onEnded(() => {
    const ended = appSound?.onEnded;
    appSound = null;
    ended?.();
  });

  async function openAppAudio(pid, ctx, onEnded) {
    const source = globalThis.MeetAppAudio.createPcmSource(ctx);
    appSound = { source, onEnded };
    const started = await desktop.appAudio.start(pid);
    if (!started.ok) {
      appSound = null;
      throw new Error(started.error);
    }
    return {
      node: source.node,
      close: () => {
        appSound = null;
        desktop.appAudio.stop();
      },
    };
  }

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
    chosenApp: () => chosenApp?.pid ?? null,
    checkVideoSource: async () => {
      if (!chosenSource || (await desktop.capture.sources()).some((source) => source.id === chosenSource)) return;
      throw new Error('The window chosen for video is closed. Choose another one, then record again.');
    },
    openAppAudio,
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
    clipAudio: (blob, from, to) => globalThis.MeetWav.clipDataUrl(blob, from, to),
    saveFile: async (name, blob, first) => desktop.recordings.write(name, await blob.arrayBuffer(), first),
    speakers: {
      available: () => desktop.speakers.available(),
      find: async (blobs, voices = []) => {
        const { wav, starts, references } = await globalThis.MeetWav.joinedWithVoices(voices, blobs);
        const answer = await desktop.speakers.find(await wav.arrayBuffer());
        if (!answer.ok) throw new Error(answer.error);
        return { starts, turns: answer.value, references };
      },
    },
    now: () => Date.now(),
  });
  desktop.capture.use('');
  controller.recover().catch((e) => console.error(e));

  async function useEngineByDefault() {
    const stored = await shim.storage.local.get(['settings', 'meetings']);
    if (!globalThis.MeetStt.neverConfigured(stored) || !await desktop.engine.available()) return;
    await globalThis.MeetUi.patchSettings({ sttMode: 'builtin' });
  }
  useEngineByDefault().catch((e) => console.error(e));

  const tellLanguage = (settings) => desktop.setLanguage(settings?.uiLang);
  shim.storage.local.get('settings').then(({ settings }) => {
    tellLanguage(settings);
    if (settings?.engineModel) desktop.engine.useModel(settings.engineModel);
  });
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
    box.append(el('div', null, 'A recording captures the sound from your computer and, if turned on, your microphone. It is kept on this computer, and its audio goes only to the speech-to-text service you choose. Your computer may ask you to allow the microphone or screen next.'));
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

  const meters = { system: null, mic: null };

  const appName = (name) => name.replace(/\.exe$/i, '');
  let canPickApp = false;
  desktop.appAudio.available().then((ready) => {
    canPickApp = ready;
    if (ready) redrawLive();
  });

  function appPicker() {
    const select = el('select');
    select.setAttribute('aria-label', 'Sound to record');
    const option = (value, textContent) => Object.assign(document.createElement('option'), { value, textContent });
    const app = (entry) => raw(option(String(entry.pid), appName(entry.name)));
    select.append(option('', 'All computer sound'));
    if (chosenApp) select.append(app(chosenApp));
    select.value = String(chosenApp?.pid ?? '');
    select.addEventListener('focus', async () => {
      const apps = await desktop.appAudio.list();
      const listed = [...apps].sort((a, b) => Number(b.active) - Number(a.active));
      select.replaceChildren(option('', 'All computer sound'), ...listed.map(app));
      if (!listed.some((entry) => entry.pid === chosenApp?.pid)) chosenApp = null;
      select.value = String(chosenApp?.pid ?? '');
    });
    select.addEventListener('change', () => {
      const pid = Number(select.value);
      chosenApp = pid ? { pid, name: select.selectedOptions[0].textContent } : null;
    });
    return select;
  }

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
      mkBtn(rec.paused ? 'Resume recording' : 'Pause recording', () => send({ type: 'set-paused', on: !rec.paused }), box);
      mkBtn(rec.muted ? 'Unmute microphone' : 'Mute microphone', () => send({ type: 'set-muted', on: !rec.muted }), box);
      mkBtn('Mark moment', () => send({ type: 'mark-moment' }), box);
      box.append(el('span', 'recording', rec.paused ? 'paused, nothing is being recorded' : rec.muted ? 'recording, microphone muted' : 'recording'));
      box.append(levelBars());
      box.append(el('div', 'muted', 'Muting in the meeting app does not stop the microphone recording. Use the Mute button here.'));
    } else {
      if (!consentShown) box.append(consentNotice());
      mkBtn('Record audio', () => send({ type: 'start-recording', video: false }), box).classList.add('primary');
      mkBtn('Record audio + video', () => send({ type: 'start-recording', video: true }), box);
      box.append(sourcePicker());
      if (canPickApp) box.append(appPicker());
      globalThis.MeetUi.mkImportButton((file) => send({ type: 'import-audio', file }), box);
      box.append(el('div', 'muted', 'Without a headset, other people can leak into your microphone. Repeated lines are removed, but some may stay as "You".'));
    }
    return box;
  }

  function voicesRow(settings) {
    const box = el('div');
    box.hidden = true;
    const list = el('div', 'voice-list');
    const fill = async () => {
      const { voices = [] } = await chrome.storage.local.get('voices');
      list.replaceChildren(...(voices.length ? voices.map((voice) => {
        const row = el('div', 'actions');
        row.append(raw(el('span', null, voice.name)));
        const forget = mkBtn('Forget', async () => {
          const { voices: now = [] } = await chrome.storage.local.get('voices');
          await chrome.storage.local.set({ voices: now.filter((v) => v.name !== voice.name) });
          await fill();
        }, row);
        forget.setAttribute('aria-label', `${globalThis.MeetI18n.t('Forget')} ${voice.name}`);
        return row;
      }) : [el('p', 'muted', 'No saved voices yet. Rename a guessed speaker, such as Speaker 1, to save a short sample of their voice.')]));
    };
    box.append(settingToggle('rememberVoices', 'Remember the voices you name, so later meetings name those speakers on their own', settings.rememberVoices !== false), list);
    desktop.speakers.available().then((on) => {
      box.hidden = !on;
      if (on) fill();
    }).catch(() => {});
    return box;
  }

  function settingToggle(key, label, on) {
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: on });
    box.addEventListener('change', () => globalThis.MeetUi.patchSettings({ [key]: box.checked }));
    const row = el('label');
    row.append(box, label);
    return row;
  }

  const MODEL_NAMES = { base: 'Standard (included)', small: 'Better', medium: 'Best, slower' };
  const megabytes = (bytes) => Math.round(bytes / 1000000);
  let showModelProgress = () => {};
  desktop.engine.onModelProgress((progress) => showModelProgress(progress));

  function modelOption({ id, bytes, installed }) {
    const name = MODEL_NAMES[id];
    return Object.assign(document.createElement('option'), { value: id, textContent: installed ? name : `${name} (${megabytes(bytes)} MB download)` });
  }

  function engineModelRow(settings) {
    const row = el('div');
    row.hidden = true;
    const select = el('select');
    const note = el('span', 'muted');
    row.append(el('label', null, 'Built-in engine accuracy'), select, note);
    let current = settings.engineModel ?? 'base';
    const fill = async () => {
      const models = await desktop.engine.models();
      if (!models.some((model) => model.id === current && model.installed)) current = 'base';
      select.replaceChildren(modelOption({ id: 'base', installed: true }), ...models.map(modelOption));
      select.value = current;
      return models;
    };
    desktop.engine.available().then((ready) => {
      if (!ready) return;
      row.hidden = false;
      fill().then(() => desktop.engine.useModel(current)).catch((e) => console.error(e));
    });
    select.addEventListener('change', async () => {
      const { t } = globalThis.MeetI18n;
      const id = select.value;
      const busy = async () => {
        const { rec } = await send({ type: 'get-active' });
        return rec.recording || rec.transcribing;
      };
      if (await busy()) {
        select.value = current;
        note.textContent = 'Wait until the recording or transcript finishes.';
        return;
      }
      const missing = (await desktop.engine.models()).find((model) => model.id === id && !model.installed);
      if (missing) {
        if (!confirm(t('Download about {} MB now? It stays on this computer.').replace('{}', megabytes(missing.bytes)))) {
          select.value = current;
          return;
        }
        select.disabled = true;
        showModelProgress = ({ percent }) => { note.textContent = `Downloading… ${percent}%`; };
        const res = await desktop.engine.downloadModel(id);
        showModelProgress = () => {};
        select.disabled = false;
        if (!res.ok) {
          select.value = current;
          note.textContent = res.error;
          return;
        }
        if (await busy()) {
          await fill();
          note.textContent = 'Downloaded. Choose it again when the recording or transcript finishes.';
          return;
        }
      }
      await desktop.engine.useModel(id);
      await globalThis.MeetUi.patchSettings({ engineModel: id });
      current = id;
      await fill();
      note.textContent = 'Ready.';
    });
    return row;
  }

  function settingsRows(settings) {
    const open = el('div', 'actions');
    mkBtn('Open recordings folder', () => desktop.recordings.open(), open);
    const loginRow = settingToggle('startAtLogin', 'Start hidden in the tray when you sign in to your computer', false);
    const loginBox = loginRow.querySelector('input');
    loginRow.hidden = true;
    desktop.loginItem().then(({ available, on }) => {
      loginRow.hidden = !available;
      loginBox.checked = on;
    }).catch(() => {});
    loginBox.addEventListener('change', () => desktop.setLoginItem(loginBox.checked));
    const speakersRow = settingToggle('localSpeakers', 'Tell other speakers apart on this computer after each recording (long meetings take a few extra minutes)', settings.localSpeakers !== false);
    speakersRow.hidden = true;
    desktop.speakers.available().then((on) => { speakersRow.hidden = !on; }).catch(() => {});
    return [
      engineModelRow(settings),
      el('h3', null, 'Window'),
      settingToggle('keepInTray', 'Keep running in the tray when you close the window, so shortcuts keep working', settings.keepInTray !== false),
      loginRow,
      el('h3', null, 'Recordings'),
      settingToggle('autoSave', 'Save each recording to Documents/Transcripables', settings.autoSave !== false),
      open,
      ...(canPickApp ? [settingToggle('askToRecord', 'Ask to record when another app starts using the microphone', settings.askToRecord !== false)] : []),
      settingToggle('liveTranscript', 'Show the transcript during the meeting (sends audio to speech-to-text every 2 minutes)', settings.liveTranscript !== false),
      speakersRow,
      voicesRow(settings),
      el('h3', null, 'Updates'),
      globalThis.createUpdateRow({ el, mkBtn, check: () => desktop.checkForUpdate(), open: () => desktop.openUpdate() }),
    ];
  }

  const COMMANDS = {
    'rec-start': () => send({ type: 'start-recording', video: false }),
    'rec-start-video': () => send({ type: 'start-recording', video: true }),
    'rec-stop': () => send({ type: 'stop-recording' }),
    'pause-toggle': async () => {
      const { rec } = await send({ type: 'get-active' });
      await send({ type: 'set-paused', on: !rec.paused });
    },
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
    makePdf: () => desktop.makePdf(),
    hasEngine: () => desktop.engine.available(),
    settingsRows,
    fetch: (url, init) => globalThis.bridgeFetch(url, init),
    shareMom: (kind, settings, meeting) => globalThis.shareMom(kind, settings, meeting),
    openMail: (url) => desktop.openExternal(url),
    aiLabel: (name) => `Copy & open ${name}`,
    emptyLiveText: 'No recording yet. Press Record audio when the meeting starts.',
    emptySegmentsText: 'The transcript appears about every 2 minutes, and finishes when you stop.',
    deleteNote: ' Copies in your Documents/Transcripables folder stay.',
    editHint: 'Renaming a guessed speaker also saves a short sample of their voice on this computer, so later meetings name them on their own. Manage saved voices in Settings.',
  };
})();
