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
const { compareVersions } = require('./components')
const runtimeStore = require('./runtime-store')
const { Updater } = require('./update')
const { UpdateManager } = require('./update-manager')
const { SetupDialog, registerDialogIpc } = require('./dialogs')
const { buildMenu } = require('./menu')
const { createTray } = require('./tray')
const { presentWindow } = require('./windows')
const { WindowManager } = require('./window-manager')

const BUILD_DIR = path.join(__dirname, '..', 'build')
const SHELL_VERSION = '0.1.0'
/**
 * The highest harness version this shell is known to be compatible with,
 * keyed on the harness's own `apps/cli` package version. The shell is a thin
 * client over the harness, so a harness that outruns this range may have
 * changed its launch contract (bin path, boot marker, state file, runtime
 * layout). When the connected harness reports a version above this, the shell
 * warns the user to upgrade the shell. An older harness is not flagged here —
 * the shell upgrades it through the existing update pipeline instead.
 */
const SHELL_COMPAT = Object.freeze({ maxHarness: '0.2.0' })
const DOCK_ICON = path.join(BUILD_DIR, 'icon.png')
const DOCK_ICON_PRESSED = path.join(BUILD_DIR, 'iconPressed.png')
const DOCK_PRESS_MS = 150
const SHELL_HTML = path.join(__dirname, 'ui', 'shell.html')
const SHELL_PRELOAD = path.join(__dirname, 'shell-preload.js')
const SHELL_FRAME_HEIGHT = 46

/**
 * Keep development launches from touching the packaged app's settings/logs.
 * `electron .` and `npm start` use `~/.dsh-dev` as the Electron userData
 * directory (the same home the local service already uses for its own DSH
 * state), so a shell under development can never overwrite the installed
 * DeepSeek Harness app's `~/Library/Application Support/DeepSeek Harness`
 * or the user's real `~/.dsh`. The directory is created on demand.
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
    // Development convention: always use `~/.dsh-dev` (create it on demand)
    // so the dev shell never collides with the user's `~/.dsh` or the
    // installed app's `~/Library/Application Support/DeepSeek Harness`.
    const devHome = path.join(os.homedir(), DEV_DEFAULT_DSH_HOME.replace(/^~\//, ''))
    fs.mkdirSync(devHome, { recursive: true })
    app.setPath('userData', devHome)
  }
}

configureUserData()
app.setName('DeepSeek Harness')

let settingsStore = null
let settingsDocument = null
let trayController = null
let windowManager = null
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
  // `key` mutates when the ssh alias is merged into its machine identity after
  // connect, so every consumer reads the CURRENT key instead of the captured
  // construction-time one.
  const getSettings = () => settingsViewFor(session.key)
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
    workspace.setupDialog.log(line)
    // Also stream into the shell frame's loading panel so a slow/remote
    // connect shows what it is doing instead of a blank viewport.
    if (workspace.window !== null && !workspace.window.isDestroyed()) {
      workspace.window.webContents.send('shell:log', line)
    }
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
    connState: workspace.session.connection.status.state,
    harnessReady: workspace.harnessReady,
    loadError: workspace.loadError,
    progress: workspace.progress,
  })
}

/**
 * Keep the harness view visible only when it is front-most AND its page has
 * finished loading. Until `did-finish-load` flips `harnessReady`, the shell
 * frame's loading panel stays visible instead of a blank web view.
 */
function updateHarnessVisibility(workspace) {
  if (workspace.window === null || workspace.window.isDestroyed()) return
  const show = workspace.activeView === 'harness' && workspace.harnessReady && workspace.progress === null
  workspace.harnessView.setVisible(show)
  if (show) workspace.harnessView.webContents.focus()
  sendWorkspaceState(workspace)
}

/**
 * Set the workspace's blocking progress banner (shown by the loading panel in
 * place of the harness view) or clear it. A non-null progress keeps the
 * harness view hidden so the build/update status and retry action stay visible.
 */
function setProgress(workspace, progress) {
  workspace.progress = progress
  updateHarnessVisibility(workspace)
}

/**
 * Point the harness view at a URL and keep it hidden until the page loads:
 * `did-finish-load` sets `harnessReady` and `updateHarnessVisibility` shows it.
 */
function loadHarnessUrl(workspace, url) {
  workspace.loadedUrl = url
  workspace.harnessReady = false
  workspace.loadError = ''
  if (workspace.window !== null && !workspace.window.isDestroyed()) {
    workspace.window.setTitle(workspaceTitle(workspace))
  }
  workspace.harnessView.setVisible(false)
  workspace.harnessView.webContents.loadURL(url)
  sendWorkspaceState(workspace)
}

/**
 * Show one top-level workspace view. `view` is `harness` or one of the
 * settings sections (`connection` / `updates`). This is the single switch
 * used by the shell frame, menus, tray, and save flows.
 */
function setWorkspaceView(workspace, view) {
  if (!['harness', 'connection', 'updates'].includes(view)) view = 'harness'
  workspace.activeView = view
  if (view === 'harness') {
    workspace.setupDialog.close()
    updateHarnessVisibility(workspace)
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
  if (windowManager !== null) windowManager.touch(workspace)
  refreshTrayAndMenu()
}

function createBrowserWindow(bounds = null) {
  const win = new BrowserWindow({
    width: bounds?.width ?? 1320,
    height: bounds?.height ?? 900,
    ...(bounds?.x !== undefined && bounds?.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 900,
    minHeight: 600,
    title: 'DSH',
    icon: path.join(BUILD_DIR, 'icon.png'),
    show: false,
    // macOS: pass the click that activates an unfocused window straight
    // through to the harness below it. Without this, the first click on an
    // inactive workspace window only focuses the window and is swallowed, so
    // the harness icon/button the user aimed at needs a second click.
    acceptFirstMouse: true,
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
  if (windowManager !== null) {
    const lastActive = windowManager.lastActiveWorkspace(workspaces)
    if (lastActive !== null) return lastActive
  }
  return workspaces.values().next().value ?? null
}

/** Resolve the workspace that owns an IPC sender (frame, settings, or progress). */
function workspaceForEvent(event) {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win !== null && !win.isDestroyed()) {
    for (const workspace of workspaces.values()) {
      if (workspace.window === win) return workspace
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
  workspace.activeView = 'harness'
  workspace.setupDialog.close()
  loadHarnessUrl(workspace, url)
  if (windowManager !== null) windowManager.touch(workspace)
  refreshTrayAndMenu()
  presentWindow(workspace.window)
}

function connectSession(session) {
  if (session.connecting) return
  session.connecting = true
  Promise.resolve(session.connection.connect()).then(
    () => {
      session.connecting = false
      reconcileMachineIdentity(session)
      checkHostCompatibility(session)
    },
    () => { session.connecting = false },
  )
}

/**
 * After a successful connect, compare the connected harness's own version
 * against the shell's known-compatible ceiling. A too-new harness means the
 * shell may no longer understand its launch contract, so warn the user to
 * upgrade the shell. An older harness is not flagged — the shell upgrades it
 * through the existing update pipeline. Best-effort: an unreadable version
 * degrades to no-op.
 */
async function checkHostCompatibility(session) {
  if (session.connection.status.state !== 'ready') return
  let version = ''
  try {
    version = await session.connection.hostVersion()
  } catch {
    return
  }
  if (version === '') return
  session.hostVersion = version
  if (compareVersions(version, SHELL_COMPAT.maxHarness) > 0) {
    const message = `守护进程版本 ${version} 高于本壳已知兼容范围（≤ ${SHELL_COMPAT.maxHarness}）。\n\n请升级桌面壳后再连接，否则可能无法正常启动/管理该守护进程。`
    routeSessionLine(session, `⚠ 壳版本过低：${message.replace(/\n+/g, ' ')}`)
    dialog.showErrorBox('桌面壳版本过低', message)
  }
}

/**
 * Merge two `update` sections after two ssh aliases resolve to one machine.
 * Components are deduplicated by identity (`packageName` for npm, `presetId`
 * for git presets); the check timestamps keep the newer value.
 */
function mergeUpdates(primary, secondary) {
  const left = primary ?? {}
  const right = secondary ?? {}
  const seen = new Set()
  const components = []
  const leftComponents = Array.isArray(left.components) ? left.components : []
  const rightComponents = Array.isArray(right.components) ? right.components : []
  for (const def of [...leftComponents, ...rightComponents]) {
    if (def === null || typeof def !== 'object') continue
    const key = def.kind === 'git-preset'
      ? `preset:${def.presetId ?? def.id}`
      : `npm:${def.packageName ?? def.installSpec ?? def.id}`
    if (seen.has(key)) continue
    seen.add(key)
    components.push(def)
  }
  const leftTime = left.lastCheckAt ?? ''
  const rightTime = right.lastCheckAt ?? ''
  const newerIsLeft = String(leftTime).localeCompare(String(rightTime)) >= 0
  return {
    autoCheckOnLaunch: left.autoCheckOnLaunch !== undefined ? left.autoCheckOnLaunch : right.autoCheckOnLaunch,
    lastCheckAt: newerIsLeft ? leftTime : rightTime,
    lastNotifiedKey: newerIsLeft ? (left.lastNotifiedKey ?? '') : (right.lastNotifiedKey ?? ''),
    components,
  }
}

/**
 * Merge one ssh alias device into its machine identity device. When the
 * machine device already exists, its ssh entry (the active connection's host)
 * is preserved and only the `update` section is merged; otherwise the alias's
 * whole document becomes the machine device. Any live session keyed by the
 * alias is re-homed onto `machine:<id>`.
 * @returns true when the device map changed.
 */
function mergeAliasIntoMachine(aliasKey, machineId) {
  const current = settingsDocument.devices[aliasKey]
  if (current === undefined) return false
  const targetKey = `machine:${machineId}`
  if (aliasKey === targetKey) return false

  const existing = settingsDocument.devices[targetKey]
  const devices = { ...settingsDocument.devices }
  delete devices[aliasKey]

  if (existing !== undefined) {
    devices[targetKey] = {
      ...existing,
      machineId,
      // The ssh entry must stay the CURRENTLY-connected one, not the old one
      // recorded on the existing machine device. After this merge the session
      // re-reads settings through the machine key, and every remote command
      // (`remoteRun`) dials `ssh.host`. Keeping the stale entry (e.g. the
      // public `home4`) while the user actually connected over LAN (`ubuntu`)
      // would point every follow-up ssh at an unreachable address.
      ssh: { ...existing.ssh, ...current.ssh },
      update: mergeUpdates(existing.update, current.update),
    }
  } else {
    devices[targetKey] = { ...current, machineId }
  }

  const activeDeviceId = settingsDocument.activeDeviceId === aliasKey
    ? targetKey
    : settingsDocument.activeDeviceId

  settingsDocument = persistDocument({
    activeDeviceId,
    devices,
    toolPaths: settingsDocument.toolPaths,
  })

  const session = sessions.get(aliasKey)
  if (session !== undefined) {
    sessions.delete(aliasKey)
    session.key = targetKey
    sessions.set(targetKey, session)
    for (const workspace of session.windows) workspace.deviceKey = targetKey
  }
  // Reload the machine device's live update manager so a merge immediately
  // refreshes the update rows after the alias's session is re-homed.
  const targetSession = sessions.get(targetKey)
  if (targetSession !== undefined && targetSession.updateManager !== null) {
    targetSession.updateManager.settings = settingsViewFor(targetKey)
    targetSession.updateManager.reloadComponents()
  }
  return true
}

/**
 * After a successful ssh connect, reconcile the session's device onto its
 * machine identity. Two aliases reaching the same `~/.dsh` (e.g. `ubuntu` over
 * LAN and `home4` over the public network) share one machine id; the current
 * connection's alias device is upgraded/merged into the `machine:<id>` device
 * so its update sources are keyed by the terminal, not by the network entry.
 * Historical multi-alias data is migrated out-of-band, not auto-scanned here.
 */
function reconcileMachineIdentity(session) {
  const machineId = session.connection.machineId
  if (machineId === null || machineId === undefined || machineId === '' || session.key === 'local') return
  const targetKey = `machine:${machineId}`
  if (session.key === targetKey) return

  if (mergeAliasIntoMachine(session.key, machineId)) {
    routeSessionLine(session, `终端身份已归一：${targetKey}`)
    refreshTrayAndMenu()
    for (const workspace of session.windows) {
      if (workspace.window !== null && !workspace.window.isDestroyed()) {
        workspace.window.setTitle(workspaceTitle(workspace))
        sendWorkspaceState(workspace)
      }
    }
  }
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
  const bounds = windowManager === null ? null : windowManager.boundsFor(deviceKey)
  const win = createBrowserWindow(bounds)
  const harnessView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Never throttle the harness renderer when its window loses focus: with
      // several workspace windows open, Chromium's default background
      // throttling pauses rAF and drops timer cadence on the inactive windows,
      // which surfaces as a laggy/flashy UI and first-click stalls the moment
      // the user switches back. Each harness must stay responsive regardless
      // of which window is front-most.
      backgroundThrottling: false,
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
    pendingOpen: true,
    activeView: 'harness',
    loadedUrl: '',
    harnessReady: false,
    loadError: '',
    progress: null,
  }
  nextWorkspaceId += 1
  workspaces.set(workspace.id, workspace)
  session.windows.add(workspace)
  win.setTitle(workspaceTitle(workspace))

  win.once('ready-to-show', () => {
    layoutWorkspaceViews(workspace)
    sendWorkspaceState(workspace)
    if (windowManager !== null) windowManager.touch(workspace)
    win.show()
    openWorkspaceWindow(workspace)
  })
  win.on('resize', () => {
    layoutWorkspaceViews(workspace)
    if (windowManager !== null) windowManager.touch(workspace)
  })
  win.on('move', () => {
    if (windowManager !== null) windowManager.touch(workspace)
  })
  win.on('focus', () => {
    if (windowManager !== null) windowManager.markActive(workspace)
    refreshTrayAndMenu()
    // A WebContentsView does not re-acquire focus on its own when its window
    // regains focus (e.g. switching between two workspace windows). Route
    // focus back to the harness so its clicks/keys land on the first
    // interaction instead of being lost to the shell frame's webContents.
    if (workspace.activeView === 'harness'
      && workspace.harnessView !== null
      && !workspace.harnessView.webContents.isDestroyed()) {
      workspace.harnessView.webContents.focus()
    }
  })
  win.on('close', event => {
    if (!quitting) {
      event.preventDefault()
      if (windowManager !== null) windowManager.touch(workspace)
      win.hide()
    }
  })
  win.on('closed', () => disposeWorkspace(workspace))
  win.webContents.on('did-fail-load', (_event, code, description) => {
    session.connection.log(`[窗口] 框架加载失败 ${code} ${description}`)
  })
  harnessView.webContents.on('did-start-loading', () => {
    // Only a real harness URL hides the view (about:blank stays hidden); this
    // also covers reloadIgnoringCache so a post-update reload shows the
    // loading panel instead of a blank web view.
    if (workspace.loadedUrl === '') return
    workspace.harnessReady = false
    updateHarnessVisibility(workspace)
  })
  harnessView.webContents.on('did-finish-load', () => {
    // about:blank (loadedUrl === '') must never mark the harness ready; only
    // a real harness URL flips visibility so the loading panel yields at the
    // right moment.
    if (workspace.loadedUrl === '') return
    workspace.harnessReady = true
    workspace.loadError = ''
    updateHarnessVisibility(workspace)
  })
  harnessView.webContents.on('did-fail-load', (_event, code, description) => {
    // -3 (ERR_ABORTED) is a cancelled navigation (e.g. switching devices to
    // about:blank), not a real failure worth surfacing.
    if (code === -3) return
    workspace.harnessReady = false
    workspace.loadError = description
    session.connection.log(`[窗口] 加载失败 ${code} ${description}`)
    updateHarnessVisibility(workspace)
  })

  return workspace
}

function disposeWorkspace(workspace) {
  const session = workspace.session
  if (windowManager !== null) windowManager.touch(workspace)
  session.windows.delete(workspace)
  workspace.setupDialog.close()
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
  workspace.loadedUrl = ''
  workspace.harnessReady = false
  workspace.loadError = ''
  workspace.progress = null
  session.windows.add(workspace)
  // Never let a stale device's page flash while the new backend is connecting.
  workspace.harnessView.setVisible(false)
  workspace.harnessView.webContents.loadURL('about:blank')
  if (windowManager !== null) windowManager.touch(workspace)
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
      // Mark not-ready first so the loading panel takes over during the reload
      // instead of flashing the stale page.
      workspace.harnessReady = false
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

function refreshMenu() {
  const workspace = activeWorkspace()
  const session = workspace === null ? null : workspace.session
  Menu.setApplicationMenu(buildMenu({
    actions,
    getStatus: () => session === null ? idleStatus() : session.connection.status,
    getSettings: () => activeSettingsView(),
    // The menu acts on the ACTIVE terminal, so its busy state is that
    // terminal's alone — a build on another terminal must not grey it out.
    isBusy: () => session !== null && isSessionBusy(session),
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
    } else if (status.state === 'ready' && workspace.loadedUrl !== '' && workspace.loadedUrl !== status.url) {
      // A restarted service may report a new OS-chosen port. Reload in place
      // without yanking focus from the window the user is actually using.
      loadHarnessUrl(workspace, status.url)
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
    const busyMessage = busyTaskMessage(session)
    if (busyMessage !== '') {
      setWorkspaceView(workspace, 'harness')
      setProgress(workspace, {
        title: '初始化构建',
        status: `${busyMessage} 稍后请从「更新 → 仅更新 Harness」重试。`,
      })
      return
    }
    setWorkspaceView(workspace, 'harness')
    setProgress(workspace, {
      title: '初始化构建',
      status: '首次使用：确保仓库 → 工具链引导 → pnpm install → pnpm run build → 启动服务',
    })
    const outcome = await session.updater.runPipeline({ includePull: true, toleratePullFailure: true })
    if (!outcome.ok) {
      setProgress(workspace, {
        title: '初始化构建',
        status: '构建失败。可修复后重试（日志已写入文件）。',
        actions: [{ label: '重试', name: 'run-init', primary: true }],
      })
      return
    }
    setProgress(workspace, null)
  }
  setWorkspaceView(workspace, 'harness')
  workspace.pendingOpen = true
  connectSession(session)
}

async function runInit(workspace) {
  const session = workspace.session
  if (!canStartBusyTask(session)) return
  setProgress(workspace, { title: '初始化构建', status: '执行中…' })
  const outcome = await session.updater.runPipeline({ includePull: true, toleratePullFailure: true })
  if (outcome.ok) {
    setProgress(workspace, null)
    setWorkspaceView(workspace, 'harness')
    workspace.pendingOpen = true
    connectSession(session)
  } else {
    setProgress(workspace, {
      title: '初始化构建',
      status: '构建失败。可修复后重试（日志已写入文件）。',
      actions: [{ label: '重试', name: 'run-init', primary: true }],
    })
  }
}

// ── user actions ────────────────────────────────────────────────────────────

/**
 * Build/update tasks are serialized PER TERMINAL, not globally. Local and each
 * remote machine build against their own checkout with their own CPU/network,
 * so one terminal's build never blocks another. Only the same terminal's
 * concurrent tasks (e.g. two windows of one device both updating) are gated.
 * The single global exception is app quit, which tears down every child.
 */
function isSessionBusy(session) {
  if (session === null || session === undefined) return false
  if (session.updater !== null && session.updater.busy) return true
  if (session.updateManager !== null && session.updateManager.busy) return true
  return false
}

function busyTaskMessage(session) {
  if (!isSessionBusy(session)) return ''
  const terminal = terminalLabel(settingsViewFor(session.key))
  return `${terminal} 正在构建或更新组件，请等待任务完成后再启动新的更新/构建。`
}

function canStartBusyTask(session) {
  const message = busyTaskMessage(session)
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
    const target = withWorkspace(workspace)
    if (!canStartBusyTask(target.session)) return target
    target.session.autoReconnectAttempts = 0
    target.pendingOpen = true
    connectSession(target.session)
  },

  async resetBackend(workspace) {
    const target = withWorkspace(workspace)
    if (!canStartBusyTask(target.session)) return target
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

  async rollbackHarness(workspace) {
    const target = withWorkspace(workspace)
    if (!canStartBusyTask(target.session)) return target
    const session = target.session
    const settings = settingsViewFor(session.key)
    try {
      const previous = settings.mode === 'ssh'
        ? await runtimeStore.rollbackRemoteRuntime(
          settings,
          (host, inner, options) => session.connection.remoteRun(host, inner, options),
        )
        : runtimeStore.rollbackLocalRuntime(settings)
      if (previous === null || previous === '') {
        dialog.showErrorBox('没有可回滚的版本', '至少成功构建过两个版本后，才会保留上一版本。')
        return target
      }
      routeSessionLine(session, `已回滚 Harness 运行时：current → ${previous}。正在重启后端…`)
      await session.connection.resetService()
      target.pendingOpen = true
      session.autoReconnectAttempts = 0
      connectSession(session)
    } catch (error) {
      routeSessionLine(session, `✗ 回滚 Harness 失败：${String(error.message || error)}`)
      dialog.showErrorBox('回滚失败', String(error.message || error))
    }
    return target
  },

  async checkUpdates(workspace) {
    const target = actions.openUpdates(workspace)
    if (!canStartBusyTask(target.session)) return target
    try {
      await target.session.updateManager.checkAll()
    } catch (error) {
      routeSessionLine(target.session, `✗ 检查更新失败：${String(error.message || error)}`)
    }
    broadcastSession(target.session)
  },

  async updateAll(workspace) {
    const target = actions.openUpdates(workspace)
    if (!canStartBusyTask(target.session)) return target
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
    const target = withWorkspace(workspace)
    if (!canStartBusyTask(target.session)) return target
    setProgress(target, { title: '更新并重启', status: '执行中…' })
    const outcome = await target.session.updater.runPipeline({ includePull: true })
    if (outcome.ok) {
      // Mark windows not-ready + reload first, then clear the banner, so the
      // loading panel takes over without flashing the stale page.
      reloadSessionWindows(target.session)
      setProgress(target, null)
    } else {
      setProgress(target, {
        title: '更新并重启',
        status: '更新失败。可修复后重试（日志已写入文件）。',
        actions: [{ label: '重试', name: 'run-update', primary: true }],
      })
    }
    refreshMenu()
  },

  async openLogs(workspace) {
    const target = withWorkspace(workspace)
    const session = target.session
    const view = settingsViewFor(session.key)
    if (view.mode === 'ssh') {
      const remote = await session.connection.remoteRun(
        view.ssh.host,
        'tail -n 100 "$HOME"/.dsh/desktop-web.log 2>/dev/null || echo "(远程日志为空或不存在)"',
        { timeoutMs: 15_000 },
      )
      logSink('\n── 远程 ~/.dsh/desktop-web.log ──')
      for (const line of remote.lines) logSink(line)
    }
    // Logs stream into the loading panel live; "打开服务日志" opens the
    // persisted log file (which already contains local + remote lines).
    if (sessionLogFile !== '' && fs.existsSync(sessionLogFile)) {
      await shell.openPath(sessionLogFile)
    }
    return target
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
    // No busy gate here: updates build into an isolated staging directory and
    // switch atomically via the `current` symlink, so quitting mid-build only
    // discards a staging dir (rebuilt next run) — the source checkout and the
    // running service are never left half-built. before-quit tears down all
    // children.
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
      const busyMessage = busyTaskMessage(workspace.session)
      if (busyMessage !== '') return { ok: false, error: busyMessage }
      const candidate = normalizeSettings(rawSettings)
      const error = validateSettings(candidate)
      if (error !== null) return { ok: false, error }
      // Connection saves never carry update settings from another device.
      // A newly selected target keeps its own update section (or starts
      // with the harness-only default), and switching back restores it.
      // Preserve the machine identity the current terminal already resolved:
      // the settings form carries no machineId, and re-keying by alias alone
      // would split an already-merged machine back apart. Switching to a
      // DIFFERENT host drops the identity so the next connect re-learns it.
      const currentDevice = settingsDocument.devices[workspace.deviceKey]
      const hostChanged = currentDevice !== undefined
        && currentDevice.mode === 'ssh'
        && currentDevice.ssh.host !== candidate.ssh.host
      const keepMachineId = workspace.deviceKey.startsWith('machine:')
        && currentDevice !== undefined
        && !hostChanged
      const machineId = keepMachineId ? currentDevice.machineId : ''
      const deviceKey = deviceKeyOf({ ...candidate, machineId })
      const previousUpdate = settingsDocument.devices[deviceKey]?.update
      const device = {
        mode: candidate.mode,
        machineId,
        local: candidate.local,
        ssh: candidate.ssh,
        update: previousUpdate ?? candidate.update,
      }
      persistDevice(deviceKey, device)
      settingsDocument = persistDocument({
        activeDeviceId: deviceKey,
        devices: settingsDocument.devices,
        toolPaths: settingsDocument.toolPaths,
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
      if (windowManager !== null) windowManager.markActive(workspace)
      setWorkspaceView(workspace, 'harness')
      startWithSettings(workspace)
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
      const taskNames = ['check-all', 'check-one', 'update-one', 'update-all', 'restart-service']
      const busyMessage = busyTaskMessage(session)
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
          case 'restart-service':
            await session.connection.restartService()
            break
          case 'save-sources':
            if (!Array.isArray(payload?.components)) {
              return { ok: false, error: 'components 必须为数组' }
            }
            saveUpdateForSession(session, { components: payload.components })
            break

          case 'copy-source': {
            const id = String(payload?.id ?? '')
            const row = session.updateManager.component(id)
            if (row.kind === 'harness') return { ok: false, error: 'Harness 无安装源可复制' }
            const source = row.kind === 'git-preset'
              ? (row.repoUrl || row.checkoutDir || '')
              : (row.installSpec || row.packageName || '')
            if (source === '') return { ok: false, error: '该组件无安装源可复制' }
            clipboard.writeText(source)
            break
          }

          case 'delete-component': {
            const id = String(payload?.id ?? '')
            if (id === '' || id === 'harness') return { ok: false, error: '不能删除该组件' }
            const update = session.updateManager.settings.update ?? {}
            const components = (Array.isArray(update.components) ? update.components : [])
              .filter(component => component.id !== id)
            saveUpdateForSession(session, { components })
            break
          }

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

  ipcMain.handle('shell:new-window', () => {
    actions.newWindow()
    return { ok: true }
  })

  ipcMain.handle('shell:action', (event, name) => {
    const workspace = workspaceForEvent(event) ?? withWorkspace(null)
    switch (name) {
      case 'run-init':
        void runInit(workspace)
        break
      case 'run-update':
        void actions.updateAndRestart(workspace)
        break
      default:
        return { ok: false, error: `未知动作：${name}` }
    }
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
    const expected = path.join(os.homedir(), DEV_DEFAULT_DSH_HOME.replace(/^~\//, ''))
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
    for (const name of ['newWindow', 'openMain', 'openSettings', 'openUpdates', 'checkUpdates', 'updateAll', 'updateAndRestart', 'resetBackend', 'rollbackHarness', 'quit']) {
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
    windowManager = new WindowManager(path.join(app.getPath('userData'), 'window-state.json'))

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
      // The tray mirrors the active terminal's busy state, like the menu.
      isBusy: () => isSessionBusy(activeSession()),
    })

    try {
      app.dock.setMenu(Menu.buildFromTemplate([
        { label: '新建窗口', click: () => actions.newWindow() },
      ]))
    } catch {
      // Dock menu is macOS-only and cosmetic.
    }

    refreshTrayAndMenu()

    // Restore the device the user last had in front, not just the device that
    // happened to be persisted by the last settings save.
    const lastDevice = windowManager.lastActiveDeviceKey()
    const firstDevice = settingsDocument.devices[lastDevice] !== undefined
      ? lastDevice
      : settingsDocument.activeDeviceId
    const first = createWorkspace(firstDevice)
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

  app.on('before-quit', () => {
    // Killing a mid-flight build is safe: it only discards a staging directory
    // (rebuilt next run); the source checkout and running service are isolated
    // by the atomic `current`-symlink switch. So quit tears down children
    // directly instead of blocking on a busy gate.
    quitting = true
    if (windowManager !== null) windowManager.save()
    for (const session of sessions.values()) session.connection.stop()
  })

  app.on('window-all-closed', () => {
    // The tray keeps the app alive; quitting is explicit (Cmd+Q or tray).
  })
}