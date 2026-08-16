'use strict'

/**
 * The macOS application menu. The 「更新」 menu is the product's upgrade
 * surface: the unified update-manager panel, check-all, update-all, the
 * harness-only pipeline, and the service log viewer.
 */

const { Menu } = require('electron')

function buildMenu({ actions, getStatus, getSettings, isBusy, getUpdateSummary }) {
  const status = getStatus()
  const settings = getSettings()
  const summary = getUpdateSummary ? getUpdateSummary() : { availableCount: 0 }
  const available = summary.availableCount > 0
  const template = [
    {
      label: 'DeepSeek Harness',
      submenu: [
        { label: '关于 DeepSeek Harness', click: () => actions.showAbout() },
        { type: 'separator' },
        { label: '连接设置…', accelerator: 'CmdOrCtrl+,', click: () => actions.openSettings() },
        { type: 'separator' },
        { label: '新建窗口', accelerator: 'CmdOrCtrl+N', click: () => actions.newWindow() },
        { label: '打开 DeepSeek Harness', accelerator: 'CmdOrCtrl+O', click: () => actions.openMain() },
        { type: 'separator' },
        { role: 'quit', label: '退出 DeepSeek Harness' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '更新',
      submenu: [
        {
          label: available
            ? `有 ${summary.availableCount} 个更新可用`
            : summary.lastCheckAt ? '所有组件均为最新' : '尚未检查更新',
          enabled: false,
        },
        { type: 'separator' },
        { label: '更新管理…', accelerator: 'CmdOrCtrl+U', click: () => actions.openUpdates() },
        { label: '检查更新…', enabled: !isBusy(), click: () => actions.checkUpdates() },
        { label: '更新全部并重启…', enabled: !isBusy() && available, click: () => actions.updateAll() },
        { label: '仅更新 Harness…', enabled: !isBusy(), click: () => actions.updateAndRestart() },
        { type: 'separator' },
        { label: '打开服务日志…', click: () => actions.openLogs() },
      ],
    },
    {
      label: '连接',
      submenu: [
        { label: `模式：${settings.mode === 'ssh' ? 'SSH 远程' : '本地'}`, enabled: false },
        { label: `地址：${status.url || '—'}`, enabled: false },
        { label: `状态：${status.detail}`, enabled: false },
        { type: 'separator' },
        { label: '重新连接', click: () => actions.reconnect() },
      ],
    },
    { role: 'windowMenu', label: '窗口' },
    {
      label: '帮助',
      role: 'help',
      submenu: [
        { label: '项目主页（GitHub）', click: () => actions.openGitHub() },
        { label: '打开开发者工具', click: () => actions.openDevTools() },
      ],
    },
  ]
  return Menu.buildFromTemplate(template)
}

module.exports = { buildMenu }
