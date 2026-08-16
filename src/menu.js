'use strict'

/**
 * The macOS application menu.
 *
 * Layout is deliberately app-first and terminal-aware:
 *
 *   DSH-[终端]             standard application menu (about/settings/windows/quit)
 *   编辑                    standard text roles (the web app needs paste etc.)
 *   连接 · [终端]           active device + live status + reconnect
 *   更新 · [终端]           upgrade surface for the active device only
 *   窗口                    standard macOS window list
 *   帮助                    project links + developer tools
 *
 * The active device prefix on the application/连接/更新 menus keeps two
 * windows on different terminals distinguishable from the menu bar.
 */

const { Menu } = require('electron')
const { terminalLabel } = require('./labels')

function buildMenu({ actions, getStatus, getSettings, isBusy, getUpdateSummary }) {
  const settings = getSettings() || { mode: 'local' }
  const status = getStatus()
  const summary = getUpdateSummary ? getUpdateSummary() : { availableCount: 0 }
  const terminal = terminalLabel(settings)
  const available = summary.availableCount > 0
  const updateHeadline = available
    ? `有 ${summary.availableCount} 个更新可用`
    : summary.lastCheckAt ? '所有组件均为最新' : '尚未检查更新'

  const template = [
    {
      label: `DSH-[${terminal}]`,
      submenu: [
        { label: '关于 DSH', click: () => actions.showAbout() },
        { type: 'separator' },
        { label: '连接设置…', accelerator: 'CmdOrCtrl+,', click: () => actions.openSettings() },
        { type: 'separator' },
        { label: '新建窗口', accelerator: 'CmdOrCtrl+N', click: () => actions.newWindow() },
        { label: '打开 Harness', accelerator: 'CmdOrCtrl+O', click: () => actions.openMain() },
        { type: 'separator' },
        { role: 'quit', label: '退出 DSH' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: `连接 · ${terminal}`,
      submenu: [
        { label: `终端：${terminal}`, enabled: false },
        { label: `地址：${status.url || '—'}`, enabled: false },
        { label: `状态：${status.detail}`, enabled: false },
        { type: 'separator' },
        { label: '重新连接', enabled: !isBusy(), click: () => actions.reconnect() },
        { label: '重置后端服务…', enabled: !isBusy(), click: () => actions.resetBackend() },
      ],
    },
    {
      label: `更新 · ${terminal}`,
      submenu: [
        { label: updateHeadline, enabled: false },
        { type: 'separator' },
        { label: '更新管理…', accelerator: 'CmdOrCtrl+U', click: () => actions.openUpdates() },
        { label: '检查更新…', enabled: !isBusy(), click: () => actions.checkUpdates() },
        { label: '更新全部并重启…', enabled: !isBusy() && available, click: () => actions.updateAll() },
        { label: '仅更新 Harness…', enabled: !isBusy(), click: () => actions.updateAndRestart() },
        { type: 'separator' },
        { label: '打开服务日志…', click: () => actions.openLogs() },
      ],
    },
    { role: 'windowMenu', label: '窗口' },
    {
      label: '帮助',
      role: 'help',
      submenu: [
        { label: '项目主页（GitHub）', click: () => actions.openGitHub() },
        { type: 'separator' },
        { label: '打开开发者工具', click: () => actions.openDevTools() },
      ],
    },
  ]
  return Menu.buildFromTemplate(template)
}

module.exports = { buildMenu }
