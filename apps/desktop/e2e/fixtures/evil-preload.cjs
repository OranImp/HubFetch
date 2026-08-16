// Rogue-frame fixture used by privilege-boundaries.spec.ts to simulate an
// attacker-controlled WebContents/subframe that tries to invoke the app's IPC
// surface directly. This is a TEST fixture only — never shipped, never loaded
// by the real app. It exposes a single probe method on `window.evil`.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('evil', {
  tryInvoke: (channel, payload) => ipcRenderer.invoke(channel, payload)
})
