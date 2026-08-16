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
const {
  findFreePort, releasePort, releaseRemotePort, reservePort, reserveRemotePort, reservedRemotePorts, runExclusive, tcpProbe,
} = require('./ports')

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
    this.reservedRemotePort = null
    this.remoteHostKey = null
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

  /** Find + reserve a free port on one remote host's loopback interface. */
  async acquireRemotePort(settings, start) {
    const hostKey = `ssh:${settings.ssh.host}`
    // One remote probe covers the whole +30 range and is serialized per host,
    // so two sessions targeting the same host can never both observe the same
    // free port and race each other to it.
    return runExclusive(hostKey, async () => {
      this.releaseReservedRemotePort()
      const reserved = reservedRemotePorts(hostKey)
      const skip = reserved.length === 0
        ? ''
        : `case " ${reserved.join(' ')} " in *" $p "*) continue ;; esac;`
      const script = `for p in $(seq ${start} $(( ${start} + 30 ))); do ${skip} if (exec 3<>/dev/tcp/127.0.0.1/$p) 2>/dev/null; then :; else echo $p; break; fi; done`
      const result = await this.remoteRun(settings.ssh.host, script, { timeoutMs: 20_000 })
      const found = result.lines.map(line => line.trim()).find(line => /^\d+$/.test(line))
      if (!found) throw new Error(`远程端口 ${start} 起连续 31 个端口都被占用，无法启动服务。`)
      const port = Number(found)
      if (!reserveRemotePort(hostKey, port)) {
        throw new Error(`远程端口 ${port} 刚被其他工作区预留，请重试连接。`)
      }
      this.reservedRemotePort = port
      this.remoteHostKey = hostKey
      if (port !== start) this.log(`远程端口 ${start} 已被占用，改用 ${port}。`)
      return port
    })
  }

  releaseReservedRemotePort() {
    if (this.reservedRemotePort !== null && this.remoteHostKey !== null) {
      releaseRemotePort(this.remoteHostKey, this.reservedRemotePort)
    }
    this.reservedRemotePort = null
    this.remoteHostKey = null
  }

  releaseReservedPorts() {
    this.releaseReservedLocalPort()
    this.releaseReservedRemotePort()
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
    return path.join(expandHome(settings.local.dshHome), 'desktop-web.state.json')
  }

  readLocalState(settings) {
    try {
      const state = JSON.parse(fs.readFileSync(this.localStatePath(settings), 'utf8'))
      if (Number.isInteger(state.pid) && Number.isInteger(state.port) && typeof state.version === 'string') return state
    } catch {
      // A missing/corrupt state file just means "no previously owned service".
    }
    return null
  }

  writeLocalState(settings, state) {
    try {
      fs.writeFileSync(this.localStatePath(settings), JSON.stringify(state, null, 2))
    } catch {
      // State persistence is best-effort; a read-only home must not break serving.
    }
  }

  async readRemoteState(settings) {
    const stateFile = '"$HOME"/.dsh/desktop-web.state.json'
    const result = await this.remoteRun(
      settings.ssh.host,
      `cat ${stateFile} 2>/dev/null || echo __none__`,
      { timeoutMs: 15_000 },
    )
    if (result.code !== 0) return null
    const text = result.lines.join('\n').trim()
    if (text === '' || text === '__none__') return null
    try {
      const state = JSON.parse(text)
      if (Number.isInteger(state.pid) && Number.isInteger(state.port) && typeof state.version === 'string') return state
    } catch {
      // A corrupt remote state file degrades to "no service".
    }
    return null
  }

  async writeRemoteState(settings, state) {
    const stateFile = '"$HOME"/.dsh/desktop-web.state.json'
    // versionToken guarantees a JSON/shell-safe token; pid/port are integers.
    await this.remoteRun(
      settings.ssh.host,
      `printf '{"pid":%s,"port":%s,"version":"%s"}' "${state.pid}" "${state.port}" "${versionToken(state.version)}" > ${stateFile}`,
      { timeoutMs: 15_000 },
    )
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
      await this.remoteRun(
        settings.ssh.host,
        'rm -f "$HOME"/.dsh/desktop-web.pid "$HOME"/.dsh/desktop-web.state.json 2>/dev/null || true',
        { timeoutMs: 15_000 },
      )
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
      try {
        fs.rmSync(this.localStatePath(settings), { force: true })
      } catch {
        // Best-effort; a read-only home must not block the reset.
      }
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
      // A first-run pipeline has no tunnel yet; bring one up so the readiness
      // wait has something to probe through. connect() replaces it afterwards.
      if (this.tunnelChild === null) {
        await this.startTunnelOnFreePort(settings)
      }
      await this.restartRemoteService(settings)
      await waitReady(this.url())
      return
    }
    if (this.localChild !== null) {
      this.log('重启本地服务…')
      this.killChild(this.localChild)
      this.localChild = null
      await waitReady(this.url())
      this.localRetries = 0
      return
    }
    const probe = await probeOnce(this.url())
    if (probe.up) {
      this.log('服务由外部进程托管，跳过重启')
      return
    }
    await this.spawnLocalService(settings)
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

    const port = await this.acquireLocalPort(settings.local.port)
    try {
      await this.spawnLocalService(settings, port, version)
    } catch (error) {
      this.releaseReservedLocalPort()
      throw error
    }
    const ready = await waitReady(this.url())
    this.localRetries = 0
    this.setStatus({
      state: 'ready',
      url: this.url(),
      detail: ready.isDsh
        ? (port !== settings.local.port ? `已连接（端口 ${port}）` : '已连接')
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

  async spawnLocalService(settings, port, version) {
    const tools = this.resolvedTools()
    const servePort = port ?? this.localPort ?? settings.local.port
    const serveVersion = version ?? this.localVersion ?? 'unknown'
    this.localPort = servePort
    this.localVersion = serveVersion
    const binPath = path.join(settings.local.repoDir, 'apps/cli/lib/bin.js')
    try {
      fs.accessSync(binPath, fs.constants.R_OK)
    } catch {
      throw new Error(
        `仓库尚未构建（缺少 ${binPath}）。请在顶部菜单「更新 → 更新并重启」完成首次构建。`,
      )
    }
    this.log(`启动 dsh web（端口 ${servePort}，数据目录 ${settings.local.dshHome}）…`)
    this.prepareLocalHome(settings)
    const service = spawnService({
      cmd: tools.node,
      args: [binPath, 'web', '--port', String(servePort)],
      cwd: settings.local.repoDir,
      env: { ...tools.env, DSH_HOME: expandHome(settings.local.dshHome) },
      onLine: line => this.log(`[web] ${line}`),
    })
    this.localChild = service.child
    this.writeLocalState(settings, { pid: service.child.pid, port: servePort, version: serveVersion })
    service.child.on('close', (code, signal) => {
      this.localChild = null
      if (this.stopped) return
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
          this.spawnLocalService(settings).catch(() => {})
        }, delay)
      } else {
        this.setStatus({ state: 'error', detail: `${why}。请打开服务日志排查，或检查端口是否被占用。` })
      }
    })
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

    // Pick a free port on the remote loopback, then tunnel to it.
    const remotePort = await this.acquireRemotePort(settings, settings.ssh.remotePort)
    this.remotePort = remotePort
    try {
      await this.startTunnelOnFreePort(settings, remotePort)
    } catch (error) {
      this.releaseReservedRemotePort()
      throw error
    }
    const url = this.url()
    const probe = await probeOnce(url)
    if (!probe.up) await this.startRemoteService(settings, remotePort, version)
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
      const clone = await this.remoteRun(
        target,
        `mkdir -p ${dir} && git clone ${shellQuote(url)} ${dir}`,
        { timeoutMs: 10 * 60_000, onLine: line => this.log(`[git] ${line}`) },
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
    await this.launchRemoteService(settings, remotePort, version)
  }

  /**
   * Start the remote web service detached, recording its pid in
   * ~/.dsh/desktop-web.pid and its version/port in ~/.dsh/desktop-web.state.json
   * so a later shell can adopt or upgrade it.
   */
  async launchRemoteService(settings, remotePort, version) {
    const dir = remotePath(settings.ssh.remoteRepoDir)
    const bin = `${dir}/apps/cli/lib/bin.js`
    const logFile = '"$HOME"/.dsh/desktop-web.log'
    const pidFile = '"$HOME"/.dsh/desktop-web.pid'
    const stateFile = '"$HOME"/.dsh/desktop-web.state.json'
    const port = remotePort ?? this.remotePort ?? settings.ssh.remotePort
    const token = versionToken(version)
    this.log(`启动远程 dsh web（端口 ${port}）…`)
    const result = await this.remoteRun(
      settings.ssh.host,
      // mkdir runs in the foreground first (`;`), so the pid/state redirects
      // below never race the directory creation.
      `${remoteToolchainPrefix()} mkdir -p "$HOME"/.dsh; cd ${dir} && exec nohup node ${bin} web --port ${port} >> ${logFile} 2>&1 < /dev/null & pid=$!; echo "$pid" > ${pidFile}; printf '{"pid":%s,"port":%s,"version":"%s"}' "$pid" "${port}" "${token}" > ${stateFile}`,
      { timeoutMs: 20_000 },
    )
    if (result.code !== 0) throw new Error(`远程服务启动失败：${result.lines.join('\n')}`)
  }

  async restartRemoteService(settings, remotePort) {
    const pidFile = '"$HOME"/.dsh/desktop-web.pid'
    this.log('停止远程服务…')
    await this.remoteRun(
      settings.ssh.host,
      `kill $(cat ${pidFile} 2>/dev/null) 2>/dev/null || true`,
      { timeoutMs: 15_000 },
    )
    await sleep(1500)
    const version = await this.currentVersion(settings)
    await this.launchRemoteService(settings, remotePort, version)
  }
}

module.exports = { ConnectionManager, probeOnce, waitReady }
