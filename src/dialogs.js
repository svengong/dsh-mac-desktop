'use strict'

/**
 * Embedded settings panel (connection + update manager) as a WebContentsView
 * inside each workspace window. The workspace frame (`ui/shell.html`) switches
 * between the harness view and the settings sections; the panel exposes only
 * a narrow contextBridge API. Progress/update logs stream into the shell
 * frame's loading panel instead of a separate window.
 */

const path = require('node:path')
const { WebContentsView, dialog } = require('electron')

const PRELOAD = path.join(__dirname, 'dialog-preload.js')
const SETTINGS_HTML = path.join(__dirname, 'ui', 'settings.html')

/**
 * The embedded settings panel for one workspace. The owner is the workspace
 * BrowserWindow; the view is hidden when the harness is front-most and kept
 * alive while the settings panel is open so section switches keep their state.
 */
class SetupDialog {
  constructor(ownerWindow) {
    this.ownerWindow = ownerWindow
    this.view = null
    this.attached = false
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
    this.activeSection = ['connection', 'updates'].includes(section) ? section : 'connection'
    if (this.deviceKey === deviceKey) return
    this.deviceKey = deviceKey
    this.reload()
  }

  /**
   * Reload a panel that already exists. Used when another window changed the
   * shared settings for the same device: a kept-alive WebContentsView would
   * otherwise keep displaying (and later save) the stale form.
   */
  reload(section = this.activeSection) {
    this.activeSection = ['connection', 'updates'].includes(section) ? section : 'connection'
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
        // Same reason as the harness view: the settings panel must not be
        // throttled while its window is in the background.
        backgroundThrottling: false,
      },
    })
    // Do not addChildView here: open() is the single place that attaches the
    // panel to the window, so close() can detach it without a lingering
    // hidden view stacked above the harness. The view object and its
    // webContents stay alive for re-attach.
    if (this.bounds !== null) this.view.setBounds(this.bounds)
    this.view.setVisible(false)
    this.view.webContents.loadFile(SETTINGS_HTML, { query: { section, embedded: '1' } })
    return this.view
  }

  open(section = 'connection') {
    this.activeSection = ['connection', 'updates'].includes(section) ? section : 'connection'
    const view = this.ensureView(this.activeSection)
    if (view === null) return
    // Re-attach after a close() removed it; addChildView also brings the panel
    // back above the harness view so it captures clicks while open.
    if (!this.attached) {
      this.ownerWindow.contentView.addChildView(view)
      this.attached = true
    }
    if (this.bounds !== null) view.setBounds(this.bounds)
    view.setVisible(true)
    this.showSection(this.activeSection)
    view.webContents.focus()
  }

  close() {
    // When the owner window has been destroyed (e.g. the window's `closed`
    // event fired during quit), the contentView is gone and the view is torn
    // down with it — nothing to detach. Bail before touching either.
    if (this.ownerWindow === null || this.ownerWindow.isDestroyed()) {
      this.attached = false
      return
    }
    if (this.view !== null && !this.view.webContents.isDestroyed()) {
      this.view.setVisible(false)
      // Detach the panel from the content view, not just hide it: a hidden
      // WebContentsView stacked above the harness can still swallow the
      // harness's top-edge clicks on macOS, which surfaces as unresponsive
      // harness toolbar buttons after a terminal switch or with several
      // windows open. removeChildView keeps the view (and its webContents)
      // alive so open() can re-attach it without a reload.
      if (this.attached) {
        this.ownerWindow.contentView.removeChildView(this.view)
        this.attached = false
      }
    }
  }

  showSection(section) {
    if (!['connection', 'updates'].includes(section)) return
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
  ipcMain.handle('dialog:close-panel', event => handlers.closePanel(event))
  ipcMain.handle('updates:get-state', event => handlers.updatesGetState(event))
  ipcMain.handle('updates:get-log', event => handlers.updatesGetLog(event))
  ipcMain.handle('updates:action', (event, name, payload) => handlers.updatesAction(event, name, payload))
}

module.exports = { SetupDialog, registerDialogIpc }
