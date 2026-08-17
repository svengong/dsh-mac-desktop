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
const { EventEmitter } = require('node:events')
const { runCommand, spawnService } = require('./runner')
const { sshCommandArgs, tunnelArgs, shellQuote, remotePath, remoteToolchainPrefix, displayLabel } = require('./ssh')
const { resolveTools } = require('./tools')
const { findFreePort, releasePort, reservePort, tcpProbe } = require('./ports')
const runtimeStore = require('./runtime-store')

const PROBE_INTERVAL_MS = 750
const READY_TIMEOUT_MS = 90 * 1000
const SERVICE_RETRIES = 3
const TUNNEL_RETRIES = 5
const LOG_RING_LINES = 300

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

/** Normalize a version fingerprint into a shell/JSON-safe token. */
function versionToken(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64) || 'unknown'
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

function isGitRepo(dir) {
  try {
    fs.statSync(path.join(dir, '.git'))
    return true
  } catch {
    return false
  }
}

/** Expand a leading `~/` against the user's home directory. */
function expandHome(dir) {
  const { homedir } = require('node:os')
  if (dir === '~') return homedir()
  if (dir.startsWith('~/')) return path.join(homedir(), dir.slice(2))
  return dir
}

class ConnectionManager extends EventEmitter {
  constructor({ getSettings, onLog }) {
    super()
    this.getSettings = getSettings
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
  }

  url() {
    const settings = this.getSettings()
    // The window always follows the port that actually serves: the fallback
    // port for a local instance, or the fallback forward port for a tunnel.
    if (settings.mode === 'ssh') return `http://127.0.0.1:${this.localPort ?? settings.ssh.localPort}`
    return `http://127.0.0.1:${this.localPort ?? settings.local.port}`
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
   * The build fingerprint of the checkout the settings point at. A git HEAD is
   * the primary token; a missing/empty repo falls back to the built `bin.js`
   * mtime so a rebuild still trips an upgrade.
   */
  async currentVersion(settings) {
    if (settings.mode === 'local') {
      const tools = this.resolvedTools()
      if (tools.git !== '') {
        const result = await runCommand({
          cmd: tools.git,
          args: ['-C', settings.local.repoDir, 'rev-parse', 'HEAD'],
          timeoutMs: 10_000,
        })
        const head = result.code === 0 ? result.lines.map(line => line.trim()).find(Boolean) : ''
        if (head) return versionToken(head)
      }
      try {
        const stat = fs.statSync(path.join(settings.local.repoDir, 'apps/cli/lib/bin.js'))
        return `mtime:${stat.mtimeMs}`
      } catch {
        return 'unknown'
      }
    }
    const dir = remotePath(settings.ssh.remoteRepoDir)
    const result = await this.remoteRun(
      settings.ssh.host,
      `git -C ${dir} rev-parse HEAD 2>/dev/null || stat -f %m ${dir}/apps/cli/lib/bin.js 2>/dev/null || echo unknown`,
      { timeoutMs: 15_000 },
    )
    const line = result.lines.map(text => text.trim()).find(Boolean)
    return versionToken(line || 'unknown')
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
    // The inner command is single-quoted for the remote shell that sshd
    // invokes, so `-c` receives the whole command as one argument.
    const command = `${shellPath} -l -c ${shellQuote(inner)}`
    return runCommand({
      cmd: tools.ssh,
      args: sshCommandArgs(target, command),
      timeoutMs,
      onLine,
    })
  }

  async remoteLoginShell(target) {
    if (this.cachedRemoteShell !== '') return this.cachedRemoteShell
    const tools = this.resolvedTools()
    for (const candidate of ['zsh', 'bash', 'sh']) {
      const result = await runCommand({
        cmd: tools.ssh,
        args: sshCommandArgs(target, `command -v ${candidate}`),
        timeoutMs: 15_000,
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
      try {
        fs.accessSync(path.join(settings.local.repoDir, 'apps/cli/lib/bin.js'), fs.constants.R_OK)
        return true
      } catch {
        return false
      }
    }
    const bin = `${remotePath(settings.ssh.remoteRepoDir)}/apps/cli/lib/bin.js`
    const result = await this.remoteRun(settings.ssh.host, `test -f ${bin} && echo yes || echo no`)
    // A non-zero exit here is a connectivity/ssh failure, not a "not built"
    // verdict: let the caller surface it as a connection problem.
    if (result.code !== 0) throw new Error(`无法检查远端构建状态：${result.lines.join('\n')}`)
    return result.lines.includes('yes')
  }

  /** Connect per the current settings; failures surface via the status event. */
  async connect() {
    const settings = this.getSettings()
    this.stopped = false
    this.tools = null
    this.cachedRemoteShell = ''
    this.localRetries = 0
    this.tunnelRetries = 0
    this.localPort = null
    this.remotePort = null
    this.localVersion = null
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
    if (settings.mode === 'ssh') {
      // Start the new remote service first (it reports the OS-chosen port),
      // then rebuild the local forward to that exact port.
      await this.restartRemoteService(settings)
      await this.startTunnelOnFreePort(settings, this.remotePort)
      await waitReady(this.url())
      return
    }
    if (this.localChild !== null) {
      this.log('重启本地服务…')
      this.killChild(this.localChild)
      this.localChild = null
      this.localPort = null
      await this.spawnLocalService(settings, 0)
      await waitReady(this.url())
      this.localRetries = 0
      return
    }
    const probe = await probeOnce(this.url())
    if (probe.up) {
      this.log('服务由外部进程托管，跳过重启')
      return
    }
    this.localPort = null
    await this.spawnLocalService(settings, 0)
    await waitReady(this.url())
  }

  // ── local mode ────────────────────────────────────────────────────────────

  async connectLocal(settings) {
    const tools = this.resolvedTools()
    if (tools.node === '') {
      throw new Error('未找到兼容的 node（需 22.19+ 或 24+）。请安装 Node.js，或在「设置 → 高级」中手动指定 node 路径。')
    }
    await this.ensureLocalRepo(settings)
    const version = await this.currentVersion(settings)
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
   * Local counterpart of ensureRemoteRepo: clone from `local.repoUrl` when the
   * directory is missing or not a git repo, with a clear error when no URL is
   * configured and nothing to clone from.
   */
  async ensureLocalRepo(settings) {
    if (isGitRepo(settings.local.repoDir)) return { code: 0, lines: [] }
    const tools = this.resolvedTools()
    if (settings.local.repoUrl === '') {
      throw new Error(
        `仓库目录 ${settings.local.repoDir} 不存在或不是 git 仓库。\n` +
        '请在「连接设置」中填写「仓库地址」（git URL），由壳自动克隆；或改为已有的 deepseek-harness 检出目录。',
      )
    }
    if (tools.git === '') throw new Error('未找到 git，无法克隆仓库。请在「设置 → 高级」中指定 git 路径。')
    this.log(`克隆 ${settings.local.repoUrl} 到 ${settings.local.repoDir} …`)
    const lockName = `clone-${path.basename(settings.local.repoDir)}`
    return runtimeStore.withLocalLock(settings, lockName, async () => {
      // Another process may have won the clone race while we waited.
      if (isGitRepo(settings.local.repoDir)) return { code: 0, lines: [] }
      const result = await runCommand({
        cmd: tools.git,
        // Bypass user-global hooks (pre-commit/lfs shims): they assume a full
        // developer environment and can fail a clean-env clone, and the repo
        // has no LFS content to materialize.
        args: ['-c', 'core.hooksPath=/dev/null', 'clone', settings.local.repoUrl, settings.local.repoDir],
        env: tools.env,
        timeoutMs: 10 * 60_000,
        onLine: line => this.log(`[git] ${line}`),
      })
      if (result.code !== 0) throw new Error(`本地 git clone 失败：${result.lines.join('\n')}`)
      return { code: 0, lines: [] }
    }, { timeoutMs: 10 * 60_000 + 30_000 })
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
    const binPath = path.join(settings.local.repoDir, 'apps/cli/lib/bin.js')
    try {
      fs.accessSync(binPath, fs.constants.R_OK)
    } catch {
      throw new Error(
        `仓库尚未构建（缺少 ${binPath}）。请在顶部菜单「更新 → 更新并重启」完成首次构建。`,
      )
    }
    this.log(`启动 dsh web（${port === 0 ? '由系统分配端口' : `端口 ${port}`}，数据目录 ${settings.local.dshHome}）…`)
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
      args: [binPath, 'web', '--port', String(port)],
      cwd: settings.local.repoDir,
      env: { ...tools.env, DSH_HOME: expandHome(settings.local.dshHome) },
      onLine: line => {
        this.log(`[web] ${line}`)
        const parsed = runtimeStore.parseDshWebUrl(line)
        if (parsed !== null && parsed.port > 0) resolvePort(parsed.port)
      },
    })
    this.localChild = service.child

    const closeWatcher = (code, signal) => {
      this.localChild = null
      rejectPort(new Error(`本地服务启动失败（code=${code} signal=${signal ?? ''}）`))
      if (this.stopped || service.child._dshStopRequested) return
      if (this.status.state !== 'connecting' && this.status.state !== 'ready') return
      const why = `本地服务退出（code=${code} signal=${signal ?? ''}）`
      this.log(why)
      if (this.localRetries < SERVICE_RETRIES) {
        this.localRetries += 1
        const delay = 1000 * this.localRetries
        this.setStatus({ detail: `服务退出，${delay / 1000} 秒后重启（第 ${this.localRetries}/${SERVICE_RETRIES} 次）…` })
        setTimeout(() => {
          if (this.stopped) return
          if (this.status.state !== 'connecting' && this.status.state !== 'ready') return
          // Restart with a fresh OS-chosen port; a stale bound port can never
          // force a crash-loop.
          this.spawnLocalService(settings, 0, serveVersion).catch(() => {})
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
      this.killChild(this.localChild)
      this.localChild = null
      throw error
    }
  }

  // ── ssh mode ──────────────────────────────────────────────────────────────

  async connectSsh(settings) {
    const tools = this.resolvedTools()
    const target = settings.ssh.host
    this.log(`测试 SSH 连接 ${target} …`)
    const test = await runCommand({
      cmd: tools.ssh,
      args: sshCommandArgs(target, 'echo dsh-ok'),
      timeoutMs: 15_000,
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
    await this.ensureRemoteRepo(settings)
    const version = await this.currentVersion(settings)
    const state = await this.readRemoteState(settings)

    // Reuse a previously started remote service when its build still matches.
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

    // Reap a stale/outdated remote service before starting a fresh one.
    if (state !== null && Number.isInteger(state.pid)) {
      this.log(`清理旧版/残留远端服务（pid ${state.pid}）…`)
      await this.remoteRun(target, `kill ${state.pid} 2>/dev/null || true`, { timeoutMs: 15_000 })
      await sleep(800)
    }

    // Start the remote service with `--port 0`; the CLI reports the real
    // loopback port, which removes remote-port probing entirely.
    const remotePort = await this.launchRemoteService(settings, 0, version)
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

  async ensureRemoteRepo(settings) {
    const target = settings.ssh.host
    const dir = remotePath(settings.ssh.remoteRepoDir)
    const url = settings.ssh.remoteRepoUrl
    this.log(`检查远程仓库 ${settings.ssh.remoteRepoDir} …`)
    const check = await this.remoteRun(
      target,
      `if [ -d ${dir}/.git ]; then echo repo-ready; elif [ -e ${dir} ]; then echo repo-not-git; else echo repo-missing; fi`,
      { timeoutMs: 20_000 },
    )
    if (check.code !== 0) throw new Error(`检查远程仓库失败：${check.lines.join('\n')}`)
    const verdict = check.lines.find(line => line.startsWith('repo-'))
    if (verdict === 'repo-not-git') {
      throw new Error(`远程目录 ${settings.ssh.remoteRepoDir} 已存在但不是 git 仓库。请更换远程仓库目录。`)
    }
    if (verdict === 'repo-missing') {
      if (settings.ssh.remoteRepoUrl === '') {
        throw new Error(
          `远程目录 ${settings.ssh.remoteRepoDir} 不存在，且未填写「远程仓库地址」。\n` +
          '请填写 git URL 由壳自动克隆，或改为远端已有的检出目录。',
        )
      }
      this.log(`克隆 ${url} 到远程 ${settings.ssh.remoteRepoDir} …`)
      const clone = await runtimeStore.withRemoteLock(
        settings,
        (host, inner, options) => this.remoteRun(host, inner, options),
        `clone-${settings.ssh.host}-${settings.ssh.remoteRepoDir}`,
        async () => {
          // Re-check inside the lock; another shell may have finished clone.
          const inside = await this.remoteRun(
            target,
            `if [ -d ${dir}/.git ]; then echo repo-ready; else echo repo-missing; fi`,
            { timeoutMs: 20_000 },
          )
          if (inside.lines.includes('repo-ready')) return { code: 0, lines: [] }
          return this.remoteRun(
            target,
            `mkdir -p ${dir} && git -c core.hooksPath=/dev/null clone ${shellQuote(url)} ${dir}`,
            { timeoutMs: 10 * 60_000, onLine: line => this.log(`[git] ${line}`) },
          )
        },
        { timeoutMs: 10 * 60_000 + 30_000 },
      )
      if (clone.code !== 0) throw new Error(`远程 git clone 失败：${clone.lines.join('\n')}`)
    }
    return { code: 0, lines: [] }
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
    service.child.on('close', (code, signal) => {
      this.tunnelChildren.delete(service.child)
      if (this.tunnelChild === service.child) this.tunnelChild = null
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
          if (this.stopped) return
          if (this.status.state !== 'connecting' && this.status.state !== 'ready') return
          this.startTunnel(settings, this.localPort ?? settings.ssh.localPort).catch(() => {})
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
        return
      }
      await sleep(300)
    }
    if (this.tunnelChild !== null && this.tunnelChild.exitCode === null) this.killChild(this.tunnelChild)
    throw new Error('隧道建立超时。请检查 SSH 配置后「重新连接」。')
  }

  async startRemoteService(settings, remotePort, version) {
    const dir = remotePath(settings.ssh.remoteRepoDir)
    const bin = `${dir}/apps/cli/lib/bin.js`
    const check = await this.remoteRun(
      settings.ssh.host,
      `test -f ${bin} && echo bin-ok || echo bin-missing`,
      { timeoutMs: 20_000 },
    )
    if (check.code !== 0 || !check.lines.includes('bin-ok')) {
      throw new Error(
        `远程仓库尚未构建（${settings.ssh.remoteRepoDir}/apps/cli/lib/bin.js 不存在）。请在顶部菜单「更新 → 更新并重启」完成远程构建。`,
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
    const dir = remotePath(settings.ssh.remoteRepoDir)
    const bin = `${dir}/apps/cli/lib/bin.js`
    const logFile = runtimeStore.REMOTE_LOG_FILE
    const pidFile = runtimeStore.REMOTE_PID_FILE
    const portFile = runtimeStore.REMOTE_PORT_FILE
    this.log(remotePort === 0
      ? '启动远程 dsh web（由系统分配端口）…'
      : `启动远程 dsh web（端口 ${remotePort}）…`)

    const start = await this.remoteRun(
      settings.ssh.host,
      `${remoteToolchainPrefix()} mkdir -p "$HOME"/.dsh; rm -f ${portFile}; cd ${dir} && nohup node ${bin} web --port ${remotePort} > ${portFile} 2>> ${logFile} < /dev/null & echo $! > ${pidFile}`,
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
    await this.remoteRun(
      settings.ssh.host,
      `kill $(cat ${pidFile} 2>/dev/null) 2>/dev/null || true`,
      { timeoutMs: 15_000 },
    )
    await sleep(1500)
    const version = await this.currentVersion(settings)
    return this.launchRemoteService(settings, 0, version)
  }
}

module.exports = { ConnectionManager, probeOnce, waitReady }
