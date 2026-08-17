'use strict'

/**
 * Runtime state + advisory locks for DSH desktop services.
 *
 * The shell owns a small set of files per device:
 *
 * - local : `<dshHome>/desktop-web.state.json`  `{pid, port, version}`
 * - remote: `~/.dsh/desktop-web.state.json`, `desktop-web.pid`,
 *           `desktop-web.log`, and a transient `desktop-web.port` file used
 *           when the service is started with `--port 0`.
 *
 * State files are plain JSON and are the single source of truth for reusing
 * an already-running service. Locks use an atomically-created directory:
 * `mkdir` is atomic on both local filesystems and POSIX remotes, so clone and
 * build pipelines from two windows/app instances cannot interleave.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { shellQuote } = require('./ssh')

const LOCAL_STATE_FILE = 'desktop-web.state.json'
const REMOTE_STATE_FILE = '"$HOME"/.dsh/desktop-web.state.json'
const REMOTE_PID_FILE = '"$HOME"/.dsh/desktop-web.pid'
const REMOTE_LOG_FILE = '"$HOME"/.dsh/desktop-web.log'
const REMOTE_PORT_FILE = '"$HOME"/.dsh/desktop-web.port'

const RUNTIME_DIR = 'runtime'
const RUNTIME_MANIFEST = 'runtime.json'
const RUNTIME_ROOT_MANIFEST = 'manifest.json'
const CURRENT_LINK = 'current'
const MAX_RUNTIME_VERSIONS = 3

const LOCK_RETRY_MS = 250
const LOCK_TIMEOUT_MS = 5 * 60 * 1000
// Must exceed the 45-minute build timeout; a second instance can only reap a
// remote lock after the longest possible pipeline has safely timed out.
const REMOTE_LOCK_STALE_MS = 2 * 60 * 60 * 1000

function expandHome(dir) {
  if (dir === '~') return os.homedir()
  if (dir.startsWith('~/')) return path.join(os.homedir(), dir.slice(2))
  return dir
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** Parse the CLI's one-line bootstrap URL: `dsh web: http://127.0.0.1:<port>`. */
function parseDshWebUrl(line) {
  const match = /^dsh web:\s+(https?:\/\/\S+)/.exec(String(line ?? ''))
  if (match === null) return null
  try {
    const url = new URL(match[1])
    const port = Number(url.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    return { url: match[1], port, host: url.hostname }
  } catch {
    return null
  }
}

function isValidState(state) {
  return state !== null
    && typeof state === 'object'
    && Number.isInteger(state.pid)
    && Number.isInteger(state.port)
    && typeof state.version === 'string'
}

// ── local state ─────────────────────────────────────────────────────────────

function localStatePath(settings) {
  return path.join(expandHome(settings.local.dshHome), LOCAL_STATE_FILE)
}

function readLocalState(settings) {
  try {
    const state = JSON.parse(fs.readFileSync(localStatePath(settings), 'utf8'))
    return isValidState(state) ? state : null
  } catch {
    return null
  }
}

function writeLocalState(settings, state) {
  if (!isValidState(state)) return false
  try {
    const file = localStatePath(settings)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(state, null, 2))
    return true
  } catch {
    return false
  }
}

function removeLocalState(settings) {
  try {
    fs.rmSync(localStatePath(settings), { force: true })
  } catch {
    // Best-effort; a read-only home must not block reset.
  }
}

// ── remote state ────────────────────────────────────────────────────────────

async function readRemoteState(settings, remoteRun) {
  const result = await remoteRun(
    settings.ssh.host,
    `cat ${REMOTE_STATE_FILE} 2>/dev/null || echo __none__`,
    { timeoutMs: 15_000 },
  )
  if (result.code !== 0) return null
  const text = result.lines.join('\n').trim()
  if (text === '' || text === '__none__') return null
  try {
    const state = JSON.parse(text)
    return isValidState(state) ? state : null
  } catch {
    return null
  }
}

async function writeRemoteState(settings, remoteRun, state) {
  if (!isValidState(state)) return
  const safeVersion = String(state.version).replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64) || 'unknown'
  await remoteRun(
    settings.ssh.host,
    `printf '{"pid":%s,"port":%s,"version":"%s"}' "${state.pid}" "${state.port}" "${safeVersion}" > ${REMOTE_STATE_FILE}`,
    { timeoutMs: 15_000 },
  )
}

async function removeRemoteState(settings, remoteRun) {
  await remoteRun(
    settings.ssh.host,
    'rm -f "$HOME"/.dsh/desktop-web.pid "$HOME"/.dsh/desktop-web.state.json "$HOME"/.dsh/desktop-web.port 2>/dev/null || true',
    { timeoutMs: 15_000 },
  )
}

// ── versioned runtime directories ──────────────────────────────────────────
//
// A successful build is materialized under `<dshHome>/runtime/<version>` (or
// `~/.dsh/runtime/<version>` on the remote). `current` is a symlink switched
// only after the staged build finished, so a failed build never affects the
// running service. The previous version is retained for automatic/manual
// rollback and older versions are pruned.

function versionToken(version) {
  return String(version).replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 96) || 'unknown'
}

function localRuntimeRoot(settings) {
  return path.join(expandHome(settings.local.dshHome), RUNTIME_DIR)
}

function localVersionDir(settings, version) {
  return path.join(localRuntimeRoot(settings), versionToken(version))
}

function localCurrentLink(settings) {
  return path.join(localRuntimeRoot(settings), CURRENT_LINK)
}

function localStagingDir(settings, version) {
  return path.join(localRuntimeRoot(settings), `.staging-${process.pid}-${versionToken(version)}`)
}

function readLocalRootManifest(settings) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(localRuntimeRoot(settings), RUNTIME_ROOT_MANIFEST), 'utf8'))
    if (typeof manifest.current !== 'string') return { current: null, previous: null }
    return {
      current: typeof manifest.current === 'string' ? manifest.current : null,
      previous: typeof manifest.previous === 'string' ? manifest.previous : null,
    }
  } catch {
    return { current: null, previous: null }
  }
}

function writeLocalRootManifest(settings, manifest) {
  try {
    const root = localRuntimeRoot(settings)
    fs.mkdirSync(root, { recursive: true })
    const tmp = path.join(root, `.${RUNTIME_ROOT_MANIFEST}.tmp`)
    fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`)
    fs.renameSync(tmp, path.join(root, RUNTIME_ROOT_MANIFEST))
  } catch {
    // Best-effort metadata; the current symlink remains authoritative.
  }
}

function writeLocalRuntimeManifest(settings, version, meta = {}) {
  const dir = localVersionDir(settings, version)
  try {
    fs.writeFileSync(path.join(dir, RUNTIME_MANIFEST), `${JSON.stringify({
      version: versionToken(version),
      sourceVersion: versionToken(version),
      createdAt: new Date().toISOString(),
      ...meta,
    }, null, 2)}\n`)
  } catch {
    // Missing metadata only disables this directory's rollback identity.
  }
}

/** Atomically point `current` at a finished local runtime directory. */
function activateLocalRuntime(settings, version) {
  const root = localRuntimeRoot(settings)
  const versionDir = localVersionDir(settings, version)
  if (!fs.existsSync(path.join(versionDir, 'apps/cli/lib/bin.js'))) {
    throw new Error(`运行时目录未构建完成：${versionDir}`)
  }
  const previous = readLocalRootManifest(settings)
  const token = versionToken(version)
  const current = path.join(root, CURRENT_LINK)
  const tmp = path.join(root, `.${CURRENT_LINK}.tmp`)
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.symlinkSync(token, tmp, 'dir')
    fs.renameSync(tmp, current)
  } catch (error) {
    throw new Error(`切换本地运行时 current 失败：${error.message}`)
  }
  writeLocalRootManifest(settings, { current: token, previous: previous.current })
  writeLocalRuntimeManifest(settings, version)
  pruneLocalRuntimeVersions(settings, token, previous.current)
  return token
}

function localActiveRuntimeDir(settings) {
  const manifest = readLocalRootManifest(settings)
  if (manifest.current === null) return null
  const dir = localVersionDir(settings, manifest.current)
  try {
    if (fs.existsSync(path.join(dir, 'apps/cli/lib/bin.js'))) return dir
  } catch {
    return null
  }
  return null
}

function localRuntimeVersions(settings) {
  const root = localRuntimeRoot(settings)
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .sort()
  } catch {
    return []
  }
}

function pruneLocalRuntimeVersions(settings, current, previous) {
  const keep = new Set([current, previous].filter(value => value !== null && value !== ''))
  const versions = localRuntimeVersions(settings)
  for (const version of versions) {
    if (keep.has(version)) continue
    try {
      fs.rmSync(path.join(localRuntimeRoot(settings), version), { recursive: true, force: true })
    } catch {
      // Best-effort GC.
    }
  }
  if (versions.length <= MAX_RUNTIME_VERSIONS) return
  for (const version of versions.slice(0, versions.length - MAX_RUNTIME_VERSIONS)) {
    if (keep.has(version)) continue
    try {
      fs.rmSync(path.join(localRuntimeRoot(settings), version), { recursive: true, force: true })
    } catch {
      // Best-effort GC.
    }
  }
}

/** Point `current` back to the previous finished version. */
function rollbackLocalRuntime(settings) {
  const manifest = readLocalRootManifest(settings)
  if (manifest.previous === null || manifest.previous === '') return null
  const dir = localVersionDir(settings, manifest.previous)
  if (!fs.existsSync(path.join(dir, 'apps/cli/lib/bin.js'))) return null
  activateLocalRuntime(settings, manifest.previous)
  return manifest.previous
}

// Remote runtime layout. Paths are intentionally POSIX strings for the remote
// login shell; they must never be passed through local path.join.

function remoteRuntimeRoot() {
  return '"$HOME"/.dsh/runtime'
}

function remoteVersionDir(version) {
  return `${remoteRuntimeRoot()}/${versionToken(version)}`
}

function remoteCurrentDir() {
  return `${remoteRuntimeRoot()}/${CURRENT_LINK}`
}

function remoteStagingDir(version) {
  return `${remoteRuntimeRoot()}/.staging-${process.pid}-${versionToken(version)}`
}

async function readRemoteRootManifest(settings, remoteRun) {
  const result = await remoteRun(
    settings.ssh.host,
    `cat ${remoteRuntimeRoot()}/${RUNTIME_ROOT_MANIFEST} 2>/dev/null || echo __none__`,
    { timeoutMs: 15_000 },
  )
  const text = result.lines.join('\n').trim()
  if (result.code !== 0 || text === '' || text === '__none__') return { current: null, previous: null }
  try {
    const manifest = JSON.parse(text)
    return {
      current: typeof manifest.current === 'string' ? manifest.current : null,
      previous: typeof manifest.previous === 'string' ? manifest.previous : null,
    }
  } catch {
    return { current: null, previous: null }
  }
}

async function activateRemoteRuntime(settings, remoteRun, version) {
  const root = remoteRuntimeRoot()
  const versionDir = remoteVersionDir(version)
  const check = await remoteRun(
    settings.ssh.host,
    `test -f ${versionDir}/apps/cli/lib/bin.js && echo ok || echo missing`,
    { timeoutMs: 20_000 },
  )
  if (!check.lines.includes('ok')) throw new Error(`远端运行时目录未构建完成：${versionDir}`)
  const previous = await readRemoteRootManifest(settings, remoteRun)
  const token = versionToken(version)
  const activate = await remoteRun(
    settings.ssh.host,
    `cd ${root} && ln -sfn ${token} ${CURRENT_LINK} && printf '{"current":"%s","previous":"%s"}' "${token}" "${previous.current ?? ''}" > ${RUNTIME_ROOT_MANIFEST}`,
    { timeoutMs: 20_000 },
  )
  if (activate.code !== 0) throw new Error(`切换远端运行时 current 失败：${activate.lines.join('\n')}`)
  return token
}

async function remoteActiveRuntimeDir(settings, remoteRun) {
  const result = await remoteRun(
    settings.ssh.host,
    `if [ -f ${remoteCurrentDir()}/apps/cli/lib/bin.js ]; then echo ${remoteCurrentDir()}; else echo __none__; fi`,
    { timeoutMs: 20_000 },
  )
  const found = result.lines.map(line => line.trim()).find(Boolean)
  return found === '__none__' || found === undefined ? null : found
}

async function rollbackRemoteRuntime(settings, remoteRun) {
  const manifest = await readRemoteRootManifest(settings, remoteRun)
  if (manifest.previous === null || manifest.previous === '') return null
  await activateRemoteRuntime(settings, remoteRun, manifest.previous)
  return manifest.previous
}

// ── advisory locks ──────────────────────────────────────────────────────────

function lockName(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 96) || 'task'
}

function localLockDir(settings, name) {
  return path.join(expandHome(settings.local.dshHome), 'locks', lockName(name))
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function localLockIsStale(lockDir) {
  const owner = readJson(path.join(lockDir, 'owner.json'))
  if (owner !== null && Number.isInteger(owner.pid)) {
    return !pidAlive(owner.pid)
  }
  // A lock without a readable owner is considered stale after a grace period.
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs > REMOTE_LOCK_STALE_MS
  } catch {
    return true
  }
}

/** Run `task()` while holding an atomic directory lock on the local machine. */
async function withLocalLock(settings, name, task, { timeoutMs = LOCK_TIMEOUT_MS } = {}) {
  const lockDir = localLockDir(settings, name)
  fs.mkdirSync(path.dirname(lockDir), { recursive: true })
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      fs.mkdirSync(lockDir)
      fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
        pid: process.pid,
        host: os.hostname(),
        createdAt: new Date().toISOString(),
      }))
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (Date.now() >= deadline) {
        throw new Error(`等待本地锁超时：${lockDir}（可能有其他构建/安装任务持有）`)
      }
      if (localLockIsStale(lockDir)) {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true })
          continue
        } catch {
          // Another process won the race; fall through and retry.
        }
      }
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS))
    }
  }
  try {
    return await task()
  } finally {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup; a stale lock will be reaped by the next owner.
    }
  }
}

function remoteLockDir(name) {
  return `"$HOME"/.dsh/locks/desktop-shell/${lockName(name)}`
}

function remoteLockIsStale(owner) {
  const createdAt = Date.parse(owner?.createdAt ?? '')
  return !Number.isFinite(createdAt) || Date.now() - createdAt > REMOTE_LOCK_STALE_MS
}

/** Run `task()` while holding a remote `mkdir` lock, stale after 30 minutes. */
async function withRemoteLock(settings, remoteRun, name, task, { timeoutMs = LOCK_TIMEOUT_MS } = {}) {
  const lockDir = remoteLockDir(name)
  const ownerFile = `${lockDir}/owner.json`
  const deadline = Date.now() + timeoutMs
  const ownerPayload = JSON.stringify({
    pid: process.pid,
    host: os.hostname(),
    createdAt: new Date().toISOString(),
  })
  while (true) {
    const attempt = await remoteRun(
      settings.ssh.host,
      `if mkdir -p "$HOME"/.dsh/locks/desktop-shell && mkdir ${lockDir} 2>/dev/null; then printf '%s' ${shellQuote(ownerPayload)} > ${ownerFile}; echo acquired; else if [ -f ${ownerFile} ]; then cat ${ownerFile}; fi; echo busy; fi`,
      { timeoutMs: 20_000 },
    )
    const lines = attempt.lines.map(line => line.trim()).filter(Boolean)
    if (attempt.code !== 0) {
      throw new Error(`无法获取远端锁：${lines.slice(-5).join('\n') || `ssh 退出码 ${attempt.code}`}`)
    }
    if (lines.includes('acquired')) {
      try {
        return await task()
      } finally {
        await remoteRun(settings.ssh.host, `rm -rf ${lockDir} 2>/dev/null || true`, { timeoutMs: 15_000 })
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`等待远端锁超时：${lockDir}（可能有其他构建/安装任务持有）`)
    }
    const ownerText = lines.join('\n')
    let owner = null
    try {
      const firstBrace = ownerText.indexOf('{')
      if (firstBrace !== -1) owner = JSON.parse(ownerText.slice(firstBrace))
    } catch {
      owner = null
    }
    if (remoteLockIsStale(owner)) {
      await remoteRun(settings.ssh.host, `rm -rf ${lockDir} 2>/dev/null || true`, { timeoutMs: 15_000 })
      continue
    }
    await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS))
  }
}

module.exports = {
  LOCAL_STATE_FILE,
  MAX_RUNTIME_VERSIONS,
  REMOTE_LOG_FILE,
  REMOTE_PID_FILE,
  REMOTE_PORT_FILE,
  REMOTE_STATE_FILE,
  RUNTIME_MANIFEST,
  RUNTIME_ROOT_MANIFEST,
  activateLocalRuntime,
  activateRemoteRuntime,
  expandHome,
  isValidState,
  localActiveRuntimeDir,
  localStatePath,
  localStagingDir,
  localVersionDir,
  parseDshWebUrl,
  pruneLocalRuntimeVersions,
  readLocalState,
  readLocalRootManifest,
  readRemoteRootManifest,
  readRemoteState,
  remoteActiveRuntimeDir,
  remoteStagingDir,
  remoteVersionDir,
  removeLocalState,
  removeRemoteState,
  rollbackLocalRuntime,
  rollbackRemoteRuntime,
  versionToken,
  writeLocalRuntimeManifest,
  writeLocalState,
  writeRemoteState,
  withLocalLock,
  withRemoteLock,
}
