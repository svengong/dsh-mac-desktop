'use strict'

/**
 * Dialog windows: the unified macOS-style settings window (connection +
 * update manager + advanced) and the streaming progress/update log. All run
 * with context isolation and expose a narrow contextBridge API (see
 * dialog-preload.js); the main window gets no preload.
 */

const path = require('node:path')
const { BrowserWindow, dialog, nativeTheme } = require('electron')

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

/** The one settings window; `section` selects 连接 / 更新管理 / 高级. */
class SetupDialog {
  constructor() {
    this.win = null
  }

  open(section = 'connection') {
    if (this.win !== null && !this.win.isDestroyed()) {
      this.showSection(section)
      this.win.show()
      this.win.focus()
      return
    }
    this.win = dialogWindow(SETTINGS_HTML, {
      width: 980,
      height: 760,
      query: { section },
      macStyle: true,
    })
    this.win.on('closed', () => {
      this.win = null
    })
  }

  showSection(section) {
    if (this.win !== null && !this.win.isDestroyed()) {
      this.win.webContents.send('dialog:section', section)
    }
  }

  close() {
    if (this.win !== null && !this.win.isDestroyed()) this.win.close()
  }

  send(channel, payload) {
    if (this.win !== null && !this.win.isDestroyed()) this.win.webContents.send(channel, payload)
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
  ipcMain.handle('updates:get-state', event => handlers.updatesGetState(event))
  ipcMain.handle('updates:action', (event, name, payload) => handlers.updatesAction(event, name, payload))
}

module.exports = { SetupDialog, ProgressDialog, registerDialogIpc }
