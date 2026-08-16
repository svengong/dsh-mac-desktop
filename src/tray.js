'use strict'

/**
 * The menu-bar tray: a status anchor that works without the main window.
 * The icon is a template image (black + alpha), so macOS adapts it to the
 * light/dark menu bar automatically. Tooltip and context menu carry the
 * same `DSH-[终端]` prefix as the window title and application menu.
 */

const path = require('node:path')
const { Tray, Menu, nativeImage } = require('electron')
const { terminalLabel } = require('./labels')

function createTray({ actions, getStatus, getSettings, getUpdateSummary, isBusy }) {
  const iconPath = path.join(__dirname, '..', 'build', 'trayTemplate.png')
  const image = nativeImage.createFromPath(iconPath)
  image.setTemplateImage(true)
  const tray = new Tray(image)

  const update = (status, settings = null) => {
    const terminal = terminalLabel(settings)
    const summary = getUpdateSummary ? getUpdateSummary() : { availableCount: 0 }
    const busy = isBusy ? isBusy() : false
    const suffix = summary.availableCount > 0 ? ` · ${summary.availableCount} 个更新` : ''
    tray.setToolTip(`DSH-[${terminal}] — ${status.detail}${suffix}`)
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `终端：${terminal}`, enabled: false },
      { label: `状态：${status.detail}`, enabled: false },
      summary.availableCount > 0
        ? { label: `有 ${summary.availableCount} 个更新可用`, enabled: false }
        : { label: summary.lastCheckAt ? '所有组件均为最新' : '尚未检查更新', enabled: false },
      { type: 'separator' },
      { label: '打开 Harness', click: () => actions.openMain() },
      { label: '新建窗口', click: () => actions.newWindow() },
      { label: '更新管理…', click: () => actions.openUpdates() },
      { label: '检查更新…', enabled: !busy, click: () => actions.checkUpdates() },
      { label: '更新全部并重启…', enabled: !busy && summary.availableCount > 0, click: () => actions.updateAll() },
      { label: '仅更新 Harness…', enabled: !busy, click: () => actions.updateAndRestart() },
      { type: 'separator' },
      { label: '重置后端服务…', enabled: !busy, click: () => actions.resetBackend() },
      { label: '退出', click: () => actions.quit() },
    ]))
  }

  tray.on('click', () => actions.openMain())
  update(getStatus(), getSettings ? getSettings() : null)
  return { tray, update }
}

module.exports = { createTray }
