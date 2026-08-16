'use strict'

/**
 * dsh-desktop-shell — main process.
 *
 * The shell owns exactly three stable contracts with the product:
 * the fixed URL `http://127.0.0.1:<port>`, the `apps/cli/lib/bin.js web`
 * server entry, and the repo's git/pnpm toolchain. Product upgrades never
 * change the shell: after an update it only reloads the same URL.
 *
 * Multi-window model (VS Code style):
 *
 * - one BrowserWindow is one workspace; new windows start on the local device
 * - each workspace points at one device session (`local`, or `ssh:<host>`)
 * - sessions are shared by windows targeting the same device, so two local
 *   windows are tabs over one local backend, while windows on different
 *   devices run independent tunnels/services
 * - connection settings and update-manager state are scoped to the active
 *   workspace; the menu/tray read the focused window's session
 */

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const {
  app, BrowserWindow, Menu, shell, dialog, clipboard, Notification, WebContentsView, ipcMain,
} = require('electron')

const {
  SettingsStore, normalizeSettings, deviceKeyOf, DEV_DEFAULT_DSH_HOME,
} = require('./settings')
const { terminalLabel } = require('./labels')
const { resolveTools } = require('./tools')
const { runCommand } = require('./runner')
const { sshCommandArgs, parseTarget, listSshHosts, isSshConfigAlias } = require('./ssh')
const { ConnectionManager } = require('./connection')
const { Updater } = require('./update')
const { UpdateManager } = require('./update-manager')
const { SetupDialog, ProgressDialog, registerDialogIpc } = require('./dialogs')
const { buildMenu } = require('./menu')
const { createTray } = require('./tray')
const { presentWindow } = require('./windows')

const BUILD_DIR = path.join(__dirname, '..', 'build')
const SHELL_VERSION = '0.1.0'
const DOCK_ICON = path.join(BUILD_DIR, 'icon.png')
const DOCK_ICON_PRESSED = path.join(BUILD_DIR, 'iconPressed.png')
const DOCK_PRESS_MS = 150
const SHELL_HTML = path.join(__dirname, 'ui', 'shell.html')
const SHELL_PRELOAD = path.join(__dirname, 'shell-preload.js')
const SHELL_FRAME_HEIGHT = 46

/**
 * Keep development launches from touching the packaged app's settings/logs.
 * `electron .` and `npm start` use `~/.dsh-desktop` as the Electron userData
 * directory (the same home the local service already uses for its own DSH
 * state), so a shell under development can never overwrite the installed
 * DeepSeek Harness app's `~/Library/Application Support/DeepSeek Harness`.
 * Packaged builds keep Electron's default unless DSH_DESKTOP_USER_DATA is set.
 */
function configureUserData() {
  const override = process.env.DSH_DESKTOP_USER_DATA
  if (typeof override === 'string' && override.trim() !== '') {
    const expanded = override.trim().startsWith('~/')
      ? path.join(os.homedir(), override.trim().slice(2))
      : override.trim()
    app.setPath('userData', expanded)
    return
  }
  if (!app.isPackaged) {
    app.setPath('userData', path.join(os.homedir(), DEV_DEFAULT_DSH_HOME.replace(/^~\//, '')))
  }
}

configureUserData()
app.setName('DeepSeek Harness')

let settingsStore = null
let settingsDocument = null
let trayController = null
let quitting = false
let sessionLogFile = ''
let nextWorkspaceId = 1
let dockPressTimer = null
const workspaces = new Map()
const sessions = new Map()

/**
 * Append one line to the session log file (one file per app launch, under
 * userData/logs). The progress window's 复制日志/显示日志文件 buttons read
 * this file, so nothing that happened is ever trapped in an uncopyable window.
 */
function logSink(line) {
  const stamped = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${line}`
  if (sessionLogFile !== '') {
    try {
      fs.appendFileSync(sessionLogFile, `${stamped}\n`)
    } catch {
      // Logging is best-effort; a full disk must not break the connection flow.
    }
  }
  return stamped
}

/**
 * Give the Dock icon a brief pressed look. macOS exposes no pressed-state
 * event or styling for a Dock tile, so the shell swaps to the dimmed
 * `iconPressed.png` variant for one short interval and then restores the
 * normal icon; Electron only reports activation after the click, which is the
 * closest available signal to a Dock mouse-down.
 */
function flashDockIconPress(dock = app.dock, delayMs = DOCK_PRESS_MS) {
  const setDockIcon = iconPath => {
    try {
      dock.setIcon(iconPath)
    } catch {
      // The dock icon is cosmetic; a missing variant must not break activation.
    }
  }
  if (dockPressTimer !== null) clearTimeout(dockPressTimer)
  setDockIcon(DOCK_ICON_PRESSED)
  dockPressTimer = setTimeout(() => {
    dockPressTimer = null
    setDockIcon(DOCK_ICON)
  }, delayMs)
}

// ── device settings / sessions ──────────────────────────────────────────────

/** Normalize the persisted clean document into an in-memory document. */
function cleanDocument(normalized) {
  return {
    activeDeviceId: normalized.activeDeviceId,
    devices: normalized.devices,
    toolPaths: normalized.toolPaths,
  }
}

/** Persist a clean document and update the in-memory copy. */
function persistDocument(document) {
  const saved = settingsStore.save(document)
  settingsDocument = cleanDocument(saved)
  return settingsDocument
}

/** The active-device settings view for one device key. */
function settingsViewFor(deviceKey) {
  return normalizeSettings({
    activeDeviceId: deviceKey,
    devices: settingsDocument.devices,
    toolPaths: settingsDocument.toolPaths,
  })
}

/** Store one full device document under its canonical key. */
function persistDevice(deviceKey, device) {
  return persistDocument({
    activeDeviceId: deviceKey,
    devices: { ...settingsDocument.devices, [deviceKey]: device },
    toolPaths: settingsDocument.toolPaths,
  })
}

/** Create or return the session that owns one device backend. */
function sessionFor(deviceKey) {
  const existing = sessions.get(deviceKey)
  if (existing !== undefined) return existing
  const getSettings = () => settingsViewFor(deviceKey)
  const session = {
    key: deviceKey,
    connection: null,
    updater: null,
    updateManager: null,
    windows: new Set(),
    autoCheckTimer: null,
    autoReconnectTimer: null,
    autoReconnectAttempts: 0,
    connecting: false,
  }
  session.connection = new ConnectionManager({
    getSettings,
    onLog: line => routeSessionLine(session, line),
  })
  session.updater = new Updater({
    getSettings,
    connection: session.connection,
    onLine: line => routeSessionLine(session, line),
    onBusyChange: () => refreshTrayAndMenu(),
  })
  session.updateManager = new UpdateManager({
    getSettings,
    saveUpdate: patch => saveUpdateForSession(session, patch),
    connection: session.connection,
    harnessUpdater: session.updater,
    onLog: line => routeSessionLine(session, line),
    onState: () => broadcastSession(session),
  })
  session.connection.on('status', status => onSessionStatus(session, status))
  session.connection.on('connect-failed', error => onSessionConnectFailed(session, error))
  sessions.set(deviceKey, session)
  return session
}

/** Stop a session and forget it (local sessions stay alive for future tabs). */
function stopSession(session) {
  if (session === undefined || session === null) return
  clearTimeout(session.autoCheckTimer)
  clearTimeout(session.autoReconnectTimer)
  session.autoCheckTimer = null
  session.autoReconnectTimer = null
  session.connection.stop()
  if (session.key !== 'local') sessions.delete(session.key)
}

/** Send one session line to the file and to every open panel of its windows. */
function routeSessionLine(session, line) {
  logSink(`[${session.key}] ${line}`)
  for (const workspace of session.windows) {
    workspace.progressDialog.log(line)
    workspace.setupDialog.log(line)
  }
}

/** Persist a partial `update` patch for one device session. */
function saveUpdateForSession(session, patch) {
  const device = settingsDocument.devices[session.key]
  if (device === undefined) return settingsViewFor(session.key)
  const nextDevice = {
    ...device,
    update: { ...device.update, ...patch },
  }
  persistDevice(session.key, nextDevice)
  const view = settingsViewFor(session.key)
  session.updateManager.settings = view
  session.updateManager.reloadComponents()
  broadcastSession(session)
  return view
}

// ── workspaces / windows ─────────────────────────────────────────────────────

function workspaceViewBounds(win) {
  const [width, height] = win.getContentSize()
  return {
    x: 0,
    y: SHELL_FRAME_HEIGHT,
    width,
    height: Math.max(0, height - SHELL_FRAME_HEIGHT),
  }
}

/** Keep the harness and embedded settings views exactly under the shell frame. */
function layoutWorkspaceViews(workspace) {
  const win = workspace.window
  if (win === null || win.isDestroyed()) return
  const bounds = workspaceViewBounds(win)
  workspace.harnessView.setBounds(bounds)
  workspace.setupDialog.setBounds(bounds)
}

function workspaceTerminal(workspace) {
  return terminalLabel(settingsViewFor(workspace.deviceKey))
}

function workspaceTitle(workspace) {
  const url = workspace.session.connection.url()
  return `DSH-[${workspaceTerminal(workspace)}]-${url}`
}

function sendWorkspaceState(workspace) {
  if (workspace.window === null || workspace.window.isDestroyed()) return
  workspace.window.webContents.send('shell:state', {
    view: workspace.activeView,
    terminal: workspaceTerminal(workspace),
    status: workspace.session.connection.status.detail,
  })
}

/**
 * Show one top-level workspace view. `view` is `harness` or one of the
 * settings sections (`connection` / `updates` / `advanced`). This is the
 * single switch used by the shell frame, menus, tray, and save flows.
 */
function setWorkspaceView(workspace, view) {
  if (!['harness', 'connection', 'updates', 'advanced'].includes(view)) view = 'harness'
  workspace.activeView = view
  if (view === 'harness') {
    workspace.setupDialog.close()
    workspace.harnessView.setVisible(true)
    workspace.harnessView.webContents.focus()
  } else {
    workspace.harnessView.setVisible(false)
    workspace.setupDialog.setDeviceKey(workspace.deviceKey, view)
    workspace.setupDialog.open(view)
    // The settings view is created lazily on first use, so it has missed
    // the window's initial resize/layout pass. Give it the frame-aware
    // bounds now; otherwise it keeps WebContentsView's default 0x0 and
    // renders as a white panel.
    layoutWorkspaceViews(workspace)
  }
  sendWorkspaceState(workspace)
  refreshTrayAndMenu()
}

function createBrowserWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'DSH',
    icon: path.join(BUILD_DIR, 'icon.png'),
    show: false,
    // The shell frame is the window's only titlebar: hidden native title,
    // native traffic lights on top of the macOS-style toolbar.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 15 },
    webPreferences: {
      preload: SHELL_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  // The shell owns the title: it shows `DSH-[终端]-地址`, not the page title.
  win.on('page-title-updated', event => event.preventDefault())
  win.loadFile(SHELL_HTML)
  return win
}

function activeWorkspace() {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused !== null && !focused.isDestroyed()) {
    for (const workspace of workspaces.values()) {
      if (workspace.window === focused) return workspace
    }
  }
  for (const workspace of workspaces.values()) {
    if (workspace.window !== null && !workspace.window.isDestroyed() && workspace.window.isVisible()) {
      return workspace
    }
  }
  return workspaces.values().next().value ?? null
}

/** Resolve the workspace that owns an IPC sender (frame, settings, or progress). */
function workspaceForEvent(event) {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win !== null && !win.isDestroyed()) {
    for (const workspace of workspaces.values()) {
      if (workspace.window === win) return workspace
      if (workspace.progressDialog.win === win) return workspace
    }
  }
  // WebContentsView senders can resolve to the owner window as well; keep an
  // explicit fallback so embedded-settings IPC never falls through to focus.
  for (const workspace of workspaces.values()) {
    if (workspace.setupDialog.webContents === event.sender) return workspace
  }
  return activeWorkspace()
}

/** Return `workspace`, or the focused workspace, or a fresh local window. */
function withWorkspace(workspace) {
  return workspace ?? activeWorkspace() ?? createWorkspace('local')
}

function loadAppUrl(workspace) {
  const session = workspace.session
  const url = session.connection.url()
  workspace.harnessView.webContents.loadURL(url)
  workspace.window.setTitle(workspaceTitle(workspace))
  setWorkspaceView(workspace, 'harness')
  presentWindow(workspace.window)
}

function connectSession(session) {
  if (session.connecting) return
  session.connecting = true
  Promise.resolve(session.connection.connect()).then(
    () => { session.connecting = false },
    () => { session.connecting = false },
  )
}

function openWorkspaceWindow(workspace) {
  const session = workspace.session
  if (session.connection.status.state === 'ready') {
    workspace.pendingOpen = false
    loadAppUrl(workspace)
    return
  }
  workspace.pendingOpen = true
  connectSession(session)
}

function createWorkspace(deviceKey = 'local') {
  const session = sessionFor(deviceKey)
  const win = createBrowserWindow()
  const harnessView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.contentView.addChildView(harnessView)
  harnessView.setVisible(false)
  // The remote page never owns the window title.
  harnessView.webContents.on('page-title-updated', event => event.preventDefault())
  harnessView.webContents.loadURL('about:blank')

  const workspace = {
    id: nextWorkspaceId,
    deviceKey,
    session,
    window: win,
    harnessView,
    setupDialog: new SetupDialog(win),
    progressDialog: new ProgressDialog(),
    pendingOpen: true,
    lastProgressAction: '',
    activeView: 'harness',
  }
  nextWorkspaceId += 1
  workspaces.set(workspace.id, workspace)
  session.windows.add(workspace)
  win.setTitle(workspaceTitle(workspace))

  win.once('ready-to-show', () => {
    layoutWorkspaceViews(workspace)
    sendWorkspaceState(workspace)
    win.show()
    openWorkspaceWindow(workspace)
  })
  win.on('resize', () => layoutWorkspaceViews(workspace))
  win.on('focus', () => refreshTrayAndMenu())
  win.on('close', event => {
    if (!quitting) {
      event.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => disposeWorkspace(workspace))
  win.webContents.on('did-fail-load', (_event, code, description) => {
    session.connection.log(`[窗口] 框架加载失败 ${code} ${description}`)
  })
  harnessView.webContents.on('did-fail-load', (_event, code, description) => {
    session.connection.log(`[窗口] 加载失败 ${code} ${description}`)
  })

  return workspace
}

function disposeWorkspace(workspace) {
  const session = workspace.session
  session.windows.delete(workspace)
  workspace.setupDialog.close()
  workspace.progressDialog.close()
  for (const view of [workspace.harnessView, workspace.setupDialog.view]) {
    if (view !== null && view !== undefined && !view.webContents.isDestroyed()) {
      try {
        view.webContents.close()
      } catch {
        // Window teardown already owns this webContents.
      }
    }
  }
  workspace.window = null
  workspaces.delete(workspace.id)
  if (session.windows.size === 0 && session.key !== 'local') stopSession(session)
  refreshTrayAndMenu()
}

/** Move a workspace to another device session. */
function attachWorkspace(workspace, deviceKey) {
  if (workspace.deviceKey === deviceKey) return workspace.session
  const previous = workspace.session
  previous.windows.delete(workspace)
  if (previous.windows.size === 0 && previous.key !== 'local') stopSession(previous)

  const session = sessionFor(deviceKey)
  workspace.deviceKey = deviceKey
  workspace.session = session
  workspace.pendingOpen = true
  session.windows.add(workspace)
  // Never let a stale device's page flash while the new backend is connecting.
  workspace.harnessView.webContents.loadURL('about:blank')
  if (workspace.window !== null && !workspace.window.isDestroyed()) {
    workspace.window.setTitle(workspaceTitle(workspace))
    sendWorkspaceState(workspace)
  }
  return session
}

/** Reload every window attached to one session after its service restarts. */
function reloadSessionWindows(session) {
  for (const workspace of session.windows) {
    if (workspace.window !== null && !workspace.window.isDestroyed()) {
      workspace.harnessView.webContents.reloadIgnoringCache()
    }
  }
}

// ── menu / tray ──────────────────────────────────────────────────────────────

function activeSession() {
  const workspace = activeWorkspace()
  return workspace === null ? null : workspace.session
}

function idleStatus() {
  return { state: 'idle', mode: 'local', url: '', detail: '未连接', serviceOwner: 'none' }
}

function activeStatus() {
  const session = activeSession()
  return session === null ? idleStatus() : session.connection.status
}

function activeSettingsView() {
  const workspace = activeWorkspace()
  return workspace === null ? settingsViewFor('local') : settingsViewFor(workspace.deviceKey)
}

function activeUpdateSummary() {
  const session = activeSession()
  if (session === null) return { availableCount: 0, lastCheckAt: '' }
  const view = settingsViewFor(session.key)
  return {
    availableCount: session.updateManager.snapshot().available.length,
    lastCheckAt: view.update?.lastCheckAt ?? '',
  }
}

/** The first session currently running a build/update task, if any. */
function busySession() {
  for (const session of sessions.values()) {
    if (session.updater !== null && session.updater.busy) return session
    if (session.updateManager !== null && session.updateManager.busy) return session
  }
  return null
}

function refreshMenu() {
  const workspace = activeWorkspace()
  const session = workspace === null ? null : workspace.session
  Menu.setApplicationMenu(buildMenu({
    actions,
    getStatus: () => session === null ? idleStatus() : session.connection.status,
    getSettings: () => activeSettingsView(),
    isBusy: () => busySession() !== null,
    getUpdateSummary: () => activeUpdateSummary(),
  }))
}

function refreshTrayAndMenu() {
  if (trayController !== null) trayController.update(activeStatus(), activeSettingsView())
  refreshMenu()
}

/** Broadcast one session snapshot to its windows and the shared menu/tray. */
function broadcastSession(session) {
  if (session.updateManager === null) return
  const snapshot = session.updateManager.snapshot()
  for (const workspace of session.windows) {
    workspace.setupDialog.state(snapshot)
    sendWorkspaceState(workspace)
  }
  refreshTrayAndMenu()
}

// ── connection / update lifecycle helpers ───────────────────────────────────

function onSessionStatus(session, status) {
  for (const workspace of session.windows) {
    if (workspace.window === null || workspace.window.isDestroyed()) continue
    workspace.window.setTitle(workspaceTitle(workspace))
    sendWorkspaceState(workspace)
    if (status.state === 'ready' && workspace.pendingOpen) {
      workspace.pendingOpen = false
      loadAppUrl(workspace)
    }
  }
  if (status.state === 'ready') {
    clearTimeout(session.autoReconnectTimer)
    session.autoReconnectTimer = null
    session.autoReconnectAttempts = 0
    scheduleAutoCheck(session)
  }
  refreshTrayAndMenu()
}

function onSessionConnectFailed(session, error) {
  session.autoReconnectAttempts += 1
  if (session.autoReconnectAttempts <= 2) {
    const delay = session.autoReconnectAttempts * 10_000
    session.connection.log(`连接失败，${delay / 1000} 秒后自动重试（第 ${session.autoReconnectAttempts}/2 次）…`)
    clearTimeout(session.autoReconnectTimer)
    session.autoReconnectTimer = setTimeout(() => {
      session.autoReconnectTimer = null
      // The session may have been stopped while the timer was pending (e.g.
      // the last window switched to another device); never resurrect an
      // unowned SSH session from a stale reconnect timer.
      if (sessions.get(session.key) !== session) return
      if (session.windows.size === 0 && session.key !== 'local') return
      if (session.connection.status.state === 'error') connectSession(session)
    }, delay)
    return
  }
  dialog.showErrorBox('连接失败', String(error.message || error))
}

/** Present available updates as a macOS notification (falls back to a dialog). */
function notifyUpdatesAvailable(session, available) {
  const lines = available.map(row => `· ${row.title}：${row.summary}`).join('\n')
  const title = `DSH-[${terminalLabel(settingsViewFor(session.key))}]-${available.length} 个更新可用`
  const target = session.windows.values().next().value ?? activeWorkspace()
  const open = () => {
    if (target !== undefined && target !== null) {
      setWorkspaceView(target, 'updates')
      presentWindow(target.window)
      broadcastSession(session)
    }
  }
  if (Notification.isSupported()) {
    const notification = new Notification({ title, body: lines })
    notification.on('click', open)
    notification.show()
    return
  }
  dialog.showMessageBox({
    type: 'info',
    title: '发现更新',
    message: title,
    detail: lines,
    buttons: ['打开更新管理', '稍后'],
    defaultId: 0,
  }).then(result => {
    if (result.response === 0) open()
  })
}

/** One startup auto-check after a session reaches `ready`. */
function scheduleAutoCheck(session) {
  clearTimeout(session.autoCheckTimer)
  session.autoCheckTimer = null
  const view = settingsViewFor(session.key)
  if (view.update?.autoCheckOnLaunch === false) return
  session.autoCheckTimer = setTimeout(async () => {
    session.autoCheckTimer = null
    if (session.connection.status.state !== 'ready') return
    try {
      await session.updateManager.checkAll()
      const key = session.updateManager.notificationKey()
      const available = session.updateManager.snapshot().available
      if (key !== '' && key !== view.update.lastNotifiedKey) {
        saveUpdateForSession(session, { lastNotifiedKey: key })
        notifyUpdatesAvailable(session, available)
      }
    } catch (error) {
      routeSessionLine(session, `✗ 启动自动检查失败：${String(error.message || error)}`)
    }
  }, 2500)
}

/** Shared tail for panel-driven component updates. */
async function finishManagedUpdate(workspace, outcome) {
  if (outcome.ok && outcome.restarted) reloadSessionWindows(workspace.session)
  broadcastSession(workspace.session)
}

function validateSettings(next) {
  if (next.mode === 'local') {
    if (next.local.repoDir === '') return '请填写仓库目录'
    if (!fs.existsSync(next.local.repoDir) && next.local.repoUrl === '') {
      return `仓库目录不存在：${next.local.repoDir}\n\n可填写「仓库地址」（git URL）让壳自动克隆，或改为已有的检出目录。`
    }
    return null
  }
  if (next.ssh.host === '') return '请选择 SSH 主机'
  if (!isSshConfigAlias(next.ssh.host) && parseTarget(next.ssh.host) === null) {
    return `SSH 主机无效（应为 ~/.ssh/config 别名或 user@host[:port]）：${next.ssh.host}`
  }
  return null
}

/** Run the initialization build when needed, then connect one workspace. */
async function startWithSettings(workspace) {
  const session = workspace.session
  let built = false
  try {
    built = await session.connection.isBuilt()
  } catch (error) {
    // The build check needs connectivity (ssh test for remote mode). When it
    // cannot even reach the host, connect() surfaces the real failure with a
    // proper dialog instead of a pointless build pipeline.
    session.connection.log(`构建检查失败：${error.message}`)
    setWorkspaceView(workspace, 'harness')
    workspace.pendingOpen = true
    connectSession(session)
    return
  }
  if (!built) {
    const busyMessage = busyTaskMessage()
    if (busyMessage !== '') {
      workspace.lastProgressAction = 'init'
      setWorkspaceView(workspace, 'harness')
      workspace.progressDialog.open()
      workspace.progressDialog.state({
        title: '初始化构建',
        status: `${busyMessage} 稍后请从「更新 → 更新并重启」重试。`,
        actions: [{ label: '关闭', name: 'close' }],
      })
      return
    }
    workspace.lastProgressAction = 'init'
    setWorkspaceView(workspace, 'harness')
    workspace.progressDialog.open()
    workspace.progressDialog.state({
      title: '初始化构建',
      status: '首次使用：确保仓库 → 工具链引导 → pnpm install → pnpm run build → 启动服务',
      actions: [{ label: '关闭', name: 'close' }],
    })
    const outcome = await session.updater.runPipeline({ includePull: true, toleratePullFailure: true })
    if (!outcome.ok) {
      workspace.progressDialog.state({
        title: '初始化构建',
        status: '构建失败。可修复后重试（日志已写入文件，可用「复制日志」）。',
        actions: [{ label: '重试', name: 'run-init', primary: true }, { label: '关闭', name: 'close' }],
      })
      return
    }
    workspace.progressDialog.close()
  }
  setWorkspaceView(workspace, 'harness')
  workspace.pendingOpen = true
  connectSession(session)
}

async function runInit(workspace) {
  const session = workspace.session
  if (!canStartBusyTask()) return
  const outcome = await session.updater.runPipeline({ includePull: true, toleratePullFailure: true })
  if (outcome.ok) {
    workspace.progressDialog.close()
    setWorkspaceView(workspace, 'harness')
    workspace.pendingOpen = true
    connectSession(session)
  } else {
    workspace.progressDialog.state({
      title: '初始化构建',
      status: '构建失败。可修复后重试（日志已写入文件，可用「复制日志」）。',
      actions: [{ label: '重试', name: 'run-init', primary: true }, { label: '关闭', name: 'close' }],
    })
  }
}

// ── user actions ────────────────────────────────────────────────────────────

/**
 * Build/update tasks are globally serialized: multi-window makes it easy for
 * a background session to still be running pnpm install/build while the
 * focused window tries to start another one. Two pipelines can contend for
 * CPU, ports, and the same repo checkout.
 */
function busyTaskMessage() {
  const busy = busySession()
  if (busy === null) return ''
  const terminal = terminalLabel(settingsViewFor(busy.key))
  return `${terminal} 正在构建或更新组件，请等待任务完成后再启动新的更新/构建。`
}

function canStartBusyTask() {
  const message = busyTaskMessage()
  if (message === '') return true
  dialog.showErrorBox('任务执行中', message)
  return false
}

const actions = {
  newWindow() {
    return createWorkspace('local')
  },

  openMain(workspace) {
    const target = withWorkspace(workspace)
    if (target.session.connection.status.state !== 'ready') {
      dialog.showErrorBox('尚未连接', `当前状态：${target.session.connection.status.detail}\n\n可在「连接 → 重新连接」或「连接设置」中处理。`)
      return target
    }
    loadAppUrl(target)
    return target
  },

  openSettings(workspace) {
    const target = withWorkspace(workspace)
    setWorkspaceView(target, 'connection')
    presentWindow(target.window)
    return target
  },

  openUpdates(workspace) {
    const target = withWorkspace(workspace)
    setWorkspaceView(target, 'updates')
    broadcastSession(target.session)
    presentWindow(target.window)
    return target
  },

  reconnect(workspace) {
    if (!canStartBusyTask()) return withWorkspace(workspace)
    const target = withWorkspace(workspace)
    target.session.autoReconnectAttempts = 0
    target.pendingOpen = true
    connectSession(target.session)
  },

  async resetBackend(workspace) {
    if (!canStartBusyTask()) return withWorkspace(workspace)
    const target = withWorkspace(workspace)
    try {
      await target.session.connection.resetService()
      target.pendingOpen = true
      target.session.autoReconnectAttempts = 0
      connectSession(target.session)
    } catch (error) {
      routeSessionLine(target.session, `✗ 重置后端服务失败：${String(error.message || error)}`)
      dialog.showErrorBox('重置后端服务失败', String(error.message || error))
    }
    return target
  },

  async checkUpdates(workspace) {
    if (!canStartBusyTask()) return withWorkspace(workspace)
    const target = actions.openUpdates(workspace)
    try {
      await target.session.updateManager.checkAll()
    } catch (error) {
      routeSessionLine(target.session, `✗ 检查更新失败：${String(error.message || error)}`)
    }
    broadcastSession(target.session)
  },

  async updateAll(workspace) {
    if (!canStartBusyTask()) return withWorkspace(workspace)
    const target = actions.openUpdates(workspace)
    routeSessionLine(target.session, '\n==> 更新全部组件')
    try {
      const outcome = await target.session.updateManager.updateAll()
      await finishManagedUpdate(target, outcome)
    } catch (error) {
      routeSessionLine(target.session, `✗ 更新全部失败：${String(error.message || error)}`)
      broadcastSession(target.session)
    }
  },

  async updateAndRestart(workspace) {
    if (!canStartBusyTask()) return withWorkspace(workspace)
    const target = withWorkspace(workspace)
    target.lastProgressAction = 'update'
    target.progressDialog.open()
    target.progressDialog.state({ title: '更新并重启', status: '执行中…', actions: [{ label: '关闭', name: 'close' }] })
    const outcome = await target.session.updater.runPipeline({ includePull: true })
    if (outcome.ok) {
      reloadSessionWindows(target.session)
      // Success needs no window: the log persists to the session file, the
      // main window refreshes on its own. Close after a brief moment.
      setTimeout(() => target.progressDialog.close(), 1200)
    } else {
      target.progressDialog.state({
        title: '更新并重启',
        status: '更新失败。可修复后重试（日志已写入文件，可用「复制日志」）。',
        actions: [{ label: '重试', name: 'run-update', primary: true }, { label: '关闭', name: 'close' }],
      })
    }
    refreshMenu()
  },

  async openLogs(workspace) {
    const target = withWorkspace(workspace)
    const session = target.session
    const view = settingsViewFor(session.key)
    target.progressDialog.open()
    target.progressDialog.state({ title: '服务日志', status: '最近输出…', actions: [{ label: '关闭', name: 'close' }] })
    for (const line of session.connection.dumpLog().split('\n')) target.progressDialog.log(line)
    if (view.mode === 'ssh') {
      const remote = await session.connection.remoteRun(
        view.ssh.host,
        'tail -n 100 "$HOME"/.dsh/desktop-web.log 2>/dev/null || echo "(远程日志为空或不存在)"',
        { timeoutMs: 15_000 },
      )
      target.progressDialog.log('\n── 远程 ~/.dsh/desktop-web.log ──')
      for (const line of remote.lines) target.progressDialog.log(line)
      logSink('\n── 远程 ~/.dsh/desktop-web.log ──')
      for (const line of remote.lines) logSink(line)
    }
  },

  showAbout() {
    app.setAboutPanelOptions({
      applicationName: 'DSH 桌面壳',
      applicationVersion: `桌面壳 ${SHELL_VERSION}`,
      credits: 'DSH 桌面壳只加载 http://127.0.0.1:<端口> 的 DeepSeek Harness Web 服务；产品升级不需要改动壳。',
    })
    app.showAboutPanel()
  },

  openGitHub() {
    shell.openExternal('https://github.com/deepseek-ai/deepseek-harness')
  },

  openDevTools(workspace) {
    const target = withWorkspace(workspace)
    if (target.window !== null && !target.window.isDestroyed()) {
      target.harnessView.webContents.openDevTools({ mode: 'detach' })
    }
  },

  quit() {
    // A build/update child is in the shell's process group. Letting the app
    // quit now would tear down `pnpm run build` mid-flight and leave the repo
    // half-built (the exact failure mode in the 2026-08-16 build log).
    const busy = busySession()
    if (busy !== null) {
      const workspace = busy.windows.values().next().value ?? activeWorkspace()
      if (workspace !== null && workspace !== undefined) {
        workspace.progressDialog.open()
        workspace.progressDialog.state({
          title: '任务执行中，暂不能退出',
          status: '正在构建或更新组件。请等待任务完成后再退出；进度窗口关闭不会中断任务。',
          actions: [{ label: '关闭', name: 'close' }],
        })
      }
      dialog.showErrorBox('任务执行中', '正在构建或更新组件，退出会中断构建并可能留下半成品。请等待完成后再退出。')
      return
    }
    quitting = true
    app.quit()
  },
}

// ── dialog IPC handlers ─────────────────────────────────────────────────────

function registerIpc() {
  registerDialogIpc({
    getState(event) {
      const workspace = workspaceForEvent(event) ?? withWorkspace(null)
      const view = settingsViewFor(workspace.deviceKey)
      const tools = resolveTools(view)
      return {
        settings: view,
        terminal: terminalLabel(view),
        sshHosts: listSshHosts(),
        live: {
          state: workspace.session.connection.status.state,
          url: workspace.session.connection.status.url,
          detail: workspace.session.connection.status.detail,
        },
        detected: {
          node: tools.node,
          git: tools.git,
          pnpm: tools.pnpm,
          ssh: tools.ssh,
        },
      }
    },

    async testSsh(event, target) {
      const workspace = workspaceForEvent(event) ?? withWorkspace(null)
      const tools = resolveTools(settingsViewFor(workspace.deviceKey))
      const result = await runCommand({
        cmd: tools.ssh,
        args: sshCommandArgs(target, 'echo dsh-ok'),
        timeoutMs: 15_000,
      })
      if (result.code === 0 && result.lines.includes('dsh-ok')) return { ok: true, message: '' }
      const message = result.lines.slice(-3).join('\n') || `退出码 ${result.code}`
      return { ok: false, message }
    },

    async save(event, rawSettings) {
      const workspace = workspaceForEvent(event) ?? withWorkspace(null)
      const busyMessage = busyTaskMessage()
      if (busyMessage !== '') return { ok: false, error: busyMessage }
      const candidate = normalizeSettings(rawSettings)
      const error = validateSettings(candidate)
      if (error !== null) return { ok: false, error }
      // Connection saves never carry update settings from another device.
      // A newly selected target keeps its own update section (or starts
      // with the harness-only default), and switching back restores it.
      const deviceKey = deviceKeyOf(candidate)
      const previousUpdate = settingsDocument.devices[deviceKey]?.update
      const device = {
        mode: candidate.mode,
        local: candidate.local,
        ssh: candidate.ssh,
        update: previousUpdate ?? candidate.update,
      }
      persistDevice(deviceKey, device)
      settingsDocument = persistDocument({
        activeDeviceId: deviceKey,
        devices: settingsDocument.devices,
        toolPaths: candidate.toolPaths,
      })

      const session = attachWorkspace(workspace, deviceKey)
      const view = settingsViewFor(deviceKey)
      session.updateManager.settings = view
      session.updateManager.reloadComponents()
      broadcastSession(session)
      // Any other window attached to this device already has a kept-alive
      // settings view with the pre-save form; reload every panel so a
      // multi-window save can never be overwritten from a stale copy.
      for (const attached of session.windows) attached.setupDialog.reload()
      setWorkspaceView(workspace, 'harness')
      startWithSettings(workspace)
      return { ok: true }
    },

    async action(event, name) {
      const workspace = workspaceForEvent(event) ?? withWorkspace(null)
      switch (name) {
        case 'close':
          workspace.progressDialog.close()
          break
        case 'copy-log':
          if (sessionLogFile !== '' && fs.existsSync(sessionLogFile)) {
            clipboard.writeText(fs.readFileSync(sessionLogFile, 'utf8'))
          }
          break
        case 'reveal-log':
          if (sessionLogFile !== '' && fs.existsSync(sessionLogFile)) {
            shell.showItemInFolder(sessionLogFile)
          }
          break
        case 'run-update':
          workspace.progressDialog.state({ title: '更新并重启', status: '执行中…', actions: [{ label: '关闭', name: 'close' }] })
          void actions.updateAndRestart(workspace)
          break
        case 'run-init':
          workspace.progressDialog.state({ title: '初始化构建', status: '执行中…', actions: [{ label: '关闭', name: 'close' }] })
          void runInit(workspace)
          break
        default:
          return { ok: false, error: `未知动作：${name}` }
      }
      return { ok: true }
    },

    closePanel(event) {
      const workspace = workspaceForEvent(event) ?? withWorkspace(null)
      setWorkspaceView(workspace, 'harness')
      return { ok: true }
    },

    updatesGetState(event) {
      const workspace = workspaceForEvent(event) ?? withWorkspace(null)
      return workspace.session.updateManager.snapshot()
    },

    updatesGetLog(event) {
      const workspace = workspaceForEvent(event) ?? withWorkspace(null)
      // The panel is created lazily and may have missed every earlier line;
      // return the connection's bounded ring so the tab can show the latest
      // log immediately instead of starting with an empty console.
      return workspace.session.connection.dumpLog()
    },

    async updatesAction(event, name, payload = {}) {
      const workspace = workspaceForEvent(event) ?? withWorkspace(null)
      const session = workspace.session
      const taskNames = ['check-all', 'check-one', 'update-one', 'update-all']
      const busyMessage = busyTaskMessage()
      if (taskNames.includes(name) && busyMessage !== '') {
        return { ok: false, error: busyMessage }
      }
      try {
        switch (name) {
          case 'close':
            setWorkspaceView(workspace, 'harness')
            break
          case 'open-settings':
            setWorkspaceView(workspace, 'connection')
            break
          case 'toggle-auto':
            saveUpdateForSession(session, { autoCheckOnLaunch: Boolean(payload?.value) })
            break
          case 'save-sources':
            if (!Array.isArray(payload?.components)) {
              return { ok: false, error: 'components 必须为数组' }
            }
            saveUpdateForSession(session, { components: payload.components })
            break

          case 'copy-log':
            if (sessionLogFile !== '' && fs.existsSync(sessionLogFile)) {
              clipboard.writeText(fs.readFileSync(sessionLogFile, 'utf8'))
            }
            break
          case 'reveal-log':
            if (sessionLogFile !== '' && fs.existsSync(sessionLogFile)) {
              shell.showItemInFolder(sessionLogFile)
            }
            break
          case 'check-all':
            void session.updateManager.checkAll().then(
              () => broadcastSession(session),
              error => {
                routeSessionLine(session, `✗ 检查更新失败：${String(error.message || error)}`)
                broadcastSession(session)
              },
            )
            break
          case 'check-one': {
            const id = String(payload?.id ?? '')
            void session.updateManager.checkOne(id).then(
              () => broadcastSession(session),
              error => {
                routeSessionLine(session, `✗ 检查失败：${String(error.message || error)}`)
                broadcastSession(session)
              },
            )
            break
          }
          case 'update-one': {
            const id = String(payload?.id ?? '')
            void session.updateManager.updateOne(id).then(
              outcome => finishManagedUpdate(workspace, outcome),
              error => {
                routeSessionLine(session, `✗ 更新失败：${String(error.message || error)}`)
                broadcastSession(session)
              },
            )
            break
          }
          case 'update-all':
            void session.updateManager.updateAll().then(
              outcome => finishManagedUpdate(workspace, outcome),
              error => {
                routeSessionLine(session, `✗ 更新全部失败：${String(error.message || error)}`)
                broadcastSession(session)
              },
            )
            break
          default:
            return { ok: false, error: `未知动作：${name}` }
        }
        return { ok: true }
      } catch (error) {
        return { ok: false, error: String(error.message || error) }
      }
    },
  })

  ipcMain.handle('shell:navigate', (event, view) => {
    const workspace = workspaceForEvent(event) ?? withWorkspace(null)
    setWorkspaceView(workspace, view)
    return { ok: true }
  })
}

// ── smoke mode ──────────────────────────────────────────────────────────────

async function runSmoke() {
  const { parseTarget: parse, shellQuote, remotePath, tunnelArgs } = require('./ssh')
  const checks = []
  const check = async (name, fn) => {
    await fn()
    checks.push(name)
  }
  await check('settings normalize', () => {
    const s = normalizeSettings({ mode: 'ssh', ssh: { host: ' u@h:2222 ' } })
    if (s.mode !== 'ssh' || s.ssh.host !== 'u@h:2222') throw new Error('ssh normalize failed')
    const migrated = normalizeSettings({ mode: 'ssh', ssh: { target: 'legacy-host' } })
    if (migrated.ssh.host !== 'legacy-host') throw new Error('ssh target migration failed')
  })
  await check('dev userData isolation', () => {
    if (app.isPackaged) return
    const expected = path.join(os.homedir(), '.dsh-desktop')
    if (app.getPath('userData') !== expected) {
      throw new Error(`dev userData should be ${expected}, got ${app.getPath('userData')}`)
    }
  })
  await check('ssh parseTarget', () => {
    const p = parse('u@h:2222')
    if (p === null || p.user !== 'u' || p.host !== 'h' || p.port !== 2222) throw new Error('parse failed')
  })
  await check('ssh config parsing', () => {
    const fsx = require('node:fs')
    const osx = require('node:os')
    const pathx = require('node:path')
    const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'dsh-ssh-config-'))
    const config = pathx.join(dir, 'config')
    fsx.writeFileSync(config, [
      '# comment',
      'Host dev prod-a',
      '  HostName 10.0.0.8',
      '  User sven',
      '  Port 2222',
      '  ProxyJump jump',
      '',
      'Host *.wild',
      '  HostName example.com',
      'Include extra.conf',
      '',
    ].join('\n'))
    fsx.writeFileSync(pathx.join(dir, 'extra.conf'), 'Host extra\n  HostName 192.168.1.2\n')
    const { parseSshConfig, listSshHosts: listFor } = require('./ssh')
    const entries = parseSshConfig(config)
    if (entries.length !== 3) throw new Error(`expected 3 entries, got ${entries.length}`)
    const hosts = listFor(config)
    const dev = hosts.find(h => h.alias === 'dev')
    if (!dev || dev.detail !== 'sven@10.0.0.8:2222') throw new Error(`dev entry wrong: ${JSON.stringify(dev)}`)
    if (hosts.some(h => h.alias.includes('*'))) throw new Error('wildcard alias leaked into list')
    const extra = hosts.find(h => h.alias === 'extra')
    if (!extra || extra.detail !== '192.168.1.2') throw new Error('Include not followed')
    fsx.rmSync(dir, { recursive: true, force: true })
  })
  await check('ssh shellQuote', () => {
    if (shellQuote("a'b") !== `'a'\\''b'`) throw new Error('quote failed')
  })
  await check('ssh remotePath', () => {
    if (remotePath('~/x') !== '"$HOME"/\'x\'') throw new Error('remotePath failed')
  })
  await check('ssh tunnelArgs', () => {
    const args = tunnelArgs('u@h:22', 3080, 3081)
    if (!args.includes('3080:127.0.0.1:3081') || !args.includes('-N')) throw new Error('tunnel failed')
  })
  await check('runner echo', async () => {
    const result = await runCommand({ cmd: '/bin/echo', args: ['dsh-smoke'] })
    if (result.code !== 0 || result.lines[0] !== 'dsh-smoke') throw new Error('runner failed')
  })
  await check('dock icon press feedback', async () => {
    const calls = []
    flashDockIconPress({ setIcon: iconPath => calls.push(iconPath) }, 10)
    if (calls[0] !== DOCK_ICON_PRESSED) throw new Error(`pressed icon not set first: ${JSON.stringify(calls)}`)
    await new Promise(resolve => setTimeout(resolve, 30))
    if (calls[1] !== DOCK_ICON) throw new Error(`normal icon not restored: ${JSON.stringify(calls)}`)
  })

  await check('action surface complete', () => {
    for (const name of ['newWindow', 'openMain', 'openSettings', 'openUpdates', 'checkUpdates', 'updateAll', 'updateAndRestart', 'resetBackend', 'quit']) {
      if (typeof actions[name] !== 'function') throw new Error(`actions.${name} missing`)
    }
  })
  await check('menu has paste role and new window', () => {
    const menu = buildMenu({
      actions: {},
      getStatus: () => ({ state: 'idle', mode: 'local', url: '', detail: '' }),
      getSettings: () => ({ mode: 'local' }),
      isBusy: () => false,
      getUpdateSummary: () => ({ availableCount: 2 }),
    })
    const edit = menu.items.find(item => item.label === '编辑')
    if (!edit || !edit.submenu.items.some(item => item.role === 'paste')) {
      throw new Error('Edit menu must contain the paste role (Cmd+V)')
    }
    const appMenu = menu.items.find(item => item.label === 'DSH-[本地]')
    if (!appMenu || !appMenu.submenu.items.some(item => item.label === '新建窗口')) {
      throw new Error('App menu must contain 新建窗口')
    }
    const update = menu.items.find(item => item.label === '更新 · 本地')
    if (!update) throw new Error('Update menu missing')
    const labels = update.submenu.items.map(item => item.label)
    for (const label of ['更新管理…', '检查更新…', '更新全部并重启…', '仅更新 Harness…']) {
      if (!labels.includes(label)) throw new Error(`Update menu missing: ${label}`)
    }
    if (!labels.includes('有 2 个更新可用')) throw new Error('Update menu summary missing')
  })
  console.log(`DSH_DESKTOP_SMOKE ${JSON.stringify({ ok: true, checks })}`)
  app.exit(0)
}

// ── app lifecycle ───────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (settingsDocument === null) return
    const workspace = activeWorkspace() ?? createWorkspace('local')
    if (workspace.window !== null && !workspace.window.isDestroyed()) presentWindow(workspace.window)
  })

  app.whenReady().then(() => {
    if (process.env.DSH_DESKTOP_SMOKE === '1') {
      runSmoke()
      return
    }

    try {
      app.dock.setIcon(DOCK_ICON)
    } catch {
      // The dock icon is cosmetic; packaged builds use the icns anyway.
    }

    settingsStore = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'))
    settingsDocument = cleanDocument(settingsStore.load())

    const logsDir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(logsDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    sessionLogFile = path.join(logsDir, `desktop-${stamp}.log`)
    fs.writeFileSync(sessionLogFile, `DSH desktop shell — ${new Date().toLocaleString()}\n\n`)

    registerIpc()

    trayController = createTray({
      actions,
      getStatus: () => activeStatus(),
      getSettings: () => activeSettingsView(),
      getUpdateSummary: () => activeUpdateSummary(),
      isBusy: () => busySession() !== null,
    })

    try {
      app.dock.setMenu(Menu.buildFromTemplate([
        { label: '新建窗口', click: () => actions.newWindow() },
      ]))
    } catch {
      // Dock menu is macOS-only and cosmetic.
    }

    refreshTrayAndMenu()

    const first = createWorkspace(settingsDocument.activeDeviceId)
    const firstView = settingsViewFor(first.deviceKey)
    const complete = firstView.mode === 'local'
      ? firstView.local.repoDir !== ''
      : firstView.ssh.host !== ''
    if (complete) startWithSettings(first)
    else setWorkspaceView(first, 'connection')

    app.on('activate', (_event, hasVisibleWindows) => {
      flashDockIconPress()
      // macOS already fronts a visible window on dock activation; the shell
      // only needs to recover hidden/minimized windows or recreate one.
      if (hasVisibleWindows) return
      const workspace = activeWorkspace() ?? createWorkspace('local')
      if (workspace.window === null || workspace.window.isDestroyed()) return
      if (presentWindow(workspace.window) === null) openWorkspaceWindow(workspace)
    })
  })

  app.on('before-quit', event => {
    // Cmd+Q can arrive while a build is running; prevent it so `pnpm run
    // build` is never killed mid-flight by a normal quit.
    const busy = busySession()
    if (busy !== null) {
      event.preventDefault()
      const workspace = busy.windows.values().next().value ?? activeWorkspace()
      if (workspace !== null && workspace !== undefined) {
        workspace.progressDialog.open()
        workspace.progressDialog.state({
          title: '任务执行中，暂不能退出',
          status: '正在构建或更新组件。请等待任务完成后再退出；进度窗口关闭不会中断任务。',
          actions: [{ label: '关闭', name: 'close' }],
        })
      }
      dialog.showErrorBox('任务执行中', busyTaskMessage())
      return
    }
    quitting = true
    for (const session of sessions.values()) session.connection.stop()
  })

  app.on('window-all-closed', () => {
    // The tray keeps the app alive; quitting is explicit (Cmd+Q or tray).
  })
}