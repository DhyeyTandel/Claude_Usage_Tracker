import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Listeners for push updates from main process
  onUsageUpdate: (callback: (data: any) => void) => {
    const listener = (_event: any, data: any) => callback(data);
    ipcRenderer.on('usage-update', listener);
    return () => ipcRenderer.removeListener('usage-update', listener);
  },
  onTokensUpdate: (callback: (data: any) => void) => {
    const listener = (_event: any, data: any) => callback(data);
    ipcRenderer.on('tokens-update', listener);
    return () => ipcRenderer.removeListener('tokens-update', listener);
  },
  onSpendUpdate: (callback: (data: any) => void) => {
    const listener = (_event: any, data: any) => callback(data);
    ipcRenderer.on('spend-update', listener);
    return () => ipcRenderer.removeListener('spend-update', listener);
  },
  onConfigStatusUpdate: (callback: (data: any) => void) => {
    const listener = (_event: any, data: any) => callback(data);
    ipcRenderer.on('config-status-update', listener);
    return () => ipcRenderer.removeListener('config-status-update', listener);
  },

  // Invoke commands returning promises
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings: any) => ipcRenderer.invoke('save-settings', settings),
  removeApiKey: () => ipcRenderer.invoke('remove-api-key'),
  resetAllData: () => ipcRenderer.invoke('reset-all-data'),
  testConnection: () => ipcRenderer.invoke('test-connection'),
  testTelegram: () => ipcRenderer.invoke('test-telegram'),
  refreshAll: () => ipcRenderer.invoke('refresh-all'),

  // Direct send messages (one-way)
  closeSettings: () => ipcRenderer.send('close-settings')
});
