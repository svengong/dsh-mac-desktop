'use strict'

/**
 * Preload for the main window's local workspace frame (`ui/shell.html`).
 * The frame is deliberately tiny: it can navigate between the harness view
 * and the embedded settings sections, and it receives a JSON-only state
 * snapshot so it never needs direct access to the page or main process.
 */

const { contextBridge, ipcRenderer } = require('electron')

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('desktopShell', {
  navigate: view => ipcRenderer.invoke('shell:navigate', view),
  newWindow: () => ipcRenderer.invoke('shell:new-window'),
  action: (name, payload) => ipcRenderer.invoke('shell:action', name, payload),
  // Session log history replay: hydrates the loading panel when it first
  // appears, so a window opened (or switched back) mid-connect sees the
  // full story instead of starting from an empty console.
  getLogDump: () => ipcRenderer.invoke('shell:log-dump'),
  onState: callback => subscribe('shell:state', callback),
  onLog: callback => subscribe('shell:log', callback),
  onTheme: callback => subscribe('shell:theme', callback),
})
