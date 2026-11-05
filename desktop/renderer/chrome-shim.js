(() => {
  function createChromeShim({ store, handle }) {
    const messageListeners = [];
    const changeListeners = [];
    store.onChanged((changes) => {
      for (const listener of changeListeners) listener(changes, 'local');
    });
    return {
      tabCapture: {},
      permissions: { request: async () => true },
      storage: {
        local: {
          get: (keys) => store.get(keys),
          set: (values) => store.set(values),
          remove: (keys) => store.remove(keys),
          clear: () => store.clear(),
        },
        onChanged: { addListener: (listener) => changeListeners.push(listener) },
      },
      runtime: {
        sendMessage: async (msg) => handle(msg),
        onMessage: { addListener: (listener) => messageListeners.push(listener) },
        emit: (msg) => queueMicrotask(() => {
          for (const listener of messageListeners) {
            try {
              listener(msg);
            } catch (e) {
              console.error(e);
            }
          }
        }),
      },
    };
  }

  globalThis.createChromeShim = createChromeShim;
})();
