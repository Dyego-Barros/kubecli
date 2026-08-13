const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kubecli', {
  write: (data, id = 'main') => ipcRenderer.send('terminal-input', { id, data }),
  resize: (size, id = 'main') => ipcRenderer.send('terminal-resize', { id, ...size }),
  createTerminal: (id, kubeconfig) => ipcRenderer.invoke('create-terminal', { id, kubeconfig }),
  closeTerminal: (id) => ipcRenderer.invoke('close-terminal', id),
  stop: (id = 'main') => ipcRenderer.send('terminal-stop', id),
  chooseKubeconfig: () => ipcRenderer.invoke('choose-kubeconfig'),
  editKubeconfig: () => ipcRenderer.invoke('edit-kubeconfig'),
  getKubeconfig: () => ipcRenderer.invoke('get-kubeconfig'),
  onData: (callback) => ipcRenderer.on('terminal-data', (_event, payload) => callback(payload.data, payload.id)),
  onConfig: (callback) => ipcRenderer.on('terminal-config', (_event, payload) => callback(payload, payload.id)),
  onExit: (callback) => ipcRenderer.on('terminal-exit', (_event, payload) => callback(payload.code, payload.id)),
  onResize: (callback) => ipcRenderer.on('terminal-resize', callback),
});
