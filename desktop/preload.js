const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  store: {
    get: (keys) => ipcRenderer.invoke('store:get', keys),
    set: (values) => ipcRenderer.invoke('store:set', values),
    remove: (keys) => ipcRenderer.invoke('store:remove', keys),
    clear: () => ipcRenderer.invoke('store:clear'),
    onChanged: (listener) => ipcRenderer.on('store:changed', (_event, changes) => listener(changes)),
  },
  capture: {
    sources: () => ipcRenderer.invoke('capture:sources'),
    use: (id) => ipcRenderer.invoke('capture:use', id),
  },
  net: {
    chat: (args) => ipcRenderer.invoke('net:chat', args),
    test: (args) => ipcRenderer.invoke('net:test', args),
    stt: (args) => ipcRenderer.invoke('net:stt', args),
    probe: (url, key) => ipcRenderer.invoke('net:probe', url, key),
  },
});
