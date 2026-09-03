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

/** Suffix naming the dist-tag a version came from, empty for stable/latest. */
function channelSuffix(channel) {
  const value = typeof channel === 'string' ? channel : ''
  return value === '' || value === 'latest' ? '' : `（${value}）`
}

function createTray({ actions, getStatus, getSettings, getUpdateSummary, isBusy, isUpdating }) {
  const iconPath = path.join(__dirname, '..', 'build', 'trayTemplate.png')
  const image = nativeImage.createFromPath(iconPath)
  image.setTemplateImage(true)
  const tray = new Tray(image)

  const update = (status, settings = null) => {
    const terminal = settings !== null && settings.detached === true ? '待连接' : terminalLabel(settings)
    const summary = getUpdateSummary ? getUpdateSummary() : { availableCount: 0 }
    const busy = isBusy ? isBusy() : false
    const updating = isUpdating ? isUpdating() : false
    const suffix = summary.availableCount > 0 ? ` · ${summary.availableCount} 个更新` : ''
    tray.setToolTip(`DSH-[${terminal}] — ${status.detail}${suffix}`)
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `终端：${terminal}`, enabled: false },
      { label: `状态：${status.detail}`, enabled: false },
      summary.availableCount > 0
        ? { label: `有 ${summary.availableCount} 个更新可用`, enabled: false }
        : { label: summary.lastCheckAt ? `所有组件均为最新${channelSuffix(summary.channel)}` : '尚未检查更新', enabled: false },
      { type: 'separator' },
      { label: '打开 Harness', click: () => actions.openMain() },
      { label: '新建窗口', click: () => actions.newWindow() },
      { label: '设置…', click: () => actions.openUpdates() },
      { label: '检查更新…', enabled: !busy, click: () => actions.checkUpdates() },
      updating
        ? { label: '取消更新', click: () => actions.cancelUpdate() }
        : { label: '更新 Harness…', enabled: !busy, click: () => actions.updateAndRestart() },
      { label: '回滚 Harness…', enabled: !busy, click: () => actions.rollbackHarness() },
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
