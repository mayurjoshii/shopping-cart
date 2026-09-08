const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pinder', {
  openFolder: () => ipcRenderer.invoke('open-folder'),
  deleteFiles: (paths) => ipcRenderer.invoke('delete-files', paths),
  getFileInfo: (filePath) => ipcRenderer.invoke('get-file-info', filePath),
});
