'use strict'

/**
 * Settings persistence for the desktop shell.
 *
 * The settings file lives in the Electron userData directory
 * (`~/Library/Application Support/DeepSeek Harness/settings.json` in packaged
 * builds; `~/.dsh-dev/settings.json` during development). It is scoped per
 * target device: `devices` maps a device key (`local`, or `ssh:<host>`) to
 * that device's connection fields and update-manager settings. The in-memory
 * normalized document also exposes the active device's `mode` / `local` /
 * `ssh` / `update` at the top level so the rest of the shell keeps reading
 * the same shape it always read.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { normalizeUpdate } = require('./components')
const { IS_WINDOWS } = require('./platform')
const { defaultLoginShell } = require('./tools')

/**
 * Development launches keep their own dsh home so a dev shell never touches
 * the installed app's data or the user's real `~/.dsh`.
 */
const DEV_DEFAULT_DSH_HOME = '~/.dsh-dev'

/**
 * Installed builds default to the official CLI's home, so the desktop app and
 * a terminal `dsh` share one workspace (sessions, settings, profiles,
 * credentials). `~/.dsh` is created on demand by the harness.
 */
const PACKAGED_DEFAULT_DSH_HOME = '~/.dsh'

/**
 * Whether this process runs inside a PACKAGED Electron app.
 *
 * `process.resourcesPath` exists in dev too (it points into
 * `node_modules/electron/dist`), so it cannot distinguish the two. Electron
 * sets `process.defaultApp` only when the app is passed as a parameter to the
 * stock executable (`electron .`); a packaged bundle leaves it undefined.
 * Plain node (tests, scripts) is treated as dev.
 */
const IS_ELECTRON = typeof process.versions === 'object' && typeof process.versions.electron === 'string'
const IS_PACKAGED = IS_ELECTRON && process.defaultApp !== true

/** The default dsh home for a build kind (packaged vs development). */
function defaultDshHome(packaged) {
  return packaged ? PACKAGED_DEFAULT_DSH_HOME : DEV_DEFAULT_DSH_HOME
}

/** The dsh home this build starts from, before any persisted setting. */
const DEFAULT_DSH_HOME = defaultDshHome(IS_PACKAGED)

/** The harness checkout lives inside the shell product directory in dev. */
const DEFAULT_LOCAL_REPO_DIR = IS_PACKAGED
  ? path.join(os.homedir(), 'deepseek-harness')
  : path.join(__dirname, '..', 'deepseek-harness')

/** The official harness repository (packaging-independent). */
const OFFICIAL_REPO_URL = 'https://github.com/deepseek-ai/deepseek-harness.git'

/** A fresh packaged install can clone the official repo without first-run setup. */
const DEFAULT_LOCAL_REPO_URL = IS_PACKAGED
  ? OFFICIAL_REPO_URL
  : ''

/** Defaults every device entry is normalized against. */
const DEVICE_DEFAULTS = Object.freeze({
  mode: 'local',
  local: Object.freeze({ repoDir: DEFAULT_LOCAL_REPO_DIR, repoUrl: '', dshHome: DEFAULT_DSH_HOME, port: 3080 }),
  ssh: Object.freeze({
    host: '',
    remoteRepoUrl: '',
    remoteRepoDir: '~/deepseek-harness',
    remotePort: 3080,
    localPort: 3080,
  }),
})

const DEFAULTS = Object.freeze({
  activeDeviceId: 'local',
  // The login shell is only used to FIND tools (a Finder/Dock launch has a
  // minimal PATH). Windows has no login shell; tools.js searches PATH,
  // PowerShell's own resolution and the usual install dirs there instead.
  toolPaths: Object.freeze({ node: '', git: '', pnpm: '', shell: defaultLoginShell() }),
})

/**
 * Selectable shell themes. The shell's own chrome (workspace frame, settings
 * panel, loading screen) is styled by these; the harness web app keeps its own
 * appearance. `default` follows the system light/dark appearance (resolving to
 * liquid-glass ↔ liquid-glass-dark); the others pin a fixed look. The ids are
 * mirrored by `:root[data-theme="…"]` blocks in `ui/shell.css` and by the
 * Appearance picker in `ui/settings.html`.
 */
const THEMES = Object.freeze(['default', 'ios-flat', 'ios-flat-dark', 'liquid-glass', 'liquid-glass-dark'])
const DEFAULT_THEME = 'default'

/** Appearance each theme pins on the native chrome (traffic lights, scrollbars). */
const THEME_APPEARANCE = Object.freeze({
  default: 'system',
  'ios-flat': 'light',
  'ios-flat-dark': 'dark',
  'liquid-glass': 'light',
  'liquid-glass-dark': 'dark',
})

/** Narrow any wire/persisted value to a valid theme id. */
function normalizeTheme(raw) {
  return THEMES.includes(raw) ? raw : DEFAULT_THEME
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function portOf(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 1 && number <= 65535 ? number : fallback
}

function normalizeLocal(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    repoDir: text(source.repoDir) || DEFAULT_LOCAL_REPO_DIR,
    // Optional git URL: cloned into repoDir when it is missing or not a git repo.
    repoUrl: text(source.repoUrl).trim() || DEFAULT_LOCAL_REPO_URL,
    // The instance's dsh home. Packaged builds default to the official
    // `~/.dsh` so desktop and terminal share one workspace; dev builds and
    // custom values stay separate from any other dsh process on the machine
    // (no shared sessions/settings/profiles), so instances cannot corrupt
    // each other's session store.
    dshHome: text(source.dshHome).trim() || DEVICE_DEFAULTS.local.dshHome,
    port: portOf(source.port, DEVICE_DEFAULTS.local.port),
  }
}

function normalizeSsh(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    // `host` is a ~/.ssh/config alias or a custom `[user@]host[:port]`;
    // the pre-alias `target` key is migrated on load.
    host: text(source.host).trim() || text(source.target).trim(),
    remoteRepoUrl: text(source.remoteRepoUrl).trim(),
    remoteRepoDir: text(source.remoteRepoDir).trim() || DEVICE_DEFAULTS.ssh.remoteRepoDir,
    remotePort: portOf(source.remotePort, DEVICE_DEFAULTS.ssh.remotePort),
    localPort: portOf(source.localPort, DEVICE_DEFAULTS.ssh.localPort),
  }
}

function normalizeToolPaths(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const shell = text(source.shell) || DEFAULTS.toolPaths.shell
  return {
    node: text(source.node),
    git: text(source.git),
    pnpm: text(source.pnpm),
    // A settings file carried over from another OS can name a shell that does
    // not exist here (`/bin/zsh` on Windows). Fall back to this platform's
    // default rather than spawning a path that can never resolve.
    shell: needsPlatformShell(shell) ? defaultLoginShell() : shell,
  }
}

/** Whether a persisted shell path belongs to a different OS. */
function needsPlatformShell(shell) {
  if (IS_WINDOWS) return shell.startsWith('/')
  return /^[A-Za-z]:[\\/]/.test(shell) || shell.toLowerCase().endsWith('.exe')
}

/** A fresh device document with no inherited update state. */
function defaultDevice(mode = 'local') {
  return {
    mode: mode === 'ssh' ? 'ssh' : 'local',
    machineId: '',
    local: normalizeLocal(undefined),
    ssh: normalizeSsh(undefined),
    update: normalizeUpdate(undefined),
  }
}

/**
 * Normalize one device document (connection fields + update section) against
 * the device defaults. A malformed device degrades to defaults instead of
 * crashing the shell.
 * @param {unknown} raw - persisted device document.
 * @returns {{mode: 'local'|'ssh', local: object, ssh: object, update: object}}
 */
function normalizeDevice(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    mode: source.mode === 'ssh' ? 'ssh' : 'local',
    // The remote machine identity, learned on first successful connection
    // from `~/.dsh/.desktop-machine-id`. Empty until the host is first reached.
    machineId: text(source.machineId).trim(),
    local: normalizeLocal(source.local),
    ssh: normalizeSsh(source.ssh),
    update: normalizeUpdate(source.update),
  }
}

/**
 * The storage key for a device document. The local device is a singleton;
 * every SSH target gets its own key derived from the host string.
 * @param {{mode?: string, ssh?: object}} device - normalized device fields.
 * @returns {string} storage key.
 */
function deviceKeyOf(device) {
  if (device.mode === 'ssh') {
    // The terminal identity is the remote machine, not the ssh alias: every
    // alias that reaches the same `~/.dsh` (e.g. `ubuntu` + `home4`) must
    // collapse onto one device so its update sources are shared. Before the
    // first connection reveals the machine id, the host alias is the fallback
    // key and is upgraded in place after connect.
    const machineId = typeof device.machineId === 'string' ? device.machineId.trim() : ''
    if (machineId !== '') return `machine:${machineId}`
    const host = typeof device.ssh?.host === 'string' ? device.ssh.host.trim() : ''
    return host === '' ? 'ssh' : `ssh:${host}`
  }
  return 'local'
}

/** Normalize the per-device map; keys are canonicalized from each device. */
function normalizeDevices(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const devices = {}
  for (const entry of Object.values(source)) {
    if (entry === null || typeof entry !== 'object') continue
    const device = normalizeDevice(entry)
    devices[deviceKeyOf(device)] = device
  }
  return devices
}

/**
 * Merge an arbitrary loaded document onto the defaults, keeping only valid
 * values. A malformed file therefore degrades to the defaults instead of
 * crashing the shell.
 *
 * The returned document has the active device's fields at top level AND the
 * full `devices` map, so consumers can read `settings.mode` / `settings.update`
 * directly while `SettingsStore.save` persists every device.
 */
function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const devices = normalizeDevices(source.devices)
  const toolPaths = normalizeToolPaths(source.toolPaths)

  let activeDeviceId = text(source.activeDeviceId)
  // A legacy document or an in-memory save carries the active device's fields
  // at top level; merge them into the map under their canonical key.
  const hasTopLevelDevice = typeof source.mode === 'string'
    || source.local !== undefined
    || source.ssh !== undefined
    || source.update !== undefined
  if (hasTopLevelDevice) {
    const active = normalizeDevice(source)
    activeDeviceId = deviceKeyOf(active)
    devices[activeDeviceId] = active
  } else {
    const keys = Object.keys(devices).sort()
    if (activeDeviceId === '' || devices[activeDeviceId] === undefined) {
      activeDeviceId = keys.length > 0 ? keys[0] : DEFAULTS.activeDeviceId
    }
    if (devices[activeDeviceId] === undefined) devices[activeDeviceId] = defaultDevice('local')
  }

  const active = devices[activeDeviceId]
  return {
    mode: active.mode,
    local: active.local,
    ssh: active.ssh,
    update: active.update,
    theme: normalizeTheme(source.theme),
    activeDeviceId,
    devices,
    toolPaths,
  }
}

class SettingsStore {
  constructor(filePath) {
    this.filePath = filePath
  }

  /** Load and normalize the persisted settings; defaults when absent or corrupt. */
  load() {
    let raw = null
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
    } catch {
      raw = null
    }
    return normalizeSettings(raw)
  }

  /** Persist normalized settings atomically (write tmp, then rename). */
  save(settings) {
    const normalized = normalizeSettings(settings)
    const document = {
      activeDeviceId: normalized.activeDeviceId,
      devices: normalized.devices,
      toolPaths: normalized.toolPaths,
      theme: normalized.theme,
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const tmpPath = `${this.filePath}.tmp`
    fs.writeFileSync(tmpPath, `${JSON.stringify(document, null, 2)}\n`)
    fs.renameSync(tmpPath, this.filePath)
    return normalized
  }
}

module.exports = {
  DEV_DEFAULT_DSH_HOME,
  PACKAGED_DEFAULT_DSH_HOME,
  DEFAULT_DSH_HOME,
  defaultDshHome,
  DEFAULT_LOCAL_REPO_URL,
  OFFICIAL_REPO_URL,
  DEFAULTS,
  THEMES,
  DEFAULT_THEME,
  THEME_APPEARANCE,
  normalizeTheme,
  defaultDevice,
  deviceKeyOf,
  normalizeDevice,
  normalizeSettings,
  SettingsStore,
}
