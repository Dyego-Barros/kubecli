const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kubecli', {
  write: (data) => ipcRenderer.send('terminal-input', data),
  resize: (size) => ipcRenderer.send('terminal-resize', size),
  chooseKubeconfig: () => ipcRenderer.invoke('choose-kubeconfig'),
  editKubeconfig: () => ipcRenderer.invoke('edit-kubeconfig'),
  getKubeconfig: () => ipcRenderer.invoke('get-kubeconfig'),
  onData: (callback) => ipcRenderer.on('terminal-data', (_event, data) => callback(data)),
  onConfig: (callback) => ipcRenderer.on('terminal-config', (_event, data) => callback(data)),
  onExit: (callback) => ipcRenderer.on('terminal-exit', (_event, code) => callback(code)),
  onResize: (callback) => ipcRenderer.on('terminal-resize', callback),
});
