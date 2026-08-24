'use strict'

/**
 * dsh-mac-desktop — main process.
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
  app, BrowserWindow, Menu, shell, dialog, clipboard, Notification, WebContentsView, ipcMain, nativeTheme,
} = require('electron')

const {
  SettingsStore, normalizeSettings, deviceKeyOf, DEV_DEFAULT_DSH_HOME, DEFAULT_THEME, normalizeTheme, THEME_APPEARANCE,
} = require('./settings')
const { mergeUpdates } = require('./device-merge')
const { terminalLabel } = require('./labels')
const { resolveTools } = require('./tools')
const { runCommand, killActiveChildren, cancelOwnedChildren, spawnDetached } = require('./runner')
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
// Single source of truth: the shell version always follows package.json (and
// therefore the bundled Info.plist CFBundleShortVersionString). Never hardcode.
const SHELL_VERSION = require('../package.json').version
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
    theme: normalizeTheme(normalized.theme),
  }
}

/** Persist a clean document and update the in-memory copy. */
function persistDocument(document) {
  // Merge onto the current in-memory document so a partial caller (e.g. a
  // theme-only change) can never drop `devices`/`toolPaths` and reset the
  // connection + update state. `theme` is global and carried forward unless
  // an explicit one is supplied.
  const base = settingsDocument ?? {}
  const withTheme = {
    activeDeviceId: document.activeDeviceId ?? base.activeDeviceId,
    devices: document.devices ?? base.devices,
    toolPaths: document.toolPaths ?? base.toolPaths,
    theme: normalizeTheme(document.theme ?? base.theme),
  }
  const saved = settingsStore.save(withTheme)
  settingsDocument = cleanDocument(saved)
  return settingsDocument
}

/** The currently selected shell theme id (never null after startup). */
function currentTheme() {
  return settingsDocument === null ? DEFAULT_THEME : settingsDocument.theme
}

/**
 * Pin the native chrome appearance (traffic lights, scrollbars, form controls)
 * to match the selected theme so a light theme never leaves white traffic
 * lights stranded on a light frame (or vice versa). `default` stays system.
 */
function applyNativeTheme(theme) {
  nativeTheme.themeSource = THEME_APPEARANCE[theme] ?? 'system'
}

/**
 * Broadcast the active theme to every live surface so a selection made in one
 * window re-skins the shell frame and every settings panel without a reload.
 */
function broadcastTheme(theme) {
  for (const workspace of workspaces.values()) {
    if (workspace.window !== null && !workspace.window.isDestroyed()) {
      workspace.window.webContents.send('shell:theme', theme)
    }
    workspace.setupDialog.send('dialog:theme', theme)
  }
}

/**
 * Select + persist a shell theme and re-skin every live surface immediately.
 * Used by the Appearance section; the harness web view is left alone.
 */
function setTheme(theme) {
  const next = normalizeTheme(theme)
  persistDocument({
    activeDeviceId: settingsDocument.activeDeviceId,
    devices: settingsDocument.devices,
    toolPaths: settingsDocument.toolPaths,
    theme: next,
  })
  applyNativeTheme(next)
  broadcastTheme(next)
  return { ok: true, theme: next }
}

/**
 * The active-device settings view for one device key. A detached window has
 * no session yet; it reads the persisted active device as the candidate to
 * prefill in the connection form, and the real key is only decided on save.
 */
function settingsViewFor(deviceKey) {
  const key = deviceKey === null || deviceKey === undefined
    ? (settingsDocument && settingsDocument.activeDeviceId) || 'local'
    : deviceKey
  return normalizeSettings({
    activeDeviceId: key,
    devices: settingsDocument.devices,
    toolPaths: settingsDocument.toolPaths,
  })
}

/** Device key a detached window should prefill/act on. */
function candidateDeviceKey() {
  return (settingsDocument && settingsDocument.activeDeviceId) || 'local'
}

/**
 * Coarse task label for the shell frame. The shell is above the harness and
 * must be able to answer what is happening even while the web view is hidden
 * or a second window is detached.
 */
function sessionTask(session) {
  if (session === null || session === undefined) return { state: 'detached', label: '待连接' }
  if (session.connection.status.state === 'restarting') {
    return { state: 'restarting', label: '服务重启中…' }
  }
  if (session.workerPollTimer !== null) {
    return { state: 'updating', label: '官方产物更新中…' }
  }
  if (session.updater !== null && session.updater.busy) {
    return { state: 'building', label: 'Harness 构建/更新中…' }
  }
  if (session.updateManager !== null && session.updateManager.busy) {
    const snapshot = session.updateManager.snapshot()
    const updating = snapshot.components.some(row => row.status === 'updating')
    return updating
      ? { state: 'updating', label: '组件更新中…' }
      : { state: 'checking', label: '检查更新中…' }
  }
  return { state: 'idle', label: '' }
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
    workerPollTimer: null,
    // Task banner shared by every window attached to this terminal. Keeping it
    // on the session (not the initiating workspace) means a window opened or
    // attached mid-update immediately sees the same blocking state instead of
    // a stale/white harness page.
    progress: null,
    // Promise of the currently-running init/build/check/update task, used by
    // cancelSessionTask to wait for lock release after the process is killed.
    taskPromise: null,
    connectionTaskPromise: null,
  }
  // `key` mutates when the ssh alias is merged into its machine identity after
  // connect, so every consumer reads the CURRENT key instead of the captured
  // construction-time one.
  const getSettings = () => settingsViewFor(session.key)
  // The owner token is STABLE for the lifetime of a session. `key` may be
  // re-homed after machine-id merge, but children spawned before the merge
  // must still be cancellable under the token they were registered with.
  session.ownerToken = `session:${deviceKey}`
  session.owner = () => session.ownerToken
  session.connection = new ConnectionManager({
    getSettings,
    getOwner: () => session.owner(),
    onLog: line => routeSessionLine(session, line),
  })
  session.updater = new Updater({
    getSettings,
    connection: session.connection,
    onLine: line => routeSessionLine(session, line),
    // The shell frame sits above the harness, so every busy/idle transition
    // must refresh its status line as well as the menu/tray. `broadcastSession`
    // is safe as soon as `updateManager` is assigned below.
    onBusyChange: () => {
      broadcastSession(session)
      refreshTrayAndMenu()
    },
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

const TASK_CANCEL_TIMEOUT_MS = 15 * 1000

/** Track the active task promise so window-switch cancellation can await it. */
function trackSessionTask(session, promise) {
  const tracked = Promise.resolve(promise)
  session.taskPromise = tracked
  tracked.finally(() => {
    if (session.taskPromise === tracked) session.taskPromise = null
  }).catch(() => {})
  return tracked
}

/**
 * Cancel one terminal's in-flight init/build/check/update. The official
 * artifact worker is intentionally NOT killed here: it is detached by design
 * and a later local window picks its status back up.
 */
async function cancelSessionTask(session) {
  if (session === null || session === undefined) return
  const pending = [session.taskPromise, session.connectionTaskPromise].filter(promise => promise !== null && promise !== undefined)
  if (pending.length === 0) return
  const hadProgress = session.progress === null ? false : true
  routeSessionLine(session, '正在取消当前终端的更新/构建任务…')
  cancelOwnedChildren(session.owner(), 'SIGTERM')
  await Promise.race([
    Promise.allSettled(pending),
    new Promise(resolve => setTimeout(resolve, TASK_CANCEL_TIMEOUT_MS)),
  ])
  const stillPending = [session.taskPromise, session.connectionTaskPromise].some(promise => promise !== null && promise !== undefined)
  if (hadProgress) {
    setSessionProgress(session, {
      title: '更新已取消',
      status: '窗口已切换，旧版本继续运行。可从设置重新更新。',
      actions: [
        { label: '重试', name: 'run-update', primary: true },
        { label: '放弃', name: 'dismiss-progress' },
      ],
    })
  }
  if (stillPending) {
    routeSessionLine(session, '取消超时，已强制放弃任务；如需可从设置重试。')
  } else {
    routeSessionLine(session, '已取消，旧版本继续运行。')
  }
}

/**
 * Release a session that no window references. Cancel in-flight work FIRST,
 * then stop the backend so remote locks have a chance to be removed by the
 * pipeline's finally block before the tunnel dies. Local sessions stay alive
 * to keep the resident service and detached artifact worker reusable.
 */
async function abandonSession(session) {
  if (session === null || session === undefined) return
  await cancelSessionTask(session)
  if (session.windows.size === 0 && session.key !== 'local') stopSession(session)
}

// ── official-artifact update worker (Phase 2/3) ─────────────────────────────

/** Whether a local PID is alive (signal 0 probes without signalling). */
function pidAliveLocal(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * Spawn the detached update worker for a local official-artifact update and
 * start observing its status file. The worker survives shell quit; on the
 * next launch `resumePendingUpdate` picks the outcome back up.
 */
function spawnUpdateWorker(session, view, version) {
  if (session.workerPollTimer !== null) return
  const root = runtimeStore.localRuntimeRoot(view)
  const taskPath = path.join(root, 'update-task.json')
  try {
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(taskPath, JSON.stringify({
      dshHome: view.local.dshHome,
      repoDir: view.local.repoDir,
      repoUrl: view.local.repoUrl,
      toolPaths: view.toolPaths,
      version,
      registryUrl: view.update?.registryUrl ?? '',
    }, null, 2))
    runtimeStore.writePendingUpdate(view, { intent: 'artifact', version })
  } catch (error) {
    routeSessionLine(session, `✗ 无法准备更新任务：${error.message}`)
    return
  }
  routeSessionLine(session, `启动后台更新任务：官方预构建版 v${version}（壳可正常关闭，任务会继续完成）`)
  spawnDetached({
    cmd: process.execPath,
    args: [path.join(__dirname, 'update-worker.js'), taskPath],
  })
  session.workerPollTimer = setInterval(() => observeUpdateWorker(session), 800)
  session.workerPollTimer.unref()
}

/** Set the progress banner directly on a session, even with no open window. */
function setSessionProgress(session, progress) {
  session.progress = progress
  for (const workspace of session.windows) {
    workspace.progress = progress
    updateHarnessVisibility(workspace)
  }
}

/** Poll the worker status file and mirror its progress into the session UI. */
function observeUpdateWorker(session) {
  const view = settingsViewFor(session.key)
  const status = runtimeStore.readUpdateStatus(view)
  if (status === null) return
  const live = Number.isInteger(status.pid) && pidAliveLocal(status.pid)
  const logTail = Array.isArray(status.logTail) ? status.logTail : []
  const lastCount = session.workerLogCount ?? 0
  if (logTail.length > lastCount) {
    for (const line of logTail.slice(lastCount)) routeSessionLine(session, line)
    session.workerLogCount = logTail.length
  }
  const phase = String(status.phase || '')
  if (phase === 'done' || phase === 'error' || (phase !== '' && !live)) {
    stopObservingWorker(session)
    if (phase === 'done') {
      routeSessionLine(session, `官方产物 v${status.version} 已就绪，正在重启服务…`)
      runtimeStore.clearUpdateStatus(view)
      setSessionProgress(session, { title: '更新完成', status: '正在重启服务…' })
      session.connection.restartService().then(() => {
        setSessionProgress(session, null)
        reloadSessionWindows(session)
        routeSessionLine(session, '服务已重启，使用新版本。')
      }).catch(error => {
        setSessionProgress(session, null)
        routeSessionLine(session, `✗ 重启服务失败：${String(error.message || error)}`)
      })
    } else if (phase === 'error') {
      routeSessionLine(session, `✗ 官方产物更新失败：${status.error || '未知错误'}`)
      runtimeStore.clearUpdateStatus(view)
      setSessionProgress(session, {
        title: '更新失败（官方产物）',
        status: status.error || '未知错误',
        actions: [
          { label: '重试', name: 'run-update', primary: true },
          { label: '放弃', name: 'dismiss-progress' },
        ],
      })
    } else {
      routeSessionLine(session, '更新任务进程已退出且未完成，可稍后重试。')
      runtimeStore.clearUpdateStatus(view)
    }
    return
  }
  const phaseText = phase === 'starting' ? '启动中…' : phase === 'downloading' ? `下载官方预构建版 v${status.version}…` : phase === 'installing' ? '安装中…' : phase === 'switching' ? '原子切换运行时…' : '进行中…'
  setSessionProgress(session, { title: '更新（官方产物）', status: phaseText })
}

function stopObservingWorker(session) {
  if (session.workerPollTimer !== null) {
    clearInterval(session.workerPollTimer)
    session.workerPollTimer = null
  }
  session.workerLogCount = 0
}

/**
 * Actionable failure diagnostics for a failed build/update: disk space,
 * toolchain availability, mode — the things that turn a dead-end retry
 * into a decision (free disk, fix toolchain, switch source, use artifact).
 */
async function diagnoseFailure(session) {
  const lines = []
  const view = settingsViewFor(session.key)
  try {
    const dshHome = runtimeStore.expandHome(view.local.dshHome)
    const df = await runCommand({ cmd: '/bin/df', args: ['-k', dshHome] })
    const row = (df.lines[1] || '').split(/\s+/)
    const availBlocks = Number(row[3])
    lines.push(`磁盘空间：${Number.isFinite(availBlocks) ? `${(availBlocks / 1024 / 1024).toFixed(1)} GB 可用` : '未知'}`)
  } catch {
    lines.push('磁盘空间：未知')
  }
  const tools = resolveTools(view)
  lines.push(`node：${tools.node || '未找到'}`)
  lines.push(`pnpm：${tools.pnpm || '未找到'}`)
  lines.push(view.mode === 'ssh' ? `模式：SSH ${view.ssh.host}` : '模式：本地')
  lines.push('提示：完整日志已写入日志文件，可从「设置」查看。')
  return lines.join('\n')
}

/**
 * Decide whether an update should go through the detached artifact worker.
 * Returns true when a worker was started (or already running).
 */
async function startArtifactUpdateIfPossible(session) {
  if (session.key !== 'local') return false
  if (session.workerPollTimer !== null) return true
  const view = settingsViewFor('local')
  if (!session.updater.preferArtifact(view)) return false
  const query = await session.updater.queryArtifact(view)
  if (!query.ok) {
    routeSessionLine(session, query.reason)
    return false
  }
  spawnUpdateWorker(session, view, query.version)
  return true
}

/**
 * On launch, pick up an update intent the previous run left behind: a worker
 * that finished while the shell was gone, a worker that died mid-download,
 * or an in-shell artifact install that was killed on quit.
 */
function resumePendingUpdate() {
  const view = settingsViewFor('local')
  const pending = runtimeStore.readPendingUpdate(view)
  const status = runtimeStore.readUpdateStatus(view)
  if (pending === null && status === null) return
  const session = sessionFor('local')
  const liveWorker = status !== null && Number.isInteger(status.pid) && pidAliveLocal(status.pid)
  const phase = status === null ? '' : String(status.phase || '')
  setTimeout(() => {
    if (pending !== null && liveWorker) {
      session.workerLogCount = 0
      session.workerPollTimer = setInterval(() => observeUpdateWorker(session), 800)
      session.workerPollTimer.unref()
      routeSessionLine(session, `检测到后台更新仍在进行（v${pending.version}），已接管观察。`)
      dialog.showMessageBox({ type: 'info', title: '更新进行中', message: `官方产物 v${pending.version} 仍在后台更新，完成后会自动重启服务。` })
      return
    }
    if (status !== null && phase === 'done') {
      runtimeStore.clearPendingUpdate(view)
      runtimeStore.clearUpdateStatus(view)
      dialog.showMessageBox({ type: 'info', title: '更新已完成', message: `上次更新已完成：官方预构建版 v${status.version}。重新连接后生效。` })
      return
    }
    if (status !== null && phase === 'error') {
      runtimeStore.clearPendingUpdate(view)
      runtimeStore.clearUpdateStatus(view)
      dialog.showMessageBox({ type: 'error', title: '更新失败', message: `上次官方产物更新失败：${status.error || '未知错误'}`, buttons: ['重试', '放弃'], defaultId: 0 }).then(result => {
        if (result.response === 0) {
          session.updater.queryArtifact(view).then(query => {
            if (query.ok) spawnUpdateWorker(session, view, query.version)
          })
        }
      })
      return
    }
    if (pending !== null) {
      const message = `上次官方产物更新未完成（v${pending.version}）。继续下载安装？`
      dialog.showMessageBox({ type: 'warning', title: '上次更新未完成', message, buttons: ['继续', '放弃'], defaultId: 0 }).then(result => {
        if (result.response !== 0) {
          runtimeStore.clearPendingUpdate(view)
          return
        }
        spawnUpdateWorker(session, view, pending.version)
      })
    }
  }, 1500)
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

/** Persist a validated connection candidate and return its settings view. */
function persistConnectionCandidate(deviceKey, candidate, machineId) {
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
  return settingsViewFor(deviceKey)
}

/**
 * Same-terminal save: only switch focus to the window that is already open.
 * The current window stays untouched (detached or still bound to its own
 * terminal). This is the ONLY cross-window focus jump allowed.
 */
function openExistingTerminalWindow(existingTarget, targetBusy, targetUnchanged) {
  const session = existingTarget.session
  presentWorkspace(existingTarget)
  if (targetBusy) {
    setWorkspaceView(existingTarget, 'harness')
    return
  }
  if (targetUnchanged && session.connection.status.state === 'ready') {
    setWorkspaceView(existingTarget, 'harness')
    return
  }
  existingTarget.pendingOpen = true
  setWorkspaceView(existingTarget, 'harness')
  startWithSettings(existingTarget)
}

/** Reload one session's settings state and every settings panel after a save. */
function refreshSessionSettings(session, deviceKey) {
  const view = settingsViewFor(deviceKey)
  session.updateManager.settings = view
  session.updateManager.reloadComponents()
  broadcastSession(session)
  for (const attached of session.windows) attached.setupDialog.reload()
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
  if (workspace.session === null) return '待连接'
  return terminalLabel(settingsViewFor(workspace.deviceKey))
}

function workspaceTitle(workspace) {
  if (workspace.session === null) return 'DSH-[' + '待连接' + ']'
  const url = workspace.session.connection.url()
  return 'DSH-[' + workspaceTerminal(workspace) + ']-' + url
}

function sendWorkspaceState(workspace) {
  if (workspace.window === null || workspace.window.isDestroyed()) return
  const session = workspace.session
  const status = session === null ? idleStatus() : session.connection.status
  const task = sessionTask(session)
  const hasOpenWindow = session === null
    ? boundWorkspaceFor(candidateDeviceKey(), workspace) !== null
    : false
  workspace.window.webContents.send('shell:state', {
    view: workspace.activeView,
    terminal: workspaceTerminal(workspace),
    detached: session === null,
    hasOpenWindow,
    status: status.detail,
    connState: status.state,
    task,
    harnessReady: workspace.harnessReady,
    loadError: workspace.loadError,
    progress: workspace.progress,
    theme: currentTheme(),
  })
}

/**
 * Keep the harness view visible only when it is front-most, its page has
 * finished loading, AND the connection reports ready. Connecting,
 * restarting and error states hide the web view so the shell frame can
 * never show a white or stale page.
 */
function updateHarnessVisibility(workspace) {
  if (workspace.window === null || workspace.window.isDestroyed()) return
  const ready = workspace.session !== null
    && workspace.session.connection.status.state === 'ready'
  const show = workspace.activeView === 'harness'
    && ready && workspace.harnessReady && workspace.progress === null
  workspace.harnessView.setVisible(show)
  if (show) workspace.harnessView.webContents.focus()
  sendWorkspaceState(workspace)
}

/**
 * Set the blocking progress banner shown by the loading panel in place
 * of the harness view. Progress is owned by the SESSION so every window
 * attached to a busy terminal (including one attached mid-update) sees
 * the same state instead of a stale or white harness page.
 */
function setProgress(workspace, progress) {
  workspace.progress = progress
  if (workspace.session === null) {
    updateHarnessVisibility(workspace)
    return
  }
  workspace.session.progress = progress
  for (const other of workspace.session.windows) {
    other.progress = progress
    updateHarnessVisibility(other)
  }
}

/**
 * Point the harness view at a URL and keep it hidden until the page loads:
 * did-finish-load sets harnessReady and updateHarnessVisibility shows it.
 */
function loadHarnessUrl(workspace, url) {
  if (workspace.session === null) {
    workspace.loadedUrl = ''
    workspace.harnessReady = false
    workspace.loadError = ''
    workspace.harnessView.setVisible(false)
    sendWorkspaceState(workspace)
    return
  }
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
 * Show one top-level workspace view: harness or one settings section.
 * This is the single switch used by the shell frame, menus, tray, and
 * save flows. A detached window can show settings before any terminal
 * is selected; its harness tab stays on the waiting prompt.
 */
function setWorkspaceView(workspace, view) {
  if (!['harness', 'connection', 'updates'].includes(view)) view = 'harness'
  workspace.activeView = view
  if (view === 'harness') {
    workspace.setupDialog.close()
    const session = workspace.session
    const url = session === null ? '' : session.connection.url()
    if (session !== null && session.connection.status.state === 'ready' && url !== ''
      && (workspace.loadedUrl !== url || !workspace.harnessReady)) {
      loadHarnessUrl(workspace, url)
    } else {
      updateHarnessVisibility(workspace)
    }
  } else {
    workspace.harnessView.setVisible(false)
    const deviceKey = workspace.session === null ? candidateDeviceKey() : workspace.deviceKey
    workspace.setupDialog.setDeviceKey(deviceKey, view)
    workspace.setupDialog.open(view)
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
  win.loadFile(SHELL_HTML, { query: { theme: currentTheme() } })
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
  return workspace ?? activeWorkspace() ?? createInitialWorkspace()
}

function loadAppUrl(workspace) {
  if (workspace.session === null) return
  const session = workspace.session
  const url = session.connection.url()
  workspace.activeView = 'harness'
  workspace.setupDialog.close()
  loadHarnessUrl(workspace, url)
  if (windowManager !== null) windowManager.touch(workspace)
  refreshTrayAndMenu()
}

/**
 * Make the workspace's harness view follow one session WITHOUT changing the
 * active view and WITHOUT raising/focusing the window. When the user is on
 * connection/settings, the harness URL is prepared in the background so the
 * later click on Harness is instant; when the harness view is already
 * front-most, it loads/updates in place.
 */
function syncWorkspaceHarness(workspace, session) {
  workspace.pendingOpen = false
  if (session.connection.status.state !== 'ready') {
    updateHarnessVisibility(workspace)
    return
  }
  const url = session.connection.url()
  if (workspace.loadedUrl !== url || workspace.harnessReady === false) {
    loadHarnessUrl(workspace, url)
  } else {
    updateHarnessVisibility(workspace)
  }
}

function connectSession(session) {
  if (session.connecting) return session.connectionTaskPromise ?? Promise.resolve()
  session.connecting = true
  const task = Promise.resolve(session.connection.connect()).then(
    () => {
      session.connecting = false
      reconcileMachineIdentity(session)
      checkHostCompatibility(session)
    },
    () => { session.connecting = false },
  ).finally(() => {
    if (session.connectionTaskPromise === task) session.connectionTaskPromise = null
  })
  session.connectionTaskPromise = task
  return task
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

  const aliasSession = sessions.get(aliasKey)
  if (aliasSession !== undefined) {
    sessions.delete(aliasKey)
    const targetSessionExisting = sessions.get(targetKey)
    if (targetSessionExisting !== undefined && targetSessionExisting !== aliasSession) {
      // The canonical machine session already exists. One terminal keeps one
      // bound window: move alias windows over only when the target session has
      // no window yet; otherwise detach the alias windows back to choosers and
      // switch focus to the already-open machine window.
      let focusTarget = null
      for (const workspace of [...aliasSession.windows]) {
        aliasSession.windows.delete(workspace)
        if (targetSessionExisting.windows.size === 0) {
          workspace.deviceKey = targetKey
          workspace.session = targetSessionExisting
          workspace.progress = targetSessionExisting.progress
          targetSessionExisting.windows.add(workspace)
          if (targetSessionExisting.connection.status.state === 'ready') {
            workspace.pendingOpen = false
            loadHarnessUrl(workspace, targetSessionExisting.connection.url())
          } else {
            workspace.pendingOpen = true
            connectSession(targetSessionExisting)
          }
          if (workspace.window !== null && !workspace.window.isDestroyed()) {
            workspace.window.setTitle(workspaceTitle(workspace))
            sendWorkspaceState(workspace)
          }
        } else {
          // Same-terminal connection is only a WINDOW SWITCH: keep the current
          // window as a detached chooser instead of closing it, and focus the
          // window that was already bound to this machine.
          workspace.session = null
          workspace.deviceKey = null
          workspace.pendingOpen = false
          workspace.loadedUrl = ''
          workspace.harnessReady = false
          workspace.loadError = ''
          workspace.progress = null
          workspace.harnessView.setVisible(false)
          workspace.harnessView.webContents.loadURL('about:blank')
          setWorkspaceView(workspace, 'connection')
          focusTarget = [...targetSessionExisting.windows][0] ?? focusTarget
        }
      }
      if (focusTarget !== null) presentWorkspace(focusTarget)
      if (aliasSession.windows.size === 0) void abandonSession(aliasSession)
    } else {
      aliasSession.key = targetKey
      sessions.set(targetKey, aliasSession)
      for (const workspace of aliasSession.windows) workspace.deviceKey = targetKey
    }
  }
  // Reload the machine device's live settings state so a merge immediately
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

/** Find another LIVE window already bound to one terminal (VS Code-style single instance). */
function boundWorkspaceFor(deviceKey, excludeWorkspace = null) {
  const session = sessions.get(deviceKey)
  if (session !== undefined) {
    for (const workspace of session.windows) {
      if (workspace === excludeWorkspace) continue
      if (workspace.window === null || workspace.window.isDestroyed()) continue
      if (workspace.userClosed === true) continue
      if (workspace.deviceKey !== deviceKey) continue
      return workspace
    }
  }
  for (const workspace of workspaces.values()) {
    if (workspace === excludeWorkspace) continue
    if (workspace.deviceKey !== deviceKey) continue
    if (workspace.window === null || workspace.window.isDestroyed()) continue
    if (workspace.userClosed === true) continue
    return workspace
  }
  return null
}

/** Present one workspace and make it the active window. */
function presentWorkspace(workspace) {
  if (workspace === null || workspace.window === null || workspace.window.isDestroyed()) return workspace
  presentWindow(workspace.window)
  if (windowManager !== null) windowManager.markActive(workspace)
  return workspace
}

/**
 * For terminal-scoped menu/tray actions, a detached window is only a chooser:
 * when the candidate terminal is already open in another window, focus that
 * window instead of creating a second bound instance.
 */
/** Destroy closed ghost windows after the current window has bound the terminal. */
function destroyClosedTerminalWindows(session, keepWorkspace) {
  for (const other of [...session.windows]) {
    if (other !== keepWorkspace && other.userClosed === true) destroyWorkspaceWindow(other)
  }
}

/** Force-close one workspace window (its close handler normally hides). */
function destroyWorkspaceWindow(workspace) {
  const win = workspace.window
  if (win === null || win.isDestroyed()) {
    disposeWorkspace(workspace)
    return
  }
  win.destroy()
}

function openWorkspaceWindow(workspace) {
  const session = workspace.session
  if (session === null) return
  if (session.connection.status.state === 'ready') {
    syncWorkspaceHarness(workspace, session)
    return
  }
  workspace.pendingOpen = true
  connectSession(session)
}

/** The device the first/recovered window should bind to on launch. */
function defaultWorkspaceDeviceKey() {
  if (windowManager !== null) {
    const last = windowManager.lastActiveDeviceKey()
    if (settingsDocument.devices[last] !== undefined) return last
  }
  return candidateDeviceKey()
}

function deviceSettingsComplete(deviceKey) {
  const view = settingsViewFor(deviceKey)
  return view.mode === 'local' ? view.local.repoDir !== '' : view.ssh.host !== ''
}

/**
 * Create the startup/first window: bind to the current terminal and connect
 * it (initializing the harness when needed). Additional windows go through
 * actions.newWindow and start DETACHED instead.
 */
function createInitialWorkspace() {
  const deviceKey = defaultWorkspaceDeviceKey()
  const workspace = createWorkspace(deviceKey, { autoOpen: false })
  if (deviceSettingsComplete(deviceKey)) startWithSettings(workspace)
  else setWorkspaceView(workspace, 'connection')
  return workspace
}

function createWorkspace(deviceKey = null, options = {}) {
  const detached = deviceKey === null
  const session = detached ? null : sessionFor(deviceKey)
  const boundsKey = detached ? candidateDeviceKey() : deviceKey
  const bounds = windowManager === null ? null : windowManager.boundsFor(boundsKey)
  const win = createBrowserWindow(bounds)
  const harnessView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  win.contentView.addChildView(harnessView)
  harnessView.setVisible(false)
  harnessView.webContents.on('page-title-updated', event => event.preventDefault())
  harnessView.webContents.loadURL('about:blank')

  const workspace = {
    id: nextWorkspaceId,
    deviceKey,
    session,
    window: win,
    harnessView,
    setupDialog: new SetupDialog(win, { getTheme: () => currentTheme() }),
    pendingOpen: session !== null,
    activeView: options.initialView !== undefined ? options.initialView : 'harness',
    loadedUrl: '',
    harnessReady: false,
    loadError: '',
    progress: session === null ? null : session.progress,
    // True while the user closed this window with the red button. Closed
    // windows remain alive for Dock restore, but must NOT count as the
    // terminal's open window for same-terminal save/switch decisions.
    userClosed: false,
  }
  nextWorkspaceId += 1
  workspaces.set(workspace.id, workspace)
  if (session !== null) session.windows.add(workspace)
  win.setTitle(workspaceTitle(workspace))

  win.once('ready-to-show', () => {
    layoutWorkspaceViews(workspace)
    sendWorkspaceState(workspace)
    if (windowManager !== null) windowManager.touch(workspace)
    win.show()
    refreshTrayAndMenu()
    if (options.initialView !== undefined) {
      setWorkspaceView(workspace, options.initialView)
    } else if (options.autoOpen !== false) {
      openWorkspaceWindow(workspace)
    }
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
    if (workspace.session !== null
      && workspace.activeView === 'harness'
      && workspace.harnessView !== null
      && !workspace.harnessView.webContents.isDestroyed()) {
      workspace.harnessView.webContents.focus()
    }
  })
  win.on('show', () => {
    workspace.userClosed = false
    refreshTrayAndMenu()
  })
  win.on('close', event => {
    if (!quitting) {
      event.preventDefault()
      workspace.userClosed = true
      if (windowManager !== null) windowManager.touch(workspace)
      win.hide()
      refreshTrayAndMenu()
    }
  })
  win.on('closed', () => disposeWorkspace(workspace))
  win.webContents.on('did-fail-load', (_event, code, description) => {
    if (session !== null) {
      session.connection.log('[window] frame load failed ' + code + ' ' + description)
    }
  })
  harnessView.webContents.on('did-start-loading', () => {
    if (workspace.loadedUrl === '') return
    workspace.harnessReady = false
    updateHarnessVisibility(workspace)
  })
  harnessView.webContents.on('did-finish-load', () => {
    if (workspace.loadedUrl === '') return
    workspace.harnessReady = true
    workspace.loadError = ''
    updateHarnessVisibility(workspace)
  })
  harnessView.webContents.on('did-fail-load', (_event, code, description) => {
    if (code === -3) return
    workspace.harnessReady = false
    workspace.loadError = description
    if (session !== null) {
      session.connection.log('[window] load failed ' + code + ' ' + description)
    }
    updateHarnessVisibility(workspace)
  })

  return workspace
}

function disposeWorkspace(workspace) {
  const session = workspace.session
  if (windowManager !== null) windowManager.touch(workspace)
  if (session !== null) session.windows.delete(workspace)
  workspace.setupDialog.close()
  for (const view of [workspace.harnessView, workspace.setupDialog.view]) {
    if (view !== null && view !== undefined && !view.webContents.isDestroyed()) {
      try {
        view.webContents.close()
      } catch {
      }
    }
  }
  workspace.window = null
  workspaces.delete(workspace.id)
  // Cancel in-flight work and release locks before tearing down an orphaned
  // remote session. Local sessions stay resident; a detached artifact worker
  // keeps running and the next local window observes its status.
  if (session !== null && session.windows.size === 0 && quitting === false) void abandonSession(session)
  refreshTrayAndMenu()
}

/** Move a workspace to another device session (or out of the detached state). */
function attachWorkspace(workspace, deviceKey) {
  if (workspace.session !== null && workspace.deviceKey === deviceKey) return workspace.session
  const previous = workspace.session
  if (previous !== null) {
    previous.windows.delete(workspace)
    // Do not stop/cancel here: save flows cancel busy work and abandon the
    // previous session only after the new binding is in place.
  }

  const session = sessionFor(deviceKey)
  workspace.deviceKey = deviceKey
  workspace.session = session
  workspace.pendingOpen = true
  workspace.loadedUrl = ''
  workspace.harnessReady = false
  workspace.loadError = ''
  workspace.progress = session.progress
  session.windows.add(workspace)
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
  const url = session.connection.url()
  for (const workspace of session.windows) {
    if (workspace.window === null || workspace.window.isDestroyed()) continue
    // Reload the CURRENT service URL, not whatever the harness view happened
    // to have committed. A restart may move the service to a new OS-chosen
    // port (`--port 0`), and reloadIgnoringCache() would re-request the stale
    // URL — a dead page that surfaces as a white harness view and, for a
    // window created mid-update, leaves its WebContentsView in a reload loop
    // that swallows the shell frame's top button clicks. loadHarnessUrl re-
    // hides the view and shows the loading panel until did-finish-load, so
    // every window (including one born from about:blank) settles on the right
    // page instead of staying stuck.
    workspace.pendingOpen = false
    // If the status event already started this exact URL, don't abort that
    // navigation with a second loadURL call. Same-URL loads only happen when
    // the page is actually settled and this is an explicit post-update reload.
    const inFlight = workspace.loadedUrl === url
      && workspace.harnessReady === false
      && workspace.loadError === ''
    if (inFlight === false) loadHarnessUrl(workspace, url)
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
  if (workspace === null) return settingsViewFor(candidateDeviceKey())
  const view = settingsViewFor(workspace.deviceKey)
  return workspace.session === null ? { ...view, detached: true } : view
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

/**
 * macOS Dock right-click menu. Do NOT add our own window list here: macOS
 * already renders the native window list above this custom menu, and adding
 * the workspaces again produced two groups (native titles with URLs + our
 * terminal-only labels).
 */
function refreshDockMenu() {
  if (app.dock === undefined || app.dock === null) return
  try {
    app.dock.setMenu(Menu.buildFromTemplate([
      { label: '打开 Harness', click: () => actions.openMain() },
      { type: 'separator' },
      { label: '新建窗口', click: () => actions.newWindow() },
    ]))
  } catch {
    // Dock menu is cosmetic on macOS.
  }
}

function refreshTrayAndMenu() {
  if (trayController !== null) trayController.update(activeStatus(), activeSettingsView())
  refreshMenu()
  refreshDockMenu()
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
    workspace.setupDialog.send('dialog:live', {
      state: status.state,
      url: status.url,
      detail: status.detail,
    })
    if (status.state === 'ready' && workspace.pendingOpen) {
      // Do not yank the user out of connection/settings and do not raise a
      // background window: sync the harness URL in the current view context.
      syncWorkspaceHarness(workspace, session)
    } else if (status.state === 'ready' && workspace.loadedUrl !== '' && workspace.loadedUrl !== status.url) {
      // A restarted service may report a new OS-chosen port. Reload in place
      // without yanking focus from the window the user is actually using.
      loadHarnessUrl(workspace, status.url)
    } else {
      updateHarnessVisibility(workspace)
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
    buttons: ['打开设置', '稍后'],
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
      await trackSessionTask(session, session.updateManager.checkAll())
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
async function finishManagedUpdate(workspace, session, outcome) {
  if (outcome.ok && outcome.restarted) reloadSessionWindows(session)
  broadcastSession(session)
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

/** Connection-relevant parts of two normalized device documents. */
function sameDeviceConfig(a, b) {
  if (a.mode !== b.mode) return false
  if (a.mode === 'local') {
    return a.local.repoDir === b.local.repoDir
      && a.local.repoUrl === b.local.repoUrl
      && a.local.dshHome === b.local.dshHome
  }
  return a.ssh.host === b.ssh.host
    && a.ssh.remoteRepoUrl === b.ssh.remoteRepoUrl
    && a.ssh.remoteRepoDir === b.ssh.remoteRepoDir
    && a.ssh.remotePort === b.ssh.remotePort
    && a.ssh.localPort === b.ssh.localPort
}

/** Run initialization when needed, tracked so a window switch can cancel it. */
function startWithSettings(workspace) {
  if (workspace.session === null) return Promise.resolve()
  return trackSessionTask(workspace.session, startWithSettingsInner(workspace))
}

/** Run the initialization build when needed, then connect one workspace. */
async function startWithSettingsInner(workspace) {
  if (workspace.session === null) return
  const session = workspace.session
  let built = false
  try {
    built = await session.connection.isBuilt()
  } catch (error) {
    // The build check needs connectivity (ssh test for remote mode). When it
    // cannot even reach the host, connect() surfaces the real failure with a
    // proper dialog instead of a pointless build pipeline.
    session.connection.log(`构建检查失败：${error.message}`)
    if (workspace.session !== session) return
    syncWorkspaceHarness(workspace, session)
    workspace.pendingOpen = true
    connectSession(session)
    return
  }
  if (workspace.session !== session) return
  if (built === false) {
    const busyMessage = busyTaskMessage(session)
    if (busyMessage !== '') {
      syncWorkspaceHarness(workspace, session)
      setProgress(workspace, {
        title: '初始化构建',
        status: `${busyMessage} 稍后请从「更新 → 仅更新 Harness」重试。`,
      })
      return
    }
    syncWorkspaceHarness(workspace, session)
    // Phase 2/3: official artifact first — no checkout, no build, and the
    // worker survives shell quit.
    const usedWorker = await startArtifactUpdateIfPossible(session)
    if (workspace.session !== session) return
    if (usedWorker) {
      setProgress(workspace, { title: '初始化（官方产物）', status: '正在后台下载官方预构建版…' })
      return
    }
    setProgress(workspace, {
      title: '初始化构建',
      status: '首次使用：确保仓库 → 工具链引导 → pnpm install → pnpm run build → 启动服务',
    })
    const outcome = await session.updater.runPipeline({ includePull: true, toleratePullFailure: true })
    if (workspace.session !== session) return
    if (outcome.ok === false) {
      setProgress(workspace, {
        title: '初始化构建',
        status: '构建失败。可修复后重试（日志已写入文件）。',
        actions: [{ label: '重试', name: 'run-init', primary: true }],
      })
      return
    }
    setProgress(workspace, null)
  }
  if (workspace.session !== session) return
  syncWorkspaceHarness(workspace, session)
  workspace.pendingOpen = true
  connectSession(session)
}

function runInit(workspace) {
  if (workspace.session === null) return Promise.resolve()
  return trackSessionTask(workspace.session, runInitInner(workspace))
}

async function runInitInner(workspace) {
  if (workspace.session === null) return
  const session = workspace.session
  if (canStartBusyTask(session) === false) return
  const usedWorker = await startArtifactUpdateIfPossible(session)
  if (workspace.session !== session) return
  if (usedWorker) {
    setProgress(workspace, { title: '初始化（官方产物）', status: '正在后台下载官方预构建版…' })
    return
  }
  setProgress(workspace, { title: '初始化构建', status: '执行中…' })
  const outcome = await session.updater.runPipeline({ includePull: true, toleratePullFailure: true })
  if (workspace.session !== session) return
  if (outcome.ok) {
    setProgress(workspace, null)
    syncWorkspaceHarness(workspace, session)
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
  // The detached artifact worker is also a per-terminal task: another update
  // must not race it, but a same-config save may still attach to its progress.
  if (session.workerPollTimer !== null) return true
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
    // Additional windows are intentionally DETACHED: no session, no
    // auto-connect. They open on the connection page and bind only after
    // the user saves a terminal. This keeps a window created mid-update
    // completely out of the restarting harness view tree.
    return createWorkspace(null, { initialView: 'connection' })
  },

  openMain(workspace) {
    const target = withWorkspace(workspace)
    if (target.session === null) {
      setWorkspaceView(target, 'connection')
      presentWindow(target.window)
      return target
    }
    if (target.session.connection.status.state !== 'ready') {
      dialog.showErrorBox('尚未连接', '当前状态：' + target.session.connection.status.detail + '\n\n可在「连接 → 重新连接」或「连接设置」中处理。')
      return target
    }
    setWorkspaceView(target, 'harness')
    presentWindow(target.window)
    return target
  },

  openSettings(workspace) {
    const target = withWorkspace(workspace)
    setWorkspaceView(target, 'connection')
    presentWindow(target.window)
    return target
  },

  openUpdates(workspace, focus = true) {
    const target = withWorkspace(workspace)
    if (target.session === null) {
      setWorkspaceView(target, 'connection')
      if (focus !== false) presentWindow(target.window)
      return target
    }
    setWorkspaceView(target, 'updates')
    broadcastSession(target.session)
    if (focus !== false) presentWindow(target.window)
    return target
  },

  reconnect(workspace) {
    const target = withWorkspace(workspace)
    if (target.session === null) {
      setWorkspaceView(target, 'connection')
      presentWindow(target.window)
      return target
    }
    if (!canStartBusyTask(target.session)) return target
    target.session.autoReconnectAttempts = 0
    target.pendingOpen = true
    connectSession(target.session)
  },

  async resetBackend(workspace) {
    const target = withWorkspace(workspace)
    if (target.session === null) {
      setWorkspaceView(target, 'connection')
      presentWindow(target.window)
      return target
    }
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
    if (target.session === null) {
      setWorkspaceView(target, 'connection')
      presentWindow(target.window)
      return target
    }
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
    const target = actions.openUpdates(workspace, false)
    if (target.session === null) {
      setWorkspaceView(target, 'connection')
      presentWindow(target.window)
      return target
    }
    if (!canStartBusyTask(target.session)) return target
    const session = target.session
    try {
      await trackSessionTask(session, session.updateManager.checkAll())
    } catch (error) {
      routeSessionLine(session, `✗ 检查更新失败：${String(error.message || error)}`)
    }
    broadcastSession(session)
  },

  async updateAll(workspace) {
    const target = actions.openUpdates(workspace, false)
    if (target.session === null) {
      setWorkspaceView(target, 'connection')
      presentWindow(target.window)
      return target
    }
    if (!canStartBusyTask(target.session)) return target
    const session = target.session
    routeSessionLine(session, '\n==> 更新 Harness')
    try {
      const outcome = await trackSessionTask(session, session.updateManager.updateAll())
      await finishManagedUpdate(target, session, outcome)
    } catch (error) {
      routeSessionLine(session, `✗ 更新 Harness 失败：${String(error.message || error)}`)
      broadcastSession(session)
    }
  },

  async updateAndRestart(workspace) {
    const target = withWorkspace(workspace)
    if (target.session === null) {
      setWorkspaceView(target, 'connection')
      presentWindow(target.window)
      return target
    }
    if (!canStartBusyTask(target.session)) return target

    const task = trackSessionTask(target.session, (async () => {
      const session = target.session
      // Phase 2/3: local official-artifact updates go through the detached
      // worker: no source checkout, no pnpm build, survives shell quit.
      const usedWorker = await startArtifactUpdateIfPossible(session)
      if (target.session !== session) return
      if (usedWorker) {
        setProgress(target, { title: '更新并重启（官方产物）', status: '正在后台下载官方预构建版…' })
        return
      }
      setProgress(target, { title: '更新并重启', status: '执行中…' })
      const outcome = await session.updater.runPipeline({ includePull: true })
      if (target.session !== session) return
      if (outcome.ok) {
        reloadSessionWindows(session)
        setProgress(target, null)
      } else {
        const diagnosis = await diagnoseFailure(session)
        setProgress(target, {
          title: '更新失败',
          status: `${String(outcome.error?.message || outcome.error)}\n\n${diagnosis}`,
          actions: [
            { label: '重试', name: 'run-update', primary: true },
            { label: '放弃', name: 'dismiss-progress' },
          ],
        })
      }
      refreshMenu()
    })())
    await task
    return target
  },

  async openLogs(workspace) {
    const target = withWorkspace(workspace)
    if (target.session === null) {
      setWorkspaceView(target, 'connection')
      presentWindow(target.window)
      return target
    }
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
      applicationName: 'dsh-mac-desktop',
      applicationVersion: `v${SHELL_VERSION}`,
      credits: [
        'dsh-mac-desktop — DeepSeek Harness 的 macOS 桌面壳',
        '',
        '· 本地 / SSH 远程静默部署并自动升级 harness 驻留程序',
        '· 多窗口（VS Code Remote 风格），每个窗口可切换任意 SSH 终端',
        '· 官方预构建产物优先更新，版本化运行时原子切换 + 自动回滚',
        '',
        'https://github.com/svengong/dsh-mac-desktop',
      ].join('\n'),
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
    // children, including in-flight build processes (killActiveChildren).
    quitting = true
    app.quit()
  },
}

// ── dialog IPC handlers ─────────────────────────────────────────────────────

function registerIpc() {
  registerDialogIpc({
    getState(event) {
      const workspace = workspaceForEvent(event) ?? withWorkspace(null)
      const detached = workspace.session === null
      const deviceKey = detached ? candidateDeviceKey() : workspace.deviceKey
      const view = settingsViewFor(deviceKey)
      const tools = resolveTools(view)
      const live = detached ? idleStatus() : workspace.session.connection.status
      return {
        settings: view,
        terminal: detached ? '待连接' : terminalLabel(view),
        sshHosts: listSshHosts(),
        theme: currentTheme(),
        live: {
          state: live.state,
          url: live.url,
          detail: live.detail,
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
      const candidate = normalizeSettings(rawSettings)
      const error = validateSettings(candidate)
      if (error !== null) return { ok: false, error }

      // Resolve the machine identity the form alone cannot carry: the saved
      // device key for this workspace, or an already-merged machine device
      // that has the same SSH host. Without this a detached window would
      // re-key machine:<id> back to ssh:<host> and split the terminal.
      const detached = workspace.session === null
      const currentKey = detached ? candidateDeviceKey() : workspace.deviceKey
      let currentDevice = settingsDocument.devices[currentKey]
      if (candidate.mode === 'ssh') {
        const byHost = Object.values(settingsDocument.devices).find(device =>
          device.mode === 'ssh' && device.ssh.host === candidate.ssh.host && device.machineId !== '')
        if (byHost !== undefined) currentDevice = byHost
      }
      const keepMachineId = currentDevice !== undefined
        && currentDevice.mode === 'ssh'
        && currentDevice.ssh.host === candidate.ssh.host
        && currentDevice.machineId !== ''
      const machineId = keepMachineId ? currentDevice.machineId : ''
      const deviceKey = deviceKeyOf({ ...candidate, machineId })

      const targetSession = sessions.get(deviceKey) ?? null
      const existingDevice = settingsDocument.devices[deviceKey]
      const targetUnchanged = existingDevice !== undefined && sameDeviceConfig(existingDevice, candidate)
      const targetBusy = targetSession !== null && isSessionBusy(targetSession)
      const previous = workspace.session
      const switchingAway = previous !== null && deviceKey !== workspace.deviceKey

      // One bound window per terminal. The CURRENT window always stays: when
      // the target terminal already has another window, the current window
      // binds in place and the other duplicate windows are closed. The view
      // and focus of the current window do not change.
      const duplicate = boundWorkspaceFor(deviceKey, workspace)
      if (duplicate !== null) {
        if (targetBusy && targetUnchanged === false) {
          return { ok: false, error: busyTaskMessage(targetSession) }
        }
        persistConnectionCandidate(deviceKey, candidate, machineId)
        refreshSessionSettings(duplicate.session, deviceKey)
        openExistingTerminalWindow(duplicate, targetBusy, targetUnchanged)
        // The current window stays exactly as it was (usually a detached
        // chooser or another terminal). Connecting to an already-open
        // terminal is only a window switch, never a close/rebind.
        return { ok: true }
      }

      // Target terminal has no bound window yet.
      if (targetBusy) {
        if (targetUnchanged === false) {
          return { ok: false, error: busyTaskMessage(targetSession) }
        }
        const session = attachWorkspace(workspace, deviceKey)
        refreshSessionSettings(session, deviceKey)
        destroyClosedTerminalWindows(session, workspace)
        if (windowManager !== null) windowManager.markActive(workspace)
        if (previous !== null && switchingAway) void abandonSession(previous)
        return { ok: true }
      }

      persistConnectionCandidate(deviceKey, candidate, machineId)
      const session = attachWorkspace(workspace, deviceKey)
      refreshSessionSettings(session, deviceKey)
      destroyClosedTerminalWindows(session, workspace)
      if (windowManager !== null) windowManager.markActive(workspace)
      // Never block the switch: cancel/abandon the previous terminal in the
      // background. Its old service keeps running and the task can be retried
      // later from that terminal's single window.
      if (previous !== null && switchingAway) void abandonSession(previous)
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
      if (workspace.session === null) {
        const view = settingsViewFor(candidateDeviceKey())
        return {
          detached: true,
          busy: false,
          autoCheckOnLaunch: view.update?.autoCheckOnLaunch === false ? false : true,
          lastCheckAt: view.update?.lastCheckAt ?? '',
          components: [],
          available: [],
        }
      }
      return workspace.session.updateManager.snapshot()
    },

    updatesGetLog(event) {
      const workspace = workspaceForEvent(event) ?? withWorkspace(null)
      if (workspace.session === null) {
        return '当前窗口尚未连接终端。请先在「连接」中选择并保存终端。'
      }
      // The panel is created lazily and may have missed every earlier line;
      // return the connection's bounded ring so the tab can show the latest
      // log immediately instead of starting with an empty console.
      return workspace.session.connection.dumpLog()
    },

    async updatesAction(event, name, payload = {}) {
      const workspace = workspaceForEvent(event) ?? withWorkspace(null)
      const session = workspace.session
      const taskNames = ['check-all', 'check-one', 'update-one', 'update-all', 'restart-service']
      if (session === null) {
        if (name === 'close' || name === 'open-settings') {
          setWorkspaceView(workspace, name === 'close' ? 'harness' : 'connection')
          return { ok: true }
        }
        if (name === 'copy-log' || name === 'reveal-log') {
          // Global log helpers stay useful before a terminal is selected.
        } else {
          return { ok: false, error: '请先连接终端' }
        }
      }
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
            await trackSessionTask(session, session.connection.restartService())
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
            void trackSessionTask(session, session.updateManager.checkAll()).then(
              () => broadcastSession(session),
              error => {
                routeSessionLine(session, `✗ 检查更新失败：${String(error.message || error)}`)
                broadcastSession(session)
              },
            )
            break
          case 'check-one': {
            const id = String(payload?.id ?? '')
            void trackSessionTask(session, session.updateManager.checkOne(id)).then(
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
            void trackSessionTask(session, session.updateManager.updateOne(id)).then(
              outcome => finishManagedUpdate(workspace, session, outcome),
              error => {
                routeSessionLine(session, `✗ 更新失败：${String(error.message || error)}`)
                broadcastSession(session)
              },
            )
            break
          }
          case 'update-all':
            void trackSessionTask(session, session.updateManager.updateAll()).then(
              outcome => finishManagedUpdate(workspace, session, outcome),
              error => {
                routeSessionLine(session, `✗ 更新 Harness 失败：${String(error.message || error)}`)
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
      case 'focus-terminal-window': {
        const target = workspace.session === null
          ? boundWorkspaceFor(candidateDeviceKey(), workspace)
          : workspace
        if (target === null) break
        presentWorkspace(target)
        setWorkspaceView(target, 'harness')
        break
      }
      case 'open-connection':
        setWorkspaceView(workspace, 'connection')
        break
      case 'run-init':
        void runInit(workspace)
        break
      case 'run-update':
        void actions.updateAndRestart(workspace)
        break
      case 'dismiss-progress':
        setProgress(workspace, null)
        break
      default:
        return { ok: false, error: `未知动作：${name}` }
    }
    return { ok: true }
  })

  // Appearance: select + persist a shell theme, re-skinning every live surface.
  ipcMain.handle('theme:set', (_event, theme) => setTheme(theme))
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
  await check('runner owner cancellation', async () => {
    const task = runCommand({ cmd: '/bin/sleep', args: ['30'], owner: 'smoke-owner' })
    await new Promise(resolve => setTimeout(resolve, 250))
    if (cancelOwnedChildren('smoke-owner', 'SIGTERM') === 0) throw new Error('owner child not tracked')
    const result = await task
    if (result.code === null && result.signal === 'SIGTERM') return
    throw new Error('owner child was not cancelled: ' + JSON.stringify(result))
  })
  await check('session task cancellation', async () => {
    const fakeSession = { key: 'smoke-session', owner: () => 'session:smoke-session', taskPromise: null, connectionTaskPromise: null, windows: new Set(), progress: null }
    const child = runCommand({ cmd: '/bin/sleep', args: ['30'], owner: fakeSession.owner() })
    trackSessionTask(fakeSession, child)
    await new Promise(resolve => setTimeout(resolve, 250))
    await cancelSessionTask(fakeSession)
    if (fakeSession.taskPromise !== null) throw new Error('session task promise did not settle after cancel')
    const result = await child
    if (result.code === null && result.signal === 'SIGTERM') return
    throw new Error('session child was not cancelled: ' + JSON.stringify(result))
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
    for (const label of ['设置…', '检查更新…', '更新 Harness…']) {
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
    const workspace = activeWorkspace() ?? createInitialWorkspace()
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
    // Pin the native chrome (traffic lights / scrollbars) to the selected
    // theme before the first window paints, so a light theme never flashes
    // white traffic lights on a light frame.
    applyNativeTheme(currentTheme())
    windowManager = new WindowManager(path.join(app.getPath('userData'), 'window-state.json'))

    // Migrate the pre-scoping shared tunnel state once per launch. Tunnels
    // are rebuilt by each session on connect; this prevents a new alias from
    // killing another alias's live tunnel later.
    runtimeStore.reapLegacyLocalTunnelState(settingsViewFor('local'))

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

    refreshTrayAndMenu()

    // The FIRST window binds to the current terminal and connects (or starts
    // initialization). Additional windows are detached until the user saves a
    // terminal in their connection page.
    const first = createInitialWorkspace()

    // Phase 1: pick up an update the previous run left unfinished (killed
    // pipeline or a detached worker that finished while the shell was gone).
    resumePendingUpdate()

    app.on('activate', (_event, hasVisibleWindows) => {
      flashDockIconPress()
      // macOS already fronts a visible window on dock activation; the shell
      // only needs to recover hidden/minimized windows or recreate one.
      if (hasVisibleWindows) return
      const workspace = activeWorkspace() ?? createInitialWorkspace()
      if (workspace.window === null || workspace.window.isDestroyed()) return
      if (presentWindow(workspace.window) === null) openWorkspaceWindow(workspace)
    })
  })

  app.on('before-quit', () => {
    // Killing a mid-flight build is safe: it only discards a staging directory
    // (rebuilt next run); the source checkout and running service are isolated
    // by the atomic `current`-symlink switch. So quit tears down children
    // directly instead of blocking on a busy gate. The registry kills every
    // child this shell spawned — including in-flight git/pnpm commands that
    // no session reference covers — so quitting never orphans a build or an
    // adopted service (both would otherwise keep running after exit).
    quitting = true
    if (windowManager !== null) windowManager.save()
    for (const session of sessions.values()) session.connection.stop()
    killActiveChildren()
  })

  app.on('window-all-closed', () => {
    // The tray keeps the app alive; quitting is explicit (Cmd+Q or tray).
  })
}