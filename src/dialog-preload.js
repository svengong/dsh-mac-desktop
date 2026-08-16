'use strict'

/**
 * Preload for the dialog windows only. Exposes one narrow, JSON-only API;
 * the main window loads the remote page with no preload at all. The updates
 * panel gets its own state/log channels beside the progress window's.
 */

const { contextBridge, ipcRenderer } = require('electron')

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('desktopDialog', {
  getState: () => ipcRenderer.invoke('dialog:get-state'),
  pickDirectory: () => ipcRenderer.invoke('dialog:pick-directory'),
  testSsh: target => ipcRenderer.invoke('dialog:test-ssh', target),
  save: settings => ipcRenderer.invoke('dialog:save', settings),

  updates: {
    getState: () => ipcRenderer.invoke('updates:get-state'),
    action: (name, payload) => ipcRenderer.invoke('updates:action', name, payload),
    onLog: callback => subscribe('updates:log', callback),
    onState: callback => subscribe('updates:state', callback),
  },
})
