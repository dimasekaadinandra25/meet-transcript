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
    now: () => Date.now(),
  });
  controller.recover().catch((e) => console.error(e));

  const send = (msg) => shim.runtime.sendMessage(msg);
  let chosenSource = '';

  function sourcePicker() {
    const select = el('select');
    select.setAttribute('aria-label', 'Layar atau jendela untuk video');
    select.append(Object.assign(document.createElement('option'), { value: chosenSource, textContent: 'Layar utama' }));
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
      mkBtn('Stop rekam', () => send({ type: 'stop-recording' }), box);
      mkBtn(rec.muted ? 'Nyalakan mikrofon' : 'Bisukan mikrofon', () => send({ type: 'set-muted', on: !rec.muted }), box);
      box.append(el('span', 'muted', rec.muted ? '● merekam, mikrofon dibisukan' : '● merekam'));
      box.append(el('div', 'muted', 'Mute di aplikasi meeting tidak menghentikan rekaman mikrofon. Pakai tombol Bisukan di sini.'));
    } else {
      mkBtn('Rekam audio', () => send({ type: 'start-recording', video: false }), box);
      mkBtn('Rekam audio + video', () => send({ type: 'start-recording', video: true }), box);
      box.append(sourcePicker());
      box.append(el('div', 'muted', 'Tanpa headset, suara peserta bisa bocor ke mikrofon dan muncul dobel sebagai "You".'));
    }
    return box;
  }

  function titleEditor(meeting) {
    const input = Object.assign(document.createElement('input'), { value: meeting.title });
    input.setAttribute('aria-label', 'Judul meeting');
    input.addEventListener('change', () => send({ type: 'rename-meeting', id: meeting.id, title: input.value }));
    return input;
  }

  globalThis.PanelHost = {
    recordControls,
    titleEditor,
    fetch: (url, init) => globalThis.bridgeFetch(url, init),
    aiLabel: (name) => `Salin & buka ${name}`,
    emptyLiveText: 'Belum ada rekaman. Tekan Rekam audio saat meeting dimulai.',
    emptySegmentsText: 'Transkrip muncul setelah rekaman dihentikan.',
    backupWarning: 'File backup memuat API key dalam teks polos. Simpan di tempat yang aman dan jangan dibagikan.',
  };
})();
