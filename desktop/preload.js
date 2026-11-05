const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  store: {
    get: (keys) => ipcRenderer.invoke('store:get', keys),
    set: (values) => ipcRenderer.invoke('store:set', values),
    remove: (keys) => ipcRenderer.invoke('store:remove', keys),
    clear: () => ipcRenderer.invoke('store:clear'),
    onChanged: (listener) => ipcRenderer.on('store:changed', (_event, changes) => listener(changes)),
  },
});
