'use strict'

/**
 * Preload for the settings panel and progress windows. Exposes one narrow,
 * JSON-only API; the harness view gets no preload at all, and the main
 * window's local frame uses `shell-preload.js`.
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
  closePanel: () => ipcRenderer.invoke('dialog:close-panel'),
  onSection: callback => subscribe('dialog:section', callback),

  updates: {
    getState: () => ipcRenderer.invoke('updates:get-state'),
    action: (name, payload) => ipcRenderer.invoke('updates:action', name, payload),
    onLog: callback => subscribe('updates:log', callback),
    onState: callback => subscribe('updates:state', callback),
  },
})
