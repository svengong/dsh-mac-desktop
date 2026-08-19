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

/**
 * The shell-owned dsh home used for development/desktop service isolation.
 *
 * Development launches always use `~/.dsh-dev` (created on demand) so a dev
 * shell never touches the user's real `~/.dsh` or the installed app's data.
 */
const DEV_DEFAULT_DSH_HOME = '~/.dsh-dev'

/** Packaged builds must never point at a read-only path inside the .app. */
const IS_PACKAGED = typeof process.resourcesPath === 'string' && process.resourcesPath !== ''

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
  local: Object.freeze({ repoDir: DEFAULT_LOCAL_REPO_DIR, repoUrl: '', dshHome: DEV_DEFAULT_DSH_HOME, port: 3080 }),
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
  toolPaths: Object.freeze({ node: '', git: '', pnpm: '', shell: '/bin/zsh' }),
})

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
    // The instance's OWN dsh home: completely separate from any other dsh
    // process on the machine (no shared sessions/settings/profiles), so two
    // live instances can never corrupt each other's session store.
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
  return {
    node: text(source.node),
    git: text(source.git),
    pnpm: text(source.pnpm),
    shell: text(source.shell) || DEFAULTS.toolPaths.shell,
  }
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
  DEFAULT_LOCAL_REPO_URL,
  OFFICIAL_REPO_URL,
  DEFAULTS,
  defaultDevice,
  deviceKeyOf,
  normalizeDevice,
  normalizeSettings,
  SettingsStore,
}
