'use strict'

/**
 * ConnectionManager — the shell's runtime spine.
 *
 * One connection lifecycle serves both modes:
 *
 * - local: probe `http://127.0.0.1:<port>`; when nothing answers, spawn the
 *   repo's built `apps/cli/lib/bin.js web --port <port>` as an owned child
 *   (own process group), restarting it a bounded number of times.
 * - ssh: check key-based connectivity, clone the repo on the remote when the
 *   target directory is missing, keep a `ssh -N -L` tunnel alive (bounded
 *   restarts), and start/stop the remote web service over ssh, with the pid
 *   recorded in `~/.dsh/desktop-web.pid` on the remote.
 *
 * The service is only ever *started* by the shell; an already-listening port
 * is adopted as externally owned and never killed.
 */

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { randomUUID } = require('node:crypto')
const { EventEmitter } = require('node:events')
const { runCommand, spawnService } = require('./runner')
const { sshCommandArgs, tunnelArgs, shellQuote, remotePath, remoteToolchainPrefix, displayLabel } = require('./ssh')
const { resolveTools } = require('./tools')
const { findFreePort, releasePort, reservePort, tcpProbe } = require('./ports')
const { runtimeLayout } = require('./runtime-layout')
const runtimeStore = require('./runtime-store')

const PROBE_INTERVAL_MS = 750
const READY_TIMEOUT_MS = 90 * 1000
const SERVICE_RETRIES = 3
const TUNNEL_RETRIES = 5
const LOG_RING_LINES = 300

// Sentinel markers for remoteRun: some ssh gateways (e.g. Tencent devcloud)
// print a banner line such as `authz success` onto stdout from the remote
// login shell before the command runs. Every value-parse in the shell reads
// `remoteRun`'s lines, so instead of teaching each parse site to skip an
// unknown banner, remoteRun wraps the command in these unique markers and
// returns only the payload between them. Random per process so a command's own
// output can never collide.
const PAYLOAD_BEGIN = `__DSH_PAYLOAD_BEGIN_${randomUUID().replace(/-/g, '')}__`
const PAYLOAD_END = `__DSH_PAYLOAD_END_${randomUUID().replace(/-/g, '')}__`

/**
 * Extract the payload between BEGIN and END markers from command output
 * lines. Markers are matched as substrings (not only whole lines) so a
 * newline-less command output that fuses with a marker still parses:
 * payload pieces that share a line with BEGIN or END are split off.
 */
function extractPayload(lines, beginMarker, endMarker) {
  const payload = []
  let inPayload = false
  for (const line of lines) {
    if (!inPayload) {
      const beginPos = line.indexOf(beginMarker)
      if (beginPos === -1) continue
      inPayload = true
      const rest = line.slice(beginPos + beginMarker.length)
      if (rest === '') continue
      const endPos = rest.indexOf(endMarker)
      if (endPos >= 0) {
        if (rest.slice(0, endPos) !== '') payload.push(rest.slice(0, endPos))
        return payload
      }
      payload.push(rest)
      continue
    }
    const endPos = line.indexOf(endMarker)
    if (endPos >= 0) {
      if (line.slice(0, endPos) !== '') payload.push(line.slice(0, endPos))
      return payload
    }
    payload.push(line)
  }
  // No END marker seen: fall back to the raw lines so callers still get
  // the output (banner isolation degrades, not data).
  return lines
}

/** Probe a URL once; `isDsh` checks for the boot marker in the served HTML. */
function probeOnce(url) {
  return new Promise(resolve => {
    const request = http.get(url, { timeout: 2000 }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        resolve({ up: true, isDsh: Buffer.concat(chunks).toString('utf8').includes('__DSH_BOOT__') })
      })
      response.on('error', () => resolve({ up: false, isDsh: false }))
    })
    request.on('timeout', () => {
      request.destroy()
      resolve({ up: false, isDsh: false })
    })
    request.on('error', () => resolve({ up: false, isDsh: false }))
  })
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Whether a local PID is alive (signal 0 probes without signalling). */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * Parse the loopback port out of a service URL. Returns 0 when the URL has no
 * usable port, so callers can skip lsof probing rather than guess a port.
 */
function urlPort(url) {
  try {
    const port = Number(new URL(url).port)
    return Number.isInteger(port) && port > 0 ? port : 0
  } catch {
    return 0
  }
}

/**
 * Resolve the real PID listening on a local loopback port, falling back to
 * `lsof` when the state file's recorded pid has gone stale (e.g. an
 * externally-started service the shell adopted but whose state was never
 * updated). Returns 0 when nothing answers or `lsof` is unavailable.
 */
async function findListeningPid(port) {
  if (!Number.isInteger(port) || port <= 0) return 0
  const candidates = ['/usr/sbin/lsof', '/usr/bin/lsof', 'lsof']
  for (const bin of candidates) {
    try {
      const result = await runCommand({
        cmd: bin,
        args: ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'],
        timeoutMs: 5000,
      })
      if (result.code !== 0) continue
      const pid = Number((result.lines[0] || '').trim())
      if (Number.isInteger(pid) && pid > 0) return pid
    } catch {
      // Try the next candidate.
    }
  }
  return 0
}

async function waitReady(url, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const probe = await probeOnce(url)
    if (probe.up) return probe
    await sleep(PROBE_INTERVAL_MS)
  }
  throw new Error(`等待 ${url} 就绪超时（${Math.round(timeoutMs / 1000)} 秒）。请打开服务日志排查。`)
}

/** Expand a leading `~/` against the user's home directory. */
function expandHome(dir) {
  const { homedir } = require('node:os')
  if (dir === '~') return homedir()
  if (dir.startsWith('~/')) return path.join(homedir(), dir.slice(2))
  return dir
}

class ConnectionManager extends EventEmitter {
  constructor({ getSettings, onLog, getOwner }) {
    super()
    this.getSettings = getSettings
    this.getOwner = getOwner || (() => null)
    this.onLog = onLog || (() => {})
    this.status = { state: 'idle', mode: 'local', url: '', detail: '未连接', serviceOwner: 'none' }
    this.localChild = null
    this.tunnelChild = null
    this.tunnelChildren = new Set()
    this.localRetries = 0
    this.tunnelRetries = 0
    this.stopped = false
    this.logRing = []
    this.tools = null
    this.cachedRemoteShell = ''
    this.localPort = null
    this.remotePort = null
    this.localVersion = null
    this.reservedLocalPort = null
    // Bumped by connect()/stop()/resetService(); stale close watchers and
    // retry timers from a previous connect generation must never spawn a
    // second service or clobber the current child reference.
    this.connectEpoch = 0
  }

  /** Owner used by runner.js so one terminal's update task can be cancelled. */
  owner() {
    return this.getOwner()
  }

  url() {
    const settings = this.getSettings()
    // The window always follows the port that actually serves: the fallback
    // port for a local instance, or the fallback forward port for a tunnel.
    if (settings.mode === 'ssh') return `http://127.0.0.1:${this.localPort ?? settings.ssh.localPort}`
    return `http://127.0.0.1:${this.localPort ?? settings.local.port}`
  }

  /**
   * The harness's own package version (apps/cli package.json `version`), read
   * from the checkout the shell manages — locally from disk, remotely over
   * ssh. Best-effort: returns '' on any read/parse failure. `host.describe`
   * is deliberately NOT used because its `version` field is an upstream
   * placeholder (`0.0.1`) that does not track the real package version.
   */
  async hostVersion() {
    const settings = this.getSettings()
    try {
      if (settings.mode === 'local') {
        const manifest = JSON.parse(fs.readFileSync(
          path.join(settings.local.repoDir, 'apps', 'cli', 'package.json'), 'utf8',
        ))
        return typeof manifest.version === 'string' ? manifest.version : ''
      }
      const result = await this.remoteRun(
        settings.ssh.host,
        `cat ${remotePath(settings.ssh.remoteRepoDir)}/apps/cli/package.json 2>/dev/null || echo __none__`,
        { timeoutMs: 15_000 },
      )
      if (result.code !== 0) return ''
      const text = result.lines.join('\n')
      if (text.includes('__none__')) return ''
      const manifest = JSON.parse(text)
      return typeof manifest.version === 'string' ? manifest.version : ''
    } catch {
      return ''
    }
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch }
    this.emit('status', this.status)
  }

  log(line) {
    this.logRing.push(line)
    if (this.logRing.length > LOG_RING_LINES) this.logRing.shift()
    this.onLog(line)
  }

  dumpLog() {
    return this.logRing.join('\n')
  }

  resolvedTools({ refresh = false } = {}) {
    if (this.tools === null || refresh) this.tools = resolveTools(this.getSettings())
    return this.tools
  }

  /**
   * Reserve the first free local TCP port at or after `start`, bounded at
   * +30. When the configured port is taken by another process or reserved by
   * another session in this shell, the service silently moves to the next
   * free port instead of failing.
   */
  async acquireLocalPort(start) {
    this.releaseReservedLocalPort()
    const port = await findFreePort(start)
    if (!reservePort(port)) throw new Error(`端口 ${port} 刚被其他工作区预留，请重试连接。`)
    this.reservedLocalPort = port
    if (port !== start) this.log(`端口 ${start} 已被占用，改用 ${port}。`)
    return port
  }

  releaseReservedLocalPort() {
    if (this.reservedLocalPort !== null) {
      releasePort(this.reservedLocalPort)
      this.reservedLocalPort = null
    }
  }

  releaseReservedPorts() {
    this.releaseReservedLocalPort()
  }

  /**
   * Version of the runtime that is currently active (the `current` symlink),
   * or 'unknown' when no runtime is installed yet. State reuse and service
   * restarts must use this — there is no source checkout anymore, so the
   * active artifact's package version is the only identity.
   */
  async serviceVersion(settings) {
    if (settings.mode === 'local') {
      const manifest = runtimeStore.readLocalRootManifest(settings)
      if (manifest.current !== null && runtimeStore.localActiveRuntimeDir(settings) !== null) {
        return manifest.current
      }
      return 'unknown'
    }
    const remoteRun = (host, inner, options) => this.remoteRun(host, inner, options)
    const manifest = await runtimeStore.readRemoteRootManifest(settings, remoteRun)
    const active = await runtimeStore.remoteActiveRuntimeDir(settings, remoteRun)
    if (manifest.current !== null && active !== null) return manifest.current
    return 'unknown'
  }

  localStatePath(settings) {
    return runtimeStore.localStatePath(settings)
  }

  readLocalState(settings) {
    return runtimeStore.readLocalState(settings)
  }

  writeLocalState(settings, state) {
    runtimeStore.writeLocalState(settings, state)
  }

  async readRemoteState(settings) {
    return runtimeStore.readRemoteState(settings, (host, inner, options) => this.remoteRun(host, inner, options))
  }

  async writeRemoteState(settings, state) {
    return runtimeStore.writeRemoteState(settings, (host, inner, options) => this.remoteRun(host, inner, options), state)
  }

  /** Run one remote command through the remote login shell. */
  async remoteRun(target, inner, { timeoutMs, onLine } = {}) {
    const tools = this.resolvedTools()
    const shellPath = await this.remoteLoginShell(target)
    // Wrap the command in unique markers so any login-shell/gateway banner
    // (authz success etc.) printed BEFORE the command stays outside the
    // payload. `inner` runs in a subshell so any `exit` inside it only ends
    // the subshell, keeping the trailing END marker and the real exit code
    // (`__dsh_rc=$?`) intact for callers' `code !== 0` checks.
    const wrapped = `echo ${PAYLOAD_BEGIN}; ( ${inner} ); __dsh_rc=$?; echo ${PAYLOAD_END}; exit $__dsh_rc`
    // The wrapped command is single-quoted for the remote shell that sshd
    // invokes, so `-c` receives the whole command as one argument.
    const command = `${shellPath} -l -c ${shellQuote(wrapped)}`
    let inPayload = false
    const filteredOnLine = onLine === undefined ? undefined : line => {
      if (line === PAYLOAD_END) {
        inPayload = false
        return
      }
      if (inPayload) {
        onLine(line)
        return
      }
      if (line === PAYLOAD_BEGIN) inPayload = true
    }
    const result = await runCommand({
      cmd: tools.ssh,
      args: sshCommandArgs(target, command),
      timeoutMs,
      onLine: filteredOnLine,
      owner: this.owner(),
    })
    // Substring-aware marker extraction: a command whose final line has no
    
    // trailing newline (e.g. `printf ... > file` followed by `cat file`)
    // fuses that output with the END marker on one line. Match markers
    // inside lines, not only as whole lines, so the payload still comes
    // out clean.
    const lines = extractPayload(result.lines, PAYLOAD_BEGIN, PAYLOAD_END)
    return { ...result, lines }
  }

  async remoteLoginShell(target) {
    if (this.cachedRemoteShell !== '') return this.cachedRemoteShell
    const tools = this.resolvedTools()
    for (const candidate of ['zsh', 'bash', 'sh']) {
      const result = await runCommand({
        cmd: tools.ssh,
        args: sshCommandArgs(target, `command -v ${candidate}`),
        timeoutMs: 15_000,
        owner: this.owner(),
      })
      const found = result.code === 0 ? result.lines.map(line => line.trim()).find(line => line.startsWith('/')) : ''
      if (found) {
        this.cachedRemoteShell = found
        return found
      }
    }
    return '/bin/sh'
  }

  /** Whether the repo the settings point at is built (`apps/cli/lib/bin.js` exists). */
  async isBuilt() {
    const settings = this.getSettings()
    if (settings.mode === 'local') {
      const runtimeDir = runtimeStore.localActiveRuntimeDir(settings)
      for (const dir of [runtimeDir, settings.local.repoDir]) {
        if (dir === null || dir === '') continue
        try {
          if (runtimeLayout(dir) !== null) return true
        } catch {
          // Fall through to the next candidate.
        }
      }
      return false
    }
    const dir = await this.remoteServiceDir(settings)
    // A runtime dir may be repo-layout (apps/cli/lib/bin.js) or npm-layout
    // (node_modules/@deepseek-ai/dsh/lib/bin.js); recognize either.
    const result = await this.remoteRun(settings.ssh.host, `if test -f ${dir}/apps/cli/lib/bin.js || test -f ${dir}/node_modules/@deepseek-ai/dsh/lib/bin.js; then echo yes; else echo no; fi`)
    // A non-zero exit here is a connectivity/ssh failure, not a "not built"
    // verdict: let the caller surface it as a connection problem.
    if (result.code !== 0) throw new Error(`无法检查远端构建状态：${result.lines.join('\n')}`)
    return result.lines.includes('yes')
  }

  /** Connect per the current settings; failures surface via the status event. */
  async connect() {
    const settings = this.getSettings()
    this.stopped = false
    this.connectEpoch += 1
    this.tools = null
    this.cachedRemoteShell = ''
    this.localRetries = 0
    this.tunnelRetries = 0
    this.localPort = null
    this.remotePort = null
    this.localVersion = null
    this.machineId = null
    this.stopOwnedChildren()
    this.releaseReservedPorts()
    this.setStatus({ state: 'connecting', mode: settings.mode, url: this.url(), detail: '正在连接…', serviceOwner: 'none' })
    try {
      if (settings.mode === 'ssh') await this.connectSsh(settings)
      else await this.connectLocal(settings)
    } catch (error) {
      this.releaseReservedPorts()
      this.setStatus({ state: 'error', detail: String(error.message || error) })
      this.emit('connect-failed', error)
    }
  }

  /** Disconnect: kill owned local child and tunnel; never touch remote services. */
  stop() {
    this.stopped = true
    this.connectEpoch += 1
    this.stopOwnedChildren()
    this.releaseReservedPorts()
    if (this.status.state !== 'error') this.setStatus({ state: 'idle', detail: '已断开', serviceOwner: 'none' })
  }

  /**
   * Reset the owned backend end-to-end: terminate the recorded local/remote
   * pid, delete the state file, and forget in-memory port/version references.
   * Unlike `stop()` (which disconnects but keeps the state file so a later
   * window can adopt the still-running service), reset fully discards state so
   * the next connect starts from a clean slate — the escape hatch for a wedged
   * or version-mismatched service.
   */
  async resetService() {
    const settings = this.getSettings()
    this.stopped = true
    this.connectEpoch += 1
    this.stopOwnedChildren()
    this.releaseReservedPorts()
    this.tunnelChildren.clear()

    if (settings.mode === 'ssh') {
      const state = await this.readRemoteState(settings)
      if (state !== null && Number.isInteger(state.pid)) {
        this.log(`重置：终止远端服务（pid ${state.pid}）…`)
        await this.remoteRun(
          settings.ssh.host,
          `kill ${state.pid} 2>/dev/null || true`,
          { timeoutMs: 15_000 },
        )
      }
      await runtimeStore.removeRemoteState(settings, (host, inner, options) => this.remoteRun(host, inner, options))
    } else {
      const state = this.readLocalState(settings)
      if (state !== null && pidAlive(state.pid)) {
        this.log(`重置：终止本地服务（pid ${state.pid}）…`)
        try {
          process.kill(state.pid, 'SIGTERM')
        } catch {
          // Already gone.
        }
      }
      runtimeStore.removeLocalState(settings)
    }

    this.localChild = null
    this.tunnelChild = null
    this.localPort = null
    this.remotePort = null
    this.localVersion = null
    this.releaseReservedPorts()
    this.stopped = false
    this.setStatus({ state: 'idle', detail: '后端服务已重置', serviceOwner: 'none' })
  }

  /** Mark a child as intentionally stopped and terminate its process group. */
  killChild(child) {
    if (child === null || child === undefined) return
    child._dshStopRequested = true
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      try {
        child.kill('SIGTERM')
      } catch {
        // The process is already gone; nothing to reap here.
      }
    }
  }

  stopOwnedChildren() {
    if (this.localChild !== null) {
      this.killChild(this.localChild)
      this.localChild = null
    }
    // Kill every tunnel ever spawned by this manager. Keeping the set until
    // each child emits close prevents an overwritten/forgotten reference from
    // orphaning a still-running ssh tunnel.
    for (const child of this.tunnelChildren) this.killChild(child)
    if (this.tunnelChild !== null) {
      this.killChild(this.tunnelChild)
      this.tunnelChild = null
    }
  }

  /** Restart the harness service in place (the update flow's last step). */
  async restartService() {
    const settings = this.getSettings()
    // Let the shell frame answer 'what is happening now?' while the harness
    // web view is being torn down and brought back on a possibly new port.
    this.setStatus({
      state: 'restarting',
      url: this.url(),
      detail: '正在重启服务…',
    })
    try {
      if (settings.mode === 'ssh') {
        // Start the new remote service first (it reports the OS-chosen port),
        // then rebuild the local forward to that exact port.
        await this.restartRemoteService(settings)
        await this.startTunnelOnFreePort(settings, this.remotePort)
        await waitReady(this.url())
        // Emit the new URL: windows follow the port that actually serves, and
        // a stale title/URL after a restart is a dead page for every window.
        this.setStatus({
          state: 'ready',
          url: this.url(),
          detail: `已重启（${displayLabel(settings.ssh.host)}，隧道转发）`,
          serviceOwner: 'remote',
        })
        return
      }
      const version = await this.serviceVersion(settings)
      this.localVersion = version
      if (this.localChild !== null) {
        this.log('重启本地服务…')
        this.killChild(this.localChild)
        this.localChild = null
        this.localPort = null
        await this.spawnLocalService(settings, 0, version)
        await waitReady(this.url())
        this.localRetries = 0
        this.setStatus({
          state: 'ready',
          url: this.url(),
          detail: `已重启（端口 ${this.localPort}）`,
          serviceOwner: 'self',
        })
        return
      }
      const url = this.url()
      const probe = await probeOnce(url)
      if (probe.up) {
        // An externally-owned service (the shell adopted an already-listening
        // port) still needs a restart for plugin/preset updates to take effect:
        // the host process must reload its profile. Resolve the real listener —
        // the state file's pid first, then `lsof` on the ACTUAL url port (not
        // the configured default) when that pid has gone stale — and start a
        // fresh owned service. Deriving the port from the URL that just answered
        // keeps the probe and the kill on the same endpoint even when the
        // service runs on an OS-chosen port.
        const state = this.readLocalState(settings)
        let pid = state !== null && Number.isInteger(state.pid) ? state.pid : 0
        if (!pidAlive(pid)) pid = await findListeningPid(urlPort(url))
        if (pidAlive(pid)) {
          this.log(`重启本地服务（外部托管，pid ${pid}）…`)
          try {
            process.kill(pid, 'SIGTERM')
          } catch {
            // Already gone; fall through to a fresh spawn.
          }
          this.localPort = null
          await this.spawnLocalService(settings, 0, version)
          await waitReady(this.url())
          this.localRetries = 0
          this.setStatus({
            state: 'ready',
            url: this.url(),
            detail: `已重启（端口 ${this.localPort}）`,
            serviceOwner: 'self',
          })
          return
        }
        this.log('服务由外部进程托管，跳过重启')
        this.setStatus({ state: 'ready', url, detail: '服务由外部进程托管，跳过重启' })
        return
      }
      this.localPort = null
      await this.spawnLocalService(settings, 0, version)
      await waitReady(this.url())
      this.setStatus({
        state: 'ready',
        url: this.url(),
        detail: `已重启（端口 ${this.localPort}）`,
        serviceOwner: 'self',
      })
    } catch (error) {
      this.setStatus({ state: 'error', detail: String(error.message || error), serviceOwner: 'none' })
      throw error
    }
  }

  // ── local mode ────────────────────────────────────────────────────────────

  async connectLocal(settings) {
    const tools = this.resolvedTools()
    if (tools.node === '') {
      throw new Error('未找到兼容的 node（需 22.19+ 或 24+）。请安装 Node.js，或在「设置 → 高级」中手动指定 node 路径。')
    }
    // No source checkout is required anymore: the runtime is installed from
    // the official npm artifact, so connecting never clones or validates a git
    // repo — it just resolves the active runtime and serves it.
    const version = await this.serviceVersion(settings)
    const state = this.readLocalState(settings)

    // Reuse a previously owned service when it still matches this build: same
    // version fingerprint AND a dsh service still answering on its port.
    if (state !== null && state.version === version) {
      const url = `http://127.0.0.1:${state.port}`
      const probe = await probeOnce(url)
      if (probe.up && probe.isDsh) {
        this.localPort = state.port
        this.localVersion = version
        this.log(`复用已运行的 dsh web（端口 ${state.port}，版本 ${version.slice(0, 8)}）`)
        this.setStatus({ state: 'ready', url, detail: '已连接（复用已运行服务）', serviceOwner: 'external' })
        return
      }
    }

    // Otherwise reap a stale/outdated leftover service (auto-upgrade) so it
    // never lingers as an orphan, then serve on the first free port.
    if (state !== null && pidAlive(state.pid)) {
      this.log(`检测到旧版/残留服务（pid ${state.pid}），清理后升级…`)
      try {
        process.kill(state.pid, 'SIGTERM')
      } catch {
        // Already gone; nothing to reap.
      }
    }

    // Start with `--port 0` and adopt the OS-chosen port reported by the CLI
    // (`dsh web: http://127.0.0.1:<port>`). There is no probe→bind race and
    // no +30 scan; the configured port is only a fallback for `url()` while
    // the service is still starting.
    await this.spawnLocalService(settings, 0, version)
    const ready = await waitReady(this.url())
    this.localRetries = 0
    this.setStatus({
      state: 'ready',
      url: this.url(),
      detail: ready.isDsh
        ? `已连接（端口 ${this.localPort}）`
        : '已连接，但该端口响应的可能不是 DeepSeek Harness',
      serviceOwner: 'self',
    })
  }

  /**
   * Prepare the instance's OWN dsh home: create it and seed settings and
   * credentials from `~/.dsh` on first use. Two dsh processes on one machine
   * must never share a session store — this home keeps the shell's local
   * instance fully isolated from any other harness instance (sessions,
   * settings, profiles, credentials all live under it).
   */
  prepareLocalHome(settings) {
    const home = expandHome(settings.local.dshHome)
    fs.mkdirSync(home, { recursive: true })
    const source = expandHome('~/.dsh')
    for (const file of ['settings.yaml', '.credentials.yaml']) {
      const target = path.join(home, file)
      try {
        if (!fs.existsSync(target) && fs.existsSync(path.join(source, file))) {
          fs.copyFileSync(path.join(source, file), target)
          this.log(`[init] 已从 ~/.dsh 复制 ${file} 到 ${settings.local.dshHome}（此后两个工作区完全独立）`)
        }
      } catch {
        // Seeding is best-effort: a missing credential just means this
        // instance's own settings need configuring.
      }
    }
    return home
  }

  async spawnLocalService(settings, port = 0, version = null) {
    const tools = this.resolvedTools()
    const serveVersion = version ?? this.localVersion ?? 'unknown'
    // `--port 0` lets the OS choose the port; the CLI prints the real URL on
    // stdout as `dsh web: http://127.0.0.1:<port>`. Keep localPort null until
    // that line arrives so url() never returns port 0.
    this.localVersion = serveVersion
    this.localPort = port === 0 ? null : port
    // Serve from the atomically-activated runtime when one exists; otherwise
    // fall back to the source checkout (first run / dirty-worktree builds).
    const runtimeDir = runtimeStore.localActiveRuntimeDir(settings) ?? settings.local.repoDir
    const layout = runtimeLayout(runtimeDir)
    if (layout === null) {
      throw new Error(
        `运行时尚未构建（${runtimeDir} 缺少 apps/cli/lib/bin.js 或官方产物）。请在顶部菜单「更新 → 更新并重启」完成首次构建/安装。`,
      )
    }
    const binPath = layout.bin
    this.log(`启动 dsh web（${port === 0 ? '由系统分配端口' : `端口 ${port}`}，数据目录 ${settings.local.dshHome}，运行时 ${runtimeDir}）…`)
    this.prepareLocalHome(settings)

    let resolvePort
    let rejectPort
    const portSeen = new Promise((resolve, reject) => {
      resolvePort = resolve
      rejectPort = reject
    })
    const portTimer = setTimeout(() => {
      rejectPort(new Error('等待 dsh web 报告实际端口超时。请打开服务日志排查。'))
    }, 30_000)

    const service = spawnService({
      cmd: tools.node,
      // NOTE: `--no-open` is intentionally omitted until the official npm
      // artifact ships it; older artifacts abort on the unknown option.
      args: [binPath, 'web', '--port', String(port)],
      cwd: runtimeDir,
      env: { ...tools.env, DSH_HOME: expandHome(settings.local.dshHome) },
      onLine: line => {
        this.log(`[web] ${line}`)
        const parsed = runtimeStore.parseDshWebUrl(line)
        if (parsed !== null && parsed.port > 0) resolvePort(parsed.port)
      },
    })
    this.localChild = service.child

    const epoch = this.connectEpoch
    const closeWatcher = (code, signal) => {
      // rejectPort is per-spawn (no-op once settled) and must always run so
      // a stale watcher never leaves this spawn's portSeen hanging while its
      // portTimer later kills whatever child is CURRENT — possibly the next
      // connect's healthy service.
      rejectPort(new Error(`本地服务启动失败（code=${code} signal=${signal ?? ''}）`))
      // Only clear the reference that points at THIS child; a newer spawn
      // may already own this.localChild.
      if (this.localChild === service.child) this.localChild = null
      // A stale watcher (the child was replaced by a newer connect or was
      // intentionally killed) must never schedule a restart.
      if (epoch !== this.connectEpoch) return
      if (this.stopped || service.child._dshStopRequested) return
      if (this.status.state !== 'connecting' && this.status.state !== 'ready') return
      const why = `本地服务退出（code=${code} signal=${signal ?? ''}）`
      this.log(why)
      if (this.localRetries < SERVICE_RETRIES) {
        this.localRetries += 1
        const delay = 1000 * this.localRetries
        this.setStatus({ detail: `服务退出，${delay / 1000} 秒后重启（第 ${this.localRetries}/${SERVICE_RETRIES} 次）…` })
        setTimeout(() => {
          if (epoch !== this.connectEpoch) return
          if (this.stopped) return
          if (this.status.state !== 'connecting' && this.status.state !== 'ready') return
          // Re-resolve the version BEFORE respawning: a peer shell instance
          // may have upgraded the runtime while this service was down, and
          // restarting the OLD captured version would silently roll the
          // device back. Restart with a fresh OS-chosen port as well; a
          // stale bound port can never force a crash-loop.
          Promise.resolve(this.serviceVersion(settings)).then(version => {
            if (this.stopped) return
            return this.spawnLocalService(settings, 0, version || serveVersion)
          }).catch(error => {
            if (this.stopped) return
            this.log(`本地服务重启失败：${String(error.message || error)}`)
            this.setStatus({ state: 'error', detail: String(error.message || error) })
          })
        }, delay)
      } else {
        this.setStatus({ state: 'error', detail: `${why}。请打开服务日志排查。` })
      }
    }
    service.child.on('close', closeWatcher)

    try {
      const actualPort = await portSeen
      clearTimeout(portTimer)
      this.localPort = actualPort
      this.writeLocalState(settings, { pid: service.child.pid, port: actualPort, version: serveVersion })
      this.log(`dsh web 已监听端口 ${actualPort}。`)
    } catch (error) {
      clearTimeout(portTimer)
      // Only kill the child THIS spawn owns: by the time the 30s port timer
      // fires, a newer connect may already own this.localChild, and killing
      // it would take down a healthy replacement service.
      if (this.localChild === service.child) {
        this.killChild(this.localChild)
        this.localChild = null
      }
      throw error
    }
  }

  // ── ssh mode ──────────────────────────────────────────────────────────────

  /**
   * Identify the remote machine the shell is connecting to. The identity is a
   * UUID persisted at `~/.dsh/.desktop-machine-id` on the remote: every ssh
   * alias that reaches the same user's home (e.g. `ubuntu` over LAN and
   * `home4` over the public network) reads the same id, so the shell can merge
   * them into one terminal regardless of which network entry was used. A
   * missing file is created on first contact.
   * @param {string} target - the ssh destination alias/string.
   * @returns {Promise<string>} the remote machine id.
   */
  /**
   * Read the remote machine id WITHOUT creating it. `ensureRemoteMachineId`
   * reuses this so an id is never minted on a machine that already has one.
   * @param {string} target - the ssh destination alias/string.
   * @returns {Promise<string|undefined>} the machine id, or undefined when absent.
   */
  async readRemoteMachineId(target) {
    const read = await this.remoteRun(
      target,
      'cat "$HOME"/.dsh/.desktop-machine-id 2>/dev/null || echo __none__',
      { timeoutMs: 15_000 },
    )
    return read.lines
      .map(line => line.trim())
      .find(line => line !== '__none__' && /^[0-9a-fA-F-]{8,}$/.test(line))
  }

  async ensureRemoteMachineId(target) {
    const existing = await this.readRemoteMachineId(target)
    if (existing !== undefined) return existing
    const id = randomUUID()
    // Atomic-ish create: only write when the file does NOT exist, then cat
    // back whatever won the race and return THAT. A machine id must never be
    // overwritten once it exists — a read failure (ssh hiccup) or two
    // concurrent connects used to rebuild it, silently changing the device
    // key and orphaning the configured components under the old key.
    const write = await this.remoteRun(
      target,
      `mkdir -p "$HOME"/.dsh && if [ ! -f "$HOME"/.dsh/.desktop-machine-id ]; then printf '%s' ${shellQuote(id)} > "$HOME"/.dsh/.desktop-machine-id; fi; cat "$HOME"/.dsh/.desktop-machine-id`,
      { timeoutMs: 15_000 },
    )
    if (write.code !== 0) throw new Error(`无法在远端写入终端身份标记：${write.lines.join('\n')}`)
    const finalId = write.lines.map(line => line.trim()).find(line => /^[0-9a-fA-F-]{8,}$/.test(line))
    if (finalId === undefined) throw new Error('无法读取远端终端身份标记')
    return finalId
  }

  async connectSsh(settings) {
    const tools = this.resolvedTools()
    const target = settings.ssh.host
    this.log(`测试 SSH 连接 ${target} …`)
    const test = await runCommand({
      cmd: tools.ssh,
      args: sshCommandArgs(target, 'echo dsh-ok'),
      timeoutMs: 15_000,
      owner: this.owner(),
    })
    if (test.code !== 0) {
      const output = test.lines.join('\n')
      const lanHint = /No route to host|Network is unreachable|Operation not permitted/.test(output)
        ? '\n提示：目标为局域网地址且连接被拒，若本机是 macOS 15+，请在「系统设置 → 隐私与安全性 → 本地网络」中允许 DeepSeek Harness。'
        : ''
      throw new Error(
        `SSH 连接失败（${target}）。请确认：1) 已配置免密登录（ssh-copy-id 后可用 ssh ${target} 直连）；2) 主机可达。${lanHint}`,
      )
    }
    this.machineId = await this.ensureRemoteMachineId(target)
    this.log(`已识别终端身份 ${this.machineId.slice(0, 8)}`)
    // No source checkout is required anymore: the remote runtime is installed
    // from the official npm artifact, so connecting never clones or validates
    // a remote git repo — it just resolves the active runtime and serves it.
    const version = await this.serviceVersion(settings)
    const state = await this.readRemoteState(settings)

    // Reuse a previously started remote service when its build still matches.
    // This fast path is lock-free: reusing an already-running service never
    // spawns anything, so it cannot orphan a process.
    if (state !== null && state.version === version) {
      this.remotePort = state.port
      await this.startTunnelOnFreePort(settings, state.port)
      const probe = await probeOnce(this.url())
      if (probe.up && probe.isDsh) {
        this.log(`复用远端 dsh web（端口 ${state.port}，版本 ${version.slice(0, 8)}）`)
        this.setStatus({ state: 'ready', url: this.url(), detail: `已连接（${displayLabel(target)}，复用远端服务）`, serviceOwner: 'remote' })
        return
      }
      // Tunnel is up but nothing dsh answers behind it: fall through to (re)start.
    }

    // The reap→launch→write-state sequence is serialized under a remote lock
    // so two shells (e.g. two aliases reaching the same machine concurrently)
    // cannot both decide to start and leave one service orphaned. Inside the
    // lock the state is re-read: a peer may have already started a matching
    // service, in which case it is adopted instead of started again.
    const remoteRun = (host, inner, options) => this.remoteRun(host, inner, options)
    const remotePort = await runtimeStore.withRemoteLock(
      settings,
      remoteRun,
      `service-${settings.ssh.host}`,
      async () => {
        const fresh = await this.readRemoteState(settings)
        if (fresh !== null && fresh.version === version) {
          // The state matches, but the service may have died (crash, remote
          // reboot) while the state stayed intact. Reuse only a LIVE service;
          // otherwise reap and relaunch instead of building a tunnel to a
          // dead port and timing out in waitReady.
          const alive = await this.remoteRun(
            settings.ssh.host,
            `node -e "fetch('http://127.0.0.1:${fresh.port}/').then(r=>r.text()).then(t=>process.stdout.write(t.includes('__DSH_BOOT__')?'yes':'no')).catch(()=>process.stdout.write('no'))" 2>/dev/null || echo no`,
            { timeoutMs: 10_000 },
          )
          if (alive.code === 0 && alive.lines.includes('yes')) return fresh.port
          this.log(`远端服务已退出（端口 ${fresh.port}），自动重启…`)
        }
        await this.reapRemoteService(settings, fresh ?? state)
        return this.launchRemoteService(settings, 0, version)
      },
      { timeoutMs: 90_000 },
    )

    this.remotePort = remotePort
    await this.startTunnelOnFreePort(settings, remotePort)
    const url = this.url()
    const ready = await waitReady(url)
    this.setStatus({
      state: 'ready',
      url: this.url(),
      detail: ready.isDsh ? `已连接（${displayLabel(target)}，隧道转发）` : '隧道已建立，但该端口响应的可能不是 DeepSeek Harness',
      serviceOwner: 'remote',
    })
  }

  /**
   * Reap a stale/outdated remote service before starting a fresh one. The
   * recorded pid is authoritative first; when it has gone stale (the service
   * died or was started by another shell without updating the state), fall
   * back to `lsof` on the recorded port so a leftover listener is still
   * reaped instead of becoming an orphan.
   */
  async reapRemoteService(settings, state) {
    if (state === null || state === undefined) return
    const target = settings.ssh.host
    let pid = Number.isInteger(state.pid) ? state.pid : 0
    const pidCheck = pid > 0
      ? await this.remoteRun(target, `kill -0 ${pid} 2>/dev/null && echo alive || echo dead`, { timeoutMs: 15_000 })
      : { code: 0, lines: ['dead'] }
    if (pidCheck.code === 0 && pidCheck.lines.includes('alive')) {
      this.log(`清理旧版/残留远端服务（pid ${pid}）…`)
      await this.remoteRun(target, `kill ${pid} 2>/dev/null || true`, { timeoutMs: 15_000 })
      await sleep(800)
      return
    }
    if (Number.isInteger(state.port) && state.port > 0) {
      const lsof = await this.remoteRun(
        target,
        `lsof -t -iTCP:${state.port} -sTCP:LISTEN 2>/dev/null | head -1 || echo 0`,
        { timeoutMs: 15_000 },
      )
      const listenerPid = Number((lsof.lines[0] ?? '0').trim())
      if (Number.isInteger(listenerPid) && listenerPid > 0) {
        this.log(`清理残留远端服务（端口 ${state.port}，pid ${listenerPid}）…`)
        await this.remoteRun(target, `kill ${listenerPid} 2>/dev/null || true`, { timeoutMs: 15_000 })
        await sleep(800)
      }
    }
  }

  /**
   * Reap a leftover local tunnel from a previous shell run that was force-killed
   * (a detached `ssh -N -L` never exits on its own). The tunnel's pid is the one
   * persisted in the tunnel state file; when that pid is still alive it is
   * killed and the stale state dropped.
   */
  async reapStaleTunnel(settings) {
    const state = runtimeStore.readLocalTunnelState(settings)
    if (state === null) return
    if (!pidAlive(state.pid)) {
      runtimeStore.removeLocalTunnelState(settings)
      return
    }
    this.log(`清理残留 SSH 隧道（pid ${state.pid}）…`)
    try {
      process.kill(state.pid, 'SIGTERM')
    } catch {
      // Already gone.
    }
    runtimeStore.removeLocalTunnelState(settings)
  }

  /** Pick the configured local forward port when free, else the next free port. */
  async startTunnelOnFreePort(settings, remotePort) {
    // Reap stale tunnels before picking a port so a forgotten earlier spawn
    // can't force us onto an unnecessarily high fallback port.
    for (const child of this.tunnelChildren) {
      if (child !== null && child !== undefined && child.exitCode === null && child.signalCode === null) {
        this.killChild(child)
      }
    }
    // Also reap a tunnel left behind by a previous force-killed shell.
    await this.reapStaleTunnel(settings)
    const localPort = await this.acquireLocalPort(settings.ssh.localPort)
    this.localPort = localPort
    try {
      await this.startTunnel(settings, localPort, remotePort)
    } catch (error) {
      this.releaseReservedLocalPort()
      throw error
    }
  }

  async startTunnel(settings, localPort, remotePort) {
    const tools = this.resolvedTools()
    // Reap any still-running tunnels from earlier attempts before opening a new
    // forward: a prior spawn that was overwritten (e.g. by a reconnect or by
    // the update flow) must never be left holding a local port.
    for (const child of this.tunnelChildren) {
      if (child !== null && child !== undefined && child.exitCode === null && child.signalCode === null) {
        this.killChild(child)
      }
    }
    const rport = remotePort ?? this.remotePort ?? settings.ssh.remotePort
    this.remotePort = rport
    const args = tunnelArgs(settings.ssh.host, localPort, rport)
    this.log(`建立隧道 127.0.0.1:${localPort} → ${settings.ssh.host}:${rport} …`)
    const service = spawnService({
      cmd: tools.ssh,
      args,
      env: tools.env,
      onLine: line => this.log(`[隧道] ${line}`),
    })
    this.tunnelChild = service.child
    // Track every spawned tunnel so an overwritten/forgotten reference can
    // still be reaped on disconnect (the root cause of "Address already in
    // use" even after switching ports).
    this.tunnelChildren.add(service.child)
    const epoch = this.connectEpoch
    service.child.on('close', (code, signal) => {
      this.tunnelChildren.delete(service.child)
      if (this.tunnelChild === service.child) this.tunnelChild = null
      // A stale handler (a reconnect replaced this tunnel) must not touch
      // the tunnel state a newer tunnel already wrote.
      if (epoch !== this.connectEpoch) return
      // The tunnel is gone; drop its persisted pid so a future reap never
      // targets a recycled pid.
      if (settings.mode === 'ssh') runtimeStore.removeLocalTunnelState(settings)
      if (this.stopped) return
      if (service.child._dshStopRequested) return
      if (this.status.state !== 'connecting' && this.status.state !== 'ready') return
      const why = `SSH 隧道断开（code=${code} signal=${signal ?? ''}）`
      this.log(why)
      if (this.tunnelRetries < TUNNEL_RETRIES) {
        this.tunnelRetries += 1
        const delay = 2000 * this.tunnelRetries
        this.setStatus({ detail: `隧道断开，${delay / 1000} 秒后重连（第 ${this.tunnelRetries}/${TUNNEL_RETRIES} 次）…` })
        setTimeout(() => {
          if (epoch !== this.connectEpoch) return
          if (this.stopped) return
          if (this.status.state !== 'connecting' && this.status.state !== 'ready') return
          // Re-acquire a fresh local forward port: the old one may still be
          // held by the dying ssh process or taken by another process.
          this.startTunnelOnFreePort(settings, rport).then(async () => {
            if (epoch !== this.connectEpoch || this.stopped) return
            const ready = await waitReady(this.url(), 15_000)
            if (epoch !== this.connectEpoch || this.stopped) return
            this.tunnelRetries = 0
            this.setStatus({
              state: 'ready',
              url: this.url(),
              detail: ready.isDsh
                ? `隧道已恢复（${displayLabel(settings.ssh.host)}）`
                : `隧道已恢复，但端口响应可能不是 DeepSeek Harness`,
              serviceOwner: 'remote',
            })
          }).catch(error => {
            if (this.stopped) return
            this.log(`隧道重连失败：${String(error.message || error)}`)
            this.setStatus({ state: 'error', detail: String(error.message || error) })
          })
        }, delay)
      } else {
        this.setStatus({ state: 'error', detail: `${why}。请检查网络与 SSH 配置后「重新连接」。` })
      }
    })
    // The tunnel is up once the local forward port accepts TCP connections;
    // the remote web service may still be starting and is waited on separately.
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (this.tunnelChild === null || this.tunnelChild.exitCode !== null) {
        throw new Error('隧道启动失败（本地转发端口可能已被占用）。请打开服务日志排查。')
      }
      if (await tcpProbe(localPort)) {
        this.tunnelRetries = 0
        // Persist the live tunnel's pid so a later force-killed shell can
        // still reap this detached `ssh -N -L` on its next run.
        runtimeStore.writeLocalTunnelState(settings, {
          pid: service.child.pid,
          localPort,
          remotePort: rport,
        })
        return
      }
      await sleep(300)
    }
    // Kill only the child this call spawned: tunnelChild may have been
    // replaced by a newer startTunnel by the time the deadline fires.
    if (service.child.exitCode === null && service.child.signalCode === null) this.killChild(service.child)
    throw new Error('隧道建立超时。请检查 SSH 配置后「重新连接」。')
  }

  async remoteServiceDir(settings) {
    const active = await runtimeStore.remoteActiveRuntimeDir(
      settings,
      (host, inner, options) => this.remoteRun(host, inner, options),
    )
    return active ?? remotePath(settings.ssh.remoteRepoDir)
  }

  async startRemoteService(settings, remotePort, version) {
    const dir = await this.remoteServiceDir(settings)
    const check = await this.remoteRun(
      settings.ssh.host,
      `if test -f ${dir}/apps/cli/lib/bin.js || test -f ${dir}/node_modules/@deepseek-ai/dsh/lib/bin.js; then echo bin-ok; else echo bin-missing; fi`,
      { timeoutMs: 20_000 },
    )
    if (check.code !== 0 || !check.lines.includes('bin-ok')) {
      throw new Error(
        `远程运行时尚未构建（${dir} 缺少 apps/cli/lib/bin.js 或官方产物）。请在顶部菜单「更新 → 更新并重启」完成远程构建/安装。`,
      )
    }
    return this.launchRemoteService(settings, remotePort ?? 0, version)
  }

  /**
   * Start the remote web service detached with `--port 0`, wait for the CLI's
   * `dsh web: http://127.0.0.1:<port>` line, and record pid/port/version in
   * ~/.dsh/desktop-web.state.json so a later shell can adopt or upgrade it.
   */
  async launchRemoteService(settings, remotePort = 0, version = 'unknown') {
    const dir = await this.remoteServiceDir(settings)
    const logFile = runtimeStore.REMOTE_LOG_FILE
    const pidFile = runtimeStore.REMOTE_PID_FILE
    const portFile = runtimeStore.REMOTE_PORT_FILE
    this.log(remotePort === 0
      ? '启动远程 dsh web（由系统分配端口）…'
      : `启动远程 dsh web（端口 ${remotePort}）…`)

    // The runtime dir may be a repo-layout checkout (apps/cli/lib/bin.js)
    // or an npm-layout official artifact; resolve the bin inside the remote
    // shell so one launcher covers both.
    // No `--no-open` here: the remote service always starts through ssh, so
    // the harness sees SSH_CONNECTION/SSH_TTY and skips the default-browser
    // handoff on its own. Older remote harnesses (and older official
    // artifacts) don't recognize `--no-open`, so passing it would abort the
    // boot with "unknown option".
    const runNode = `cd ${dir} && BIN=apps/cli/lib/bin.js; [ -f "$BIN" ] || BIN=node_modules/@deepseek-ai/dsh/lib/bin.js; exec node "$BIN" web --port ${remotePort} > ${portFile} 2>> ${logFile} < /dev/null`
    const startCommand = `if command -v setsid >/dev/null 2>&1; then setsid sh -c ${shellQuote(runNode)} </dev/null >/dev/null 2>&1 & else nohup sh -c ${shellQuote(runNode)} >/dev/null 2>&1 </dev/null & fi; echo $! > ${pidFile}`
    const start = await this.remoteRun(
      settings.ssh.host,
      `${remoteToolchainPrefix()} mkdir -p "$HOME"/.dsh; rm -f ${portFile}; ${startCommand}`,
      { timeoutMs: 20_000 },
    )
    if (start.code !== 0) throw new Error(`远程服务启动失败：${start.lines.join('\n')}`)

    const wait = await this.remoteRun(
      settings.ssh.host,
      `pid=$(cat ${pidFile} 2>/dev/null || true); for i in $(seq 1 150); do line=$(tr -d '\\r' < ${portFile} 2>/dev/null | head -1); case "$line" in "dsh web: "*) echo "$line"; exit 0 ;; esac; if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then echo service-exited; tail -n 20 ${logFile} 2>/dev/null; exit 1; fi; sleep 0.2; done; echo port-timeout; exit 1`,
      { timeoutMs: 60_000 },
    )
    const announced = wait.lines.map(line => runtimeStore.parseDshWebUrl(line)).find(Boolean)
    if (announced === null || announced === undefined) {
      throw new Error(`远程服务未报告监听端口：${wait.lines.slice(-6).join('\n')}`)
    }
    const pidResult = await this.remoteRun(
      settings.ssh.host,
      `cat ${pidFile} 2>/dev/null || echo 0`,
      { timeoutMs: 15_000 },
    )
    const pid = Number((pidResult.lines[0] ?? '0').trim())
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('远程服务 pid 读取失败。')
    this.remotePort = announced.port
    await this.writeRemoteState(settings, { pid, port: announced.port, version })
    this.log(`远程 dsh web 已监听端口 ${announced.port}。`)
    return announced.port
  }

  async restartRemoteService(settings) {
    const pidFile = runtimeStore.REMOTE_PID_FILE
    this.log('停止远程服务…')
    // The state-recorded pid is authoritative for this device (it survives
    // launches by other shell instances); the pid file is the fallback when
    // the state is missing or stale.
    const state = await this.readRemoteState(settings)
    const pid = state !== null && Number.isInteger(state.pid) && state.pid > 0
      ? state.pid
      : `$(cat ${pidFile} 2>/dev/null)`
    await this.remoteRun(
      settings.ssh.host,
      `kill ${pid} 2>/dev/null || true`,
      { timeoutMs: 15_000 },
    )
    await sleep(1500)
    const version = await this.serviceVersion(settings)
    return this.launchRemoteService(settings, 0, version)
  }
}

module.exports = { ConnectionManager, probeOnce, waitReady }
