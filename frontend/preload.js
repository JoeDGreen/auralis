const { contextBridge, ipcRenderer } = require('electron')

// Preload is mostly empty right now, but it's good practice 
// for Context Isolation in Electron for security down the line.
contextBridge.exposeInMainWorld('electronAPI', {
  // Add backend hooks if we ever implement global shortcuts
})
