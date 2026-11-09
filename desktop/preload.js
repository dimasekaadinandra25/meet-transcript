const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  store: {
    get: (keys) => ipcRenderer.invoke('store:get', keys),
    set: (values) => ipcRenderer.invoke('store:set', values),
    remove: (keys) => ipcRenderer.invoke('store:remove', keys),
    clear: () => ipcRenderer.invoke('store:clear'),
    onChanged: (listener) => ipcRenderer.on('store:changed', (_event, changes) => listener(changes)),
  },
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  recState: (state) => ipcRenderer.invoke('rec:state', state),
  setLanguage: (code) => ipcRenderer.invoke('app:language', code),
  revealWindow: () => ipcRenderer.invoke('window:reveal'),
  quitNow: () => ipcRenderer.invoke('app:quit'),
  onWarn: (listener) => ipcRenderer.on('main:warn', (_event, message) => listener(message)),
  recordings: {
    write: (name, bytes, first) => ipcRenderer.invoke('recordings:write', name, bytes, first),
    open: () => ipcRenderer.invoke('recordings:open'),
  },
  checkForUpdate: () => ipcRenderer.invoke('app:update-check'),
  openUpdate: () => ipcRenderer.invoke('app:update-open'),
  loginItem: () => ipcRenderer.invoke('app:login-item'),
  setLoginItem: (on) => ipcRenderer.invoke('app:set-login-item', on),
  makePdf: () => ipcRenderer.invoke('pdf:make'),
  capture: {
    sources: () => ipcRenderer.invoke('capture:sources'),
    use: (id) => ipcRenderer.invoke('capture:use', id),
  },
  appAudio: {
    available: () => ipcRenderer.invoke('appaudio:available'),
    list: () => ipcRenderer.invoke('appaudio:list'),
    start: (pid) => ipcRenderer.invoke('appaudio:start', pid),
    stop: () => ipcRenderer.invoke('appaudio:stop'),
    onData: (listener) => ipcRenderer.on('appaudio:data', (_event, bytes) => listener(bytes)),
    onEnded: (listener) => ipcRenderer.on('appaudio:ended', () => listener()),
  },
  engine: {
    available: () => ipcRenderer.invoke('engine:available'),
    start: () => ipcRenderer.invoke('engine:start'),
    models: () => ipcRenderer.invoke('engine:models'),
    downloadModel: (id) => ipcRenderer.invoke('engine:download-model', id),
    useModel: (id) => ipcRenderer.invoke('engine:use-model', id),
    onModelProgress: (listener) => {
      ipcRenderer.on('engine:model-progress', (_event, progress) => listener(progress));
    },
  },
  speakers: {
    available: () => ipcRenderer.invoke('speakers:available'),
    find: (bytes) => ipcRenderer.invoke('speakers:find', bytes),
  },
  net: {
    chat: (args) => ipcRenderer.invoke('net:chat', args),
    test: (args) => ipcRenderer.invoke('net:test', args),
    stt: (args) => ipcRenderer.invoke('net:stt', args),
    probe: (url, key) => ipcRenderer.invoke('net:probe', url, key),
    share: (kind, settings, meeting) => ipcRenderer.invoke('net:share', kind, settings, meeting),
  },
});
