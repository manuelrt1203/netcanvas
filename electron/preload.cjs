// Pont entre l'interface (page web) et l'application de bureau : seulement ces fonctions, rien d'autre de Node.
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel, fn) => {
  const handler = (_e, value) => fn(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('netcanvas', {
  openFile: () => ipcRenderer.invoke('open-file'),
  readFile: (path) => ipcRenderer.invoke('read-file', path),
  writeFile: (path, content) => ipcRenderer.invoke('write-file', path, content),
  saveFileAs: (suggested, content) => ipcRenderer.invoke('save-file-as', suggested, content),
  recentFiles: () => ipcRenderer.invoke('recent-files'),
  addRecent: (path) => ipcRenderer.invoke('add-recent', path),
  setDirty: (dirty) => ipcRenderer.send('set-dirty', dirty),
  closeNow: () => ipcRenderer.send('close-now'),
  ready: () => ipcRenderer.send('ready'),
  onMenu: (fn) => listen('menu', fn),
  onOpenPath: (fn) => listen('open-path', fn),
});
