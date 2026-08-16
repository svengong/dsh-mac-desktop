'use strict'

/**
 * Dialog windows: the streaming progress/update log remains an independent
 * macOS window, while the unified settings panel (connection + update
 * manager + advanced) is now an embedded WebContentsView inside each
 * workspace window. The workspace frame (`ui/shell.html`) switches between
 * the harness view and the settings sections; the panel itself exposes only
 * the same narrow contextBridge API as before.
 */

const path = require('node:path')
const { BrowserWindow, WebContentsView, dialog } = require('electron')

const PRELOAD = path.join(__dirname, 'dialog-preload.js')
const SETTINGS_HTML = path.join(__dirname, 'ui', 'settings.html')
const PROGRESS_HTML = path.join(__dirname, 'ui', 'progress.html')

function dialogWindow(file, { width, height, query, macStyle = false }) {
  const win = new BrowserWindow({
    width,
    height,
    minWidth: macStyle ? 840 : undefined,
    minHeight: macStyle ? 620 : undefined,
    resizable: macStyle,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,

    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => win.show())
  if (query) win.loadFile(file, { query })
  else win.loadFile(file)
  return win
}

/**
 * The embedded settings panel for one workspace. The owner is the workspace
 * BrowserWindow; the view is hidden when the harness is front-most and kept
 * alive while the settings panel is open so section switches keep their state.
 */
class SetupDialog {
  constructor(ownerWindow) {
    this.ownerWindow = ownerWindow
    this.view = null
    this.activeSection = 'connection'
    this.deviceKey = null
    this.bounds = null
  }

  get webContents() {
    return this.view === null ? null : this.view.webContents
  }

  /**
   * Bind the panel to one device key. When the workspace switches devices,
   * the kept-alive panel is reloaded so it can never show stale forms from
   * the previous terminal.
   */
  setDeviceKey(deviceKey, section = 'connection') {
    this.activeSection = ['connection', 'updates', 'advanced'].includes(section) ? section : 'connection'
    if (this.deviceKey === deviceKey) return
    this.deviceKey = deviceKey
    if (this.view !== null && !this.view.webContents.isDestroyed()) {
      this.view.webContents.loadFile(SETTINGS_HTML, {
        query: { section: this.activeSection, embedded: '1' },
      })
    }
  }

  ensureView(section = 'connection') {
    if (this.ownerWindow === null || this.ownerWindow.isDestroyed()) return null
    if (this.view !== null && !this.view.webContents.isDestroyed()) return this.view
    this.activeSection = section
    this.view = new WebContentsView({
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    this.ownerWindow.contentView.addChildView(this.view)
    // A freshly created View defaults to 0×0 bounds; the workspace has already
    // measured its layout, so apply the last known bounds immediately.
    if (this.bounds !== null) this.view.setBounds(this.bounds)
    this.view.setVisible(false)
    this.view.webContents.loadFile(SETTINGS_HTML, { query: { section, embedded: '1' } })
    return this.view
  }

  open(section = 'connection') {
    this.activeSection = ['connection', 'updates', 'advanced'].includes(section) ? section : 'connection'
    const view = this.ensureView(this.activeSection)
    if (view === null) return
    view.setVisible(true)
    this.showSection(this.activeSection)
    view.webContents.focus()
  }

  close() {
    if (this.view !== null && !this.view.webContents.isDestroyed()) {
      this.view.setVisible(false)
    }
  }

  showSection(section) {
    if (!['connection', 'updates', 'advanced'].includes(section)) return
    this.activeSection = section
    if (this.view !== null && !this.view.webContents.isDestroyed()) {
      this.view.webContents.send('dialog:section', section)
    }
  }

  setBounds(bounds) {
    this.bounds = bounds
    if (this.view !== null && !this.view.webContents.isDestroyed()) {
      this.view.setBounds(bounds)
    }
  }

  send(channel, payload) {
    if (this.view !== null && !this.view.webContents.isDestroyed()) {
      this.view.webContents.send(channel, payload)
    }
  }

  log(line) {
    this.send('updates:log', line)
  }

  state(payload) {
    this.send('updates:state', payload)
  }
}

class ProgressDialog {
  constructor() {
    this.win = null
    this.visible = false
  }

  open() {
    if (this.win !== null && !this.win.isDestroyed()) {
      this.win.show()
      this.win.focus()
      return
    }
    this.win = dialogWindow(PROGRESS_HTML, { width: 800, height: 700 })
    this.visible = true
    this.win.on('show', () => {
      this.visible = true
    })
    this.win.on('closed', () => {
      this.win = null
      this.visible = false
    })
  }

  close() {
    if (this.win !== null && !this.win.isDestroyed()) this.win.close()
  }

  send(channel, payload) {
    if (this.win !== null && !this.win.isDestroyed()) this.win.webContents.send(channel, payload)
  }

  log(line) {
    this.send('progress:log', line)
  }

  state(payload) {
    this.send('progress:state', payload)
  }
}

/**
 * Register the dialog IPC surface. `handlers` supplies the main-process
 * implementations; every handler returns only JSON-safe data.
 */
function registerDialogIpc(handlers) {
  const { ipcMain } = require('electron')
  ipcMain.handle('dialog:get-state', event => handlers.getState(event))
  ipcMain.handle('dialog:pick-directory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('dialog:test-ssh', (event, target) => handlers.testSsh(event, target))
  ipcMain.handle('dialog:save', (event, rawSettings) => handlers.save(event, rawSettings))
  ipcMain.handle('dialog:action', (event, name) => handlers.action(event, name))
  ipcMain.handle('dialog:close-panel', event => handlers.closePanel(event))
  ipcMain.handle('updates:get-state', event => handlers.updatesGetState(event))
  ipcMain.handle('updates:action', (event, name, payload) => handlers.updatesAction(event, name, payload))
}

module.exports = { SetupDialog, ProgressDialog, registerDialogIpc }
