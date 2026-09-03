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
const { runCommand, spawnService, SERVICE_PID_PREFIX } = require('./runner')
const { sshCommandArgs, tunnelArgs, shellQuote, remotePath, remoteToolchainPrefix, displayLabel } = require('./ssh')
const { resolveTools } = require('./tools')
const { findFreePort, releasePort, reservePort, tcpProbe } = require('./ports')
const { runtimeLayout } = require('./runtime-layout')
const runtimeStore = require('./runtime-store')
const { compareVersions } = require('./components')

const PROBE_INTERVAL_MS = 750
const READY_TIMEOUT_MS = 90 * 1000
const SERVICE_RETRIES = 3
const TUNNEL_RETRIES = 5
const LOG_RING_LINES = 300
// Seamless-reconnect watchdog: probe the service URL this often while the
// connection is `ready`, and treat this many consecutive failed probes as
// "the service restarted out from under us" (plugin install, in-process
// reload, an externally-owned or remote service restarting on a new port).
const HEALTH_INTERVAL_MS = 4000
const HEALTH_FAILURE_THRESHOLD = 2
// Grace period for following a peer shell that is mid-startup, before we
// conclude nothing is serving and take over the restart ourselves. Long enough
// to cover a peer's port announcement (it polls every 200ms for up to 30s, but
// a healthy host announces in a couple of seconds), short enough that a genuine
// restart only ever pays a few seconds of delay.
const PEER_WAIT_INTERVAL_MS = 1000
const PEER_WAIT_ATTEMPTS = 6
// `dsh web --no-open` landed in the official artifact at 0.1.1-rc.1 (the
// "open the ready Web UI by default" change). Older artifacts abort the boot
// on the unknown option, so only runtimes at or above this floor are given the
// flag; anything older keeps opening a browser tab on startup (harmless, just
// noise) rather than failing to start at all.
const NO_OPEN_MIN_VERSION = '0.1.1-rc.1'

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
/**
 * Probe a web URL once.
 *
 * Two details matter since `dsh web` started gating its index behind a
 * launch-token cookie (0.1.2-alpha):
 *
 * - A redirect is FOLLOWED, carrying any `set-cookie` the previous hop minted.
 *   The token URL answers 303 to a clean `/` and only serves index.html to a
 *   request that presents the cookie, so a probe that stops at the redirect
 *   sees an empty body and would call a healthy harness "not dsh".
 * - A 401 whose body is the harness's own auth notice counts as dsh. The
 *   service is up and answering; it simply has not been handed a token yet.
 *   Treating that as "not dsh" made the reuse path reject its own service and
 *   respawn on every connect.
 * @param {string} url - target URL (may carry the one-shot `token` query).
 * @param {object} options - headers to send, remaining redirect hops.
 * @returns {Promise<{up: boolean, isDsh: boolean}>}
 */
function probeOnce(url, { headers = null, hops = 3 } = {}) {
  return new Promise(resolve => {
    const options = { timeout: 2000 }
    if (headers !== null && headers !== undefined) options.headers = headers
    const request = http.get(url, options, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        const status = response.statusCode ?? 0
        const location = response.headers.location
        if (hops > 0 && status >= 300 && status < 400 && typeof location === 'string' && location !== '') {
          let next = ''
          try {
            next = new URL(location, url).href
          } catch {
            next = ''
          }
          const cookies = response.headers['set-cookie']
          const carried = Array.isArray(cookies) && cookies.length > 0
            ? { cookie: cookies.map(entry => String(entry).split(';')[0]).join('; ') }
            : headers
          if (next !== '') {
            resolve(probeOnce(next, { headers: carried, hops: hops - 1 }))
            return
          }
        }
        resolve({
          up: true,
          isDsh: body.includes('__DSH_BOOT__')
            || (status === 401 && body.includes('dsh web authentication required')),
          // True when the service answered with the harness's own auth
          // notice: it is up, but this caller holds neither a launch token
          // nor a live session cookie, so a window pointed at it would
          // render nothing but the 401 page. Callers that have a token URL
          // to present can ignore this; those that do not must restart the
          // service to obtain one.
          needsAuth: status === 401 && body.includes('dsh web authentication required'),
        })
      })
      response.on('error', () => resolve({ up: false, isDsh: false, needsAuth: false }))
    })
    request.on('timeout', () => {
      request.destroy()
      resolve({ up: false, isDsh: false, needsAuth: false })
    })
    request.on('error', () => resolve({ up: false, isDsh: false, needsAuth: false }))
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
 * Move a `dsh web` URL onto another loopback port, keeping everything that
 * makes it authenticated (its `token` query).
 *
 * An ssh device reaches the remote service through a local forward, so the
 * URL the remote CLI printed (`127.0.0.1:<remotePort>/?token=…`) names an
 * authority the browser never talks to. The token itself is port-agnostic —
 * the service mints a cookie bound to the authority of the request that
 * presents it — so re-hosting it on the forward port yields a URL that
 * authenticates against the local end of the tunnel.
 * @param {string} url - the announced URL (may be '').
 * @param {number} port - the port the browser actually reaches.
 * @returns {string} the re-hosted URL, or '' when url is unusable.
 */
function rehostUrl(url, port) {
  if (typeof url !== 'string' || url === '' || !Number.isInteger(port) || port <= 0) return ''
  try {
    const parsed = new URL(url)
    parsed.protocol = 'http:'
    parsed.hostname = '127.0.0.1'
    parsed.port = String(port)
    return parsed.href
  } catch {
    return ''
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

/**
 * Every running `dsh web` host process, with the runtime bin it boots.
 *
 * Needed because the harness can end up running WITHOUT the shell having
 * spawned it: the dsh-market plugin relaunches the host through a detached
 * helper (`dshmarket/src/restart.ts`) whose stdout is redirected to a temp
 * file. The shell's port handshake reads the child's stdout, so it never
 * learns the replacement's port — and the state file keeps pointing at the
 * port the process that just exited was using. The service is healthy and
 * answering; the shell simply has no idea where it went.
 *
 * `node` only, exactly like the remote twin (REMOTE_HOST_SCAN): a
 * `sh/bash -c "… bin.js web …"` wrapper shares the host's command line and
 * killing it would take down the wrapper, not the host. Real hosts always
 * exec node — the local watchParent guard is the one wrapper in play, and it
 * must never be mistaken for a second host (or a keepPid sweep protecting
 * the real service while the wrapper is killed out from under it).
 * @returns {Array<{pid: number, bin: string}>}
 */
async function dshWebProcesses() {
  const result = await runCommand({
    cmd: 'ps',
    args: ['ax', '-o', 'pid=,command='],
    timeoutMs: 5000,
  }).catch(() => null)
  if (result === null || result.code !== 0) return []
  const found = []
  for (const line of result.lines) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
    const command = match[2]
    // `node <bin> web …` — matches both the npm artifact and the repo layout.
    // The command must START with the node binary: launcher shells that merely
    // quote the same argv in their `-c` string are wrappers, not hosts.
    if (!/^(\S*\/)?node(\d+(\.\d+)*)?\s/u.test(command)) continue
    const binMatch = /(\S*(?:@deepseek-ai[\\/]dsh|apps[\\/]cli)[\\/]lib[\\/]bin\.js)\s+web\b/u.exec(command)
    if (binMatch === null) continue
    found.push({ pid, bin: binMatch[1] })
  }
  return found
}

/** Loopback TCP ports one process is listening on. */
async function listeningLoopbackPorts(pid) {
  const result = await runCommand({
    cmd: 'lsof',
    args: ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'],
    timeoutMs: 5000,
  }).catch(() => null)
  if (result === null || result.code !== 0) return []
  const ports = []
  for (const line of result.lines) {
    const match = /(?:127\.0\.0\.1|\[::1\]|localhost):(\d{1,5})\s+\(LISTEN\)/u.exec(line)
    if (match === null) continue
    const port = Number(match[1])
    if (Number.isInteger(port) && port > 0) ports.push(port)
  }
  return ports
}

/**
 * Whether a process has files open under `dshHome` — its settings or
 * credentials. This is what tells two `dsh web` hosts that share one
 * installed runtime apart: the shell must only ever adopt the instance
 * serving ITS dsh home, never a bystander started from another one.
 */
async function processUsesHome(pid, dshHome) {
  if (dshHome === null || dshHome === undefined || dshHome === '') return true
  const result = await runCommand({
    cmd: 'lsof',
    args: ['-Fn', '-p', String(pid)],
    timeoutMs: 5000,
  }).catch(() => null)
  if (result === null || result.code !== 0) return false
  // `lsof` reports paths with symlinks resolved — on macOS `/tmp` comes back
  // as `/private/tmp`. The home has to be resolved the same way, or a home
  // configured under a symlink matches NOTHING: every host then looks like a
  // bystander, the sweep reaps nothing, and an orphan keeps holding the
  // session store. The failure is silent, which is the worst kind here.
  let home = dshHome
  try {
    home = fs.realpathSync(dshHome)
  } catch {
    // Unresolvable (missing or unreadable): match on the path we were given
    // rather than giving up — this check only ever errs toward NOT killing.
  }
  const prefix = home.endsWith('/') ? home : `${home}/`
  // `-Fn` prints one field per line, `n` being the file name.
  return result.lines.some(line => line.startsWith('n') && line.slice(1).startsWith(prefix))
}

/**
 * The process group a pid belongs to, or null when it cannot be determined
 * (already dead, ps missing). Local dsh web services are spawned detached:
 * the watchParent guard shell is the group LEADER and the real node service
 * is its group MEMBER, so "keep this service" must exempt the whole GROUP,
 * not just the one pid the state file happens to record (older builds
 * recorded the wrapper's pid, newer ones the service's — the group covers
 * both).
 * @returns {Promise<number|null>}
 */
async function processGroupOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const result = await runCommand({
    cmd: 'ps',
    args: ['-o', 'pgid=', '-p', String(pid)],
    timeoutMs: 5000,
  }).catch(() => null)
  if (result === null || result.code !== 0 || result.lines.length === 0) return null
  const pgid = Number(result.lines[0].trim())
  return Number.isInteger(pgid) && pgid > 0 ? pgid : null
}

// One round-trip inventory of every `dsh web` host on a remote machine:
// `pid|files-under-home|port,port`. The port scan and the home-ownership
// check are folded into the same `ps` loop on purpose — each remote command
// costs a full ssh handshake, and a remote connect already spends several.
// No single quotes: `shellQuote` wraps the whole thing in them.
// `node` only: a `bash -c "… bin.js web …"` launcher shares the host's
// command line and often its cwd under the home, and killing it would take
// down a wrapper rather than a host. Real hosts always exec node.
const REMOTE_HOST_SCAN = 'ps ax -o pid=,command= 2>/dev/null | grep -E "bin\\.js +web" | grep -v grep | grep -E "^[[:space:]]*[0-9]+[[:space:]]+([^[:space:]]*/)?node([0-9.]*)?[[:space:]]" | sed -E "s/^[[:space:]]*([0-9]+).*/\\1/" | while read p; do uses=$(lsof -Fn -p $p 2>/dev/null | grep -c "^n$HOME/.dsh/"); ports=$(lsof -nP -a -p $p -iTCP -sTCP:LISTEN 2>/dev/null | grep -oE "(127\\.0\\.0\\.1|\\[::1\\]):[0-9]+" | sed -E "s/.*:([0-9]+)$/\\1/" | tr "\\n" "," | sed "s/,$//"); echo "$p|$uses|$ports"; done'

/**
 * Parse `REMOTE_HOST_SCAN` output into host records. Pure so the parsing —
 * the easiest part to get wrong — is testable without an ssh connection.
 * @param {string[]} lines
 * @returns {Array<{pid: number, usesHome: boolean, ports: number[]}>}
 */
function parseRemoteHostScan(lines) {
  const hosts = []
  // Accept a raw string too. `for..of` over a string walks it CHARACTER by
  // character, so a string argument would match nothing and silently yield no
  // hosts — and an empty sweep means "nothing to reap", letting an orphan
  // survive to hold the task-board ledger and crash-loop the next spawn. An
  // empty result is the worst possible answer here, so make it impossible to
  // reach by accident.
  for (const line of typeof lines === 'string' ? lines.split('\n') : lines ?? []) {
    const match = /^(\d+)\|(\d+)\|(.*)$/u.exec(line.trim())
    if (match === null) continue
    const pid = Number(match[1])
    if (!Number.isInteger(pid) || pid <= 0) continue
    hosts.push({
      pid,
      usesHome: Number(match[2]) > 0,
      ports: match[3]
        .split(',')
        .map(value => Number(value))
        .filter(port => Number.isInteger(port) && port > 0),
    })
  }
  return hosts
}

/**
 * Which ports the remote probe reported as serving the dsh boot page.
 * Input lines look like `44571=1`; anything that is not a positive count
 * (curl failed, connection refused, non-dsh listener) is dropped.
 * @param {string[]} lines
 * @returns {Set<number>}
 */
function parseRemoteProbe(lines) {
  const live = new Set()
  // Same string-safety as `parseRemoteHostScan`: an empty probe means "this
  // port is dead", so a miscalled parse would reap a healthy service.
  for (const line of typeof lines === 'string' ? lines.split('\n') : lines ?? []) {
    const match = /^(\d+)=(\d+)$/u.exec(line.trim())
    if (match !== null && Number(match[2]) > 0) live.add(Number(match[1]))
  }
  return live
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
    // The URL `dsh web` announced for the service we are serving RIGHT NOW,
    // launch token included. Since 0.1.2-alpha the index is behind a token-
    // minted cookie, so a bare `http://127.0.0.1:<port>` answers 401 with
    // "dsh web authentication required; reopen the URL printed by dsh web" —
    // exactly what the shell used to hand its windows. Empty until a spawn
    // (or an adopted service's state file) supplies one; url() falls back to
    // the bare form when it is.
    this.localWebUrl = ''
    this.remoteWebUrl = ''
    // The URL the remote CLI printed verbatim (authority = the REMOTE port),
    // kept so it can be re-hosted onto whichever local port the ssh tunnel
    // ends up using. The token survives the move; the authority must change.
    this.remoteAnnouncedUrl = ''
    // Bumped by connect()/stop()/resetService(); stale close watchers and
    // retry timers from a previous connect generation must never spawn a
    // second service or clobber the current child reference.
    this.connectEpoch = 0
    // Health-monitor state (see startHealthMonitor / healthTick).
    this.healthTimer = null
    this.healthFailures = 0
    this.healthInFlight = false
  }

  /** Owner used by runner.js so one terminal's update task can be cancelled. */
  owner() {
    return this.getOwner()
  }

  url() {
    const settings = this.getSettings()
    // The window always follows the port that actually serves: the fallback
    // port for a local instance, or the fallback forward port for a tunnel.
    const port = settings.mode === 'ssh'
      ? this.localPort ?? settings.ssh.localPort
      : this.localPort ?? settings.local.port
    const fallback = `http://127.0.0.1:${port}`
    const announced = settings.mode === 'ssh' ? this.remoteWebUrl : this.localWebUrl
    if (announced === '') return fallback
    // The token belongs to the service that printed it. A restart moves the
    // service to a new OS-chosen port, and presenting a dead service's token
    // to whatever now owns that port would only earn a 401 — so the announced
    // URL is honored only while it names the port that is actually serving.
    return urlPort(announced) === urlPort(fallback) ? announced : fallback
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
    const previous = this.status.state
    this.status = { ...this.status, ...patch }
    // The watchdog runs only while the connection is `ready`; starting it on
    // the ready transition keeps it alive across a service restart that emits
    // a fresh ready, and stopping it elsewhere keeps a stale interval from
    // probing a dead URL during connecting/restarting/error.
    if (this.status.state === 'ready' && previous !== 'ready') this.startHealthMonitor()
    if (this.status.state !== 'ready') this.healthFailures = 0
    this.emit('status', this.status)
  }

  /**
   * Seamless-reconnect watchdog. While the connection is `ready`, probe the
   * service URL periodically; when it stops answering (or stops being a dsh
   * service), reconnect automatically. This covers restarts the shell cannot
   * observe through a child-process `close` event: a plugin install that
   * reloads the harness in-process, an externally-owned service restarting on
   * a new OS-chosen port, or a remote service crashing behind a still-alive
   * tunnel. Without it those cases left the shell pointing at a dead port and
   * forced a manual "重新连接" click.
   */
  startHealthMonitor() {
    if (this.healthTimer !== null) return
    this.healthFailures = 0
    this.healthTimer = setInterval(() => { void this.healthTick() }, HEALTH_INTERVAL_MS)
  }

  stopHealthMonitor() {
    if (this.healthTimer !== null) {
      clearInterval(this.healthTimer)
      this.healthTimer = null
    }
    this.healthFailures = 0
  }

  async healthTick() {
    // Only watch a settled, healthy connection. Connecting/restarting/error
    // states are driven by their own flows (connect retries, close watchers,
    // the restart pipeline); the watchdog must never race them.
    if (this.healthTimer === null) return
    if (this.status.state !== 'ready') {
      this.healthFailures = 0
      return
    }
    if (this.healthInFlight) return
    const url = this.url()
    if (url === '' || urlPort(url) === 0) return
    let probe
    try {
      probe = await probeOnce(url)
    } catch {
      probe = { up: false, isDsh: false }
    }
    if (probe.up && probe.isDsh) {
      this.healthFailures = 0
      return
    }
    // Require consecutive failures so a transient blip (a brief restart
    // window or a slow response) never triggers a full reconnect loop.
    this.healthFailures += 1
    if (this.healthFailures < HEALTH_FAILURE_THRESHOLD) return
    this.healthFailures = 0
    this.log(`健康检查发现服务不可用（${url}），自动重连…`)
    this.healthInFlight = true
    try {
      await this.connect()
    } catch (error) {
      // connect() normally surfaces failures via the status event rather than
      // rejecting; guard against any surprise so the monitor keeps running.
      this.log(`自动重连异常：${String(error.message || error)}`)
    } finally {
      this.healthInFlight = false
    }
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

  /**
   * Reap every `dsh web` host serving this shell's dsh home — the hosts a
   * fresh spawn would have to fight.
   *
   * Only ever called once adoption has been ruled out, so anything still
   * running here is a host we could not reach: the task-board plugin releases
   * its ledger lock only when the owning pid dies (it never probes a port),
   * so a wedged host crash-loops every spawn until it is signalled. Two hosts
   * on one dsh home are illegal regardless — they would fight over the
   * session store — and `processUsesHome` confines this to OUR home so a
   * bystander instance is never touched. The guard shells wrapped around a
   * host hold no files under the home, so they are filtered out too and only
   * real hosts are signalled.
   * @param {object} settings
   * @param {number} [keepPid] - a pid to SPARE: the host we are reusing. Pass
   *   the state file's pid to sweep strays on the reuse path.
   * @returns {Promise<number>} how many host processes were signalled.
   */
  async reapLocalHosts(settings, keepPid = 0) {
    const home = expandHome(settings.local.dshHome)
    if (home === '') return 0
    // A keepPid names ONE process, but a local dsh web is a FAMILY: the
    // watchParent guard shell plus the node service it backgrounds. Older
    // state files record the guard's pid, newer ones the service's — either
    // way the group both live in is the same, so exempting the whole group
    // protects the service a reuse path just validated, whatever pid the
    // state file named. See `processGroupOf`.
    const keepGroup = keepPid > 0 ? await processGroupOf(keepPid) : null
    let reaped = 0
    for (const entry of await dshWebProcesses()) {
      // `keepPid` is the host the state file names, i.e. the one we are about
      // to connect through. Skipping it turns this from "clear everything"
      // into "clear everything ELSE", which is what lets the reuse fast path
      // enforce the one-host-per-home invariant without dropping the service
      // it just validated. See `reapStrayRemoteHosts`.
      if (entry.pid === keepPid) continue
      if (keepGroup !== null && (await processGroupOf(entry.pid)) === keepGroup) continue
      if (!(await processUsesHome(entry.pid, home))) continue
      reaped += 1
      this.log(`清理${keepPid > 0 ? '多余' : '残留'} dsh web（pid ${entry.pid}，${entry.bin}）…`)
      try {
        process.kill(entry.pid, 'SIGTERM')
      } catch {
        // Already gone.
      }
    }
    return reaped
  }

  /**
   * Kill the whole family behind a recorded local service pid. A local dsh
   * web spawns as a detached GROUP: the watchParent guard shell (leader) plus
   * the node service it backgrounds. Signalling only the recorded pid leaves
   * the other one behind — killing the wrapper orphans the service, killing
   * the service strands the wrapper. Resolve the group first and signal THAT;
   * a dead/unresolvable pid degrades to a direct signal that no-ops.
   */
  async killLocalServiceTree(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return
    const pgid = await processGroupOf(pid)
    if (pgid !== null) {
      try {
        process.kill(-pgid, 'SIGTERM')
        return
      } catch {
        // Group already gone (or permission); fall through to the direct pid.
      }
    }
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone; nothing to reap.
    }
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
  async remoteRun(target, inner, { timeoutMs, onLine, shouldAbort } = {}) {
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
      shouldAbort,
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
    this.localWebUrl = ''
    this.remoteWebUrl = ''
    this.remoteAnnouncedUrl = ''
    this.machineId = null
    this.stopOwnedChildren()
    this.releaseReservedPorts()
    this.setStatus({ state: 'connecting', mode: settings.mode, url: this.url(), detail: '正在连接…', serviceOwner: 'none' })
    try {
      if (settings.mode === 'ssh') await this.connectSsh(settings)
      else await this.connectLocal(settings)
    } catch (error) {
      this.releaseReservedPorts()
      if (this.stopped) {
        // Cancelled by the user (stop()) mid-connect: stay idle — no error
        // card and no auto-reconnect; the harness tab returns to its
        // launcher instead of resurrecting the cancelled attempt.
        this.setStatus({ state: 'idle', detail: '已取消', serviceOwner: 'none' })
        return
      }
      this.setStatus({ state: 'error', detail: String(error.message || error) })
      this.emit('connect-failed', error)
    }
  }

  /** Disconnect: kill owned local child and tunnel; never touch remote services. */
  stop() {
    this.stopped = true
    this.connectEpoch += 1
    this.stopHealthMonitor()
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
    this.stopHealthMonitor()
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
        // Group kill: the recorded pid may be the guard wrapper OR the node
        // service (see `killLocalServiceTree`) — signalling just one strands
        // the other as an orphan.
        await this.killLocalServiceTree(state.pid)
      }
      runtimeStore.removeLocalState(settings)
    }

    this.localChild = null
    this.tunnelChild = null
    this.localPort = null
    this.remotePort = null
    this.localVersion = null
    // The service these tokens belong to is going away with the reset.
    this.localWebUrl = ''
    this.remoteWebUrl = ''
    this.remoteAnnouncedUrl = ''
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
        // port) still needs a restart for Harness updates to take effect:
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
          // Clear EVERY host over this dsh home, not just the recorded pid:
          // a market-restart replacement parked on an untracked port still
          // owns the task-board ledger and would crash-loop the spawn below.
          if ((await this.reapLocalHosts(settings)) > 0) await sleep(2000)
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
      // Same ledger hazard on the no-service path: an unadopted replacement
      // holds the task-board lock, so clear every host over this home first.
      if ((await this.reapLocalHosts(settings)) > 0) await sleep(2000)
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
    // Every branch below re-derives the served URL; a token left over from a
    // service that is no longer running must never reach a window.
    this.localWebUrl = ''

    // Reuse a previously owned service when it still matches this build: same
    // version fingerprint AND a dsh service still answering on its port.
    if (state !== null && state.version === version) {
      // Prefer the URL this service announced when we spawned it — it carries
      // the launch token that mints the browser cookie. It is only trustworthy
      // while the recorded pid is still the live owner: another process that
      // inherited this port minted its own token, and the state file's copy
      // would then be stale (harmless — it just 401s — but the bare URL with
      // a still-valid cookie is the better bet).
      const recorded = typeof state.url === 'string' && state.url !== ''
        && pidAlive(state.pid) && urlPort(state.url) === state.port
        ? state.url
        : ''
      const url = recorded !== '' ? recorded : `http://127.0.0.1:${state.port}`
      const probe = await probeOnce(url)
      // A service we cannot authenticate against is no better than no
      // service. Without a token URL to present (and with no live browser
      // cookie for this authority — guaranteed when the port just changed,
      // since the cookie is bound to it) the window would only ever render
      // the 401 notice. Fall through and restart to obtain a fresh token
      // instead of reporting a "successful" connect that shows nothing.
      const authenticated = !(probe.needsAuth === true && recorded === '')
      if (probe.needsAuth === true && recorded === '') {
        this.log(`已运行的 dsh web（端口 ${state.port}）要求启动令牌且本地无可用票据，重启以获取新的认证 URL…`)
        this.localWebUrl = ''
      }
      if (probe.up && probe.isDsh && authenticated) {
        this.localPort = state.port
        this.localVersion = version
        this.localWebUrl = recorded
        this.log(`复用已运行的 dsh web（端口 ${state.port}，版本 ${version.slice(0, 8)}）`)
        // Sweep strays before declaring ready, same reasoning as the remote
        // twin: the reuse path is the only one a healthy device ever takes, so
        // a second host over this home would otherwise never be evicted.
        await this.reapLocalHosts(settings, state.pid).catch(() => 0)
        this.setStatus({ state: 'ready', url: this.url(), detail: '已连接（复用已运行服务）', serviceOwner: 'external' })
        return
      }
    }

    // The recorded port is stale — either the recorded host died, or the
    // harness relaunched ITSELF (dsh-market's self-restart spawns the
    // replacement detached with its stdout sent to a temp file, so the port
    // it moved to never reaches us and the state above still names the port
    // the process that exited used).
    //
    // Deliberately NOT adopting the replacement. A host we did not start runs
    // a runtime whose version we cannot establish: locally we could match its
    // bin against the active runtime dir, but only because the bin path is
    // absolute. Adopting one on that guess and recording the CURRENT version
    // would leave the state file lying — the next connect would take the
    // reuse fast path (version matches, port answers) and the device would be
    // pinned to the old runtime for good.
    //
    // Follow a peer shell that is mid-startup before taking over: see
    // `awaitPeerService` for the ping-pong this avoids. Only ever follow a
    // host whose recorded version is ours — the same condition the reuse fast
    // path above requires.
    const peer = await this.awaitPeerService({
      version,
      readState: async () => this.readLocalState(settings),
      probePort: async port => {
        const probe = await probeOnce(`http://127.0.0.1:${port}`)
        return probe.up && probe.isDsh
      },
    })
    if (peer !== null) {
      // The peer shell recorded the token URL its own spawn announced in the
      // same state file we just read, so this service is reachable with a
      // token — adopt it instead of falling back to the bare port.
      const peerState = this.readLocalState(settings)
      const peerToken = peerState !== null && typeof peerState.url === 'string'
        && urlPort(peerState.url) === peer.port
        ? peerState.url
        : ''
      // Following a peer we cannot authenticate against would park the
      // window on the 401 page. Take over with our own spawn instead.
      const peerProbe = await probeOnce(peerToken !== '' ? peerToken : `http://127.0.0.1:${peer.port}`)
      const peerUsable = peerProbe.up && peerProbe.isDsh
        && !(peerProbe.needsAuth === true && peerToken === '')
      if (!peerUsable) {
        this.log(`其他终端的 dsh web（端口 ${peer.port}）无法完成认证，改为自行启动…`)
      } else {
        this.localPort = peer.port
        this.localVersion = version
        this.localWebUrl = peerToken
        this.log(`跟随其他终端已启动的 dsh web（端口 ${peer.port}）`)
        await this.reapLocalHosts(settings, peer.pid).catch(() => 0)
        this.setStatus({ state: 'ready', url: this.url(), detail: `已连接（跟随其他终端，端口 ${peer.port}）`, serviceOwner: 'external' })
        return
      }
    }

    // So: clear every host over this dsh home and start a known-good one. The
    // plugin only releases a lock once the owning pid is gone — it never
    // probes the port — so a wedged host crash-loops every spawn below. Two
    // hosts on one home are illegal anyway (they would fight over the session
    // store), and `processUsesHome` confines this to OUR home.
    if ((await this.reapLocalHosts(settings)) > 0) await sleep(2000)

    // Backstop for the sweep above, not an alternative to it: `reapLocalHosts`
    // finds hosts by scanning command lines and lsof, which can miss one (a
    // wrapper that has exec'd, a process whose open files are not visible).
    // This asks about the RECORDED pid directly — a second, independent
    // discovery path — so a host the sweep missed cannot survive to fight the
    // new one over the session store. It matters most right after an upgrade,
    // where the recorded host is an older build.
    if (state !== null && pidAlive(state.pid)) {
      this.log(`检测到旧版/残留服务（pid ${state.pid}），清理后升级…`)
      // Group kill — the recorded pid may be the guard wrapper or the node
      // service; signalling just one strands the other (see
      // `killLocalServiceTree`).
      await this.killLocalServiceTree(state.pid)
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

  /**
   * Whether the runtime being served understands `--no-open`. Version-gated:
   * the flag landed at NO_OPEN_MIN_VERSION and older artifacts abort the boot
   * on an unknown option. An unresolvable version ('unknown') is treated as
   * OLD, not new — guessing new would abort the very boot it is meant to fix.
   * @param {string} version - the runtime's package version.
   * @returns {boolean}
   */
  supportsNoOpen(version) {
    if (typeof version !== 'string' || version === '' || version === 'unknown') return false
    return compareVersions(version, NO_OPEN_MIN_VERSION) >= 0
  }

  /** `dsh web` argv for one runtime: `--no-open` only when that runtime takes it. */
  webArgs(port, version) {
    const args = ['web', '--port', String(port)]
    if (this.supportsNoOpen(version)) args.push('--no-open')
    return args
  }

  async spawnLocalService(settings, port = 0, version = null) {
    const tools = this.resolvedTools()
    const serveVersion = version ?? this.localVersion ?? 'unknown'
    // `--port 0` lets the OS choose the port; the CLI prints the real URL on
    // stdout as `dsh web: http://127.0.0.1:<port>`. Keep localPort null until
    // that line arrives so url() never returns port 0.
    this.localVersion = serveVersion
    this.localPort = port === 0 ? null : port
    // Drop the previous spawn's token URL before this one announces its own:
    // a token minted for the service being replaced must never be handed to
    // the window while this spawn is still booting.
    this.localWebUrl = ''
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
    // The REAL service pid, announced by the watchParent guard on stdout —
    // `service.child.pid` is only the wrapper shell. Recorded in the state
    // file so keepPid sweeps protect the service itself (see reapLocalHosts).
    let servicePid = null
    const portSeen = new Promise((resolve, reject) => {
      resolvePort = resolve
      rejectPort = reject
    })
    const portTimer = setTimeout(() => {
      rejectPort(new Error('等待 dsh web 报告实际端口超时。请打开服务日志排查。'))
    }, 30_000)

    const service = spawnService({
      cmd: tools.node,
      // The shell owns the harness view, so the service must not also open a
      // browser tab on startup (it did so on every spawn, including restarts
      // that picked a new OS-chosen port). `--no-open` only when the runtime
      // being served recognizes it — see supportsNoOpen.
      args: [binPath, ...this.webArgs(port, serveVersion)],
      cwd: runtimeDir,
      env: { ...tools.env, DSH_HOME: expandHome(settings.local.dshHome) },
      // 父进程监护：壳被强杀/崩溃时让 dsh web 随父退出，避免孤儿实例。
      watchParent: true,
      onLine: line => {
        // The guard announces the REAL service pid (the wrapper's own pid is
        // not it — see runner.spawnService). Swallow the marker line instead
        // of logging it: it is machinery, not service output.
        const pidMatch = line.startsWith(SERVICE_PID_PREFIX)
          ? /^(\d+)$/u.exec(line.slice(SERVICE_PID_PREFIX.length))
          : null
        if (pidMatch !== null) {
          servicePid = Number(pidMatch[1])
          return
        }
        this.log(`[web] ${line}`)
        const parsed = runtimeStore.parseDshWebUrl(line)
        if (parsed !== null && parsed.port > 0) {
          // Keep the ANNOUNCED url, not just its port: it carries the launch
          // token that mints the browser cookie. Logging the bare port keeps
          // the token out of the service log.
          this.localWebUrl = parsed.url
          resolvePort(parsed.port)
        }
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
        // Transition to `restarting` (not just a detail patch on `ready`) so
        // the shell frame swaps in the loading panel while the service comes
        // back, and the health watchdog defers to this restart instead of
        // racing a second reconnect.
        this.setStatus({
          state: 'restarting',
          url: this.url(),
          detail: `服务退出，${delay / 1000} 秒后重启（第 ${this.localRetries}/${SERVICE_RETRIES} 次）…`,
        })
        setTimeout(() => {
          if (epoch !== this.connectEpoch) return
          if (this.stopped) return
          if (this.status.state !== 'restarting' && this.status.state !== 'ready') return
          // Re-resolve the version BEFORE respawning: a peer shell instance
          // may have upgraded the runtime while this service was down, and
          // restarting the OLD captured version would silently roll the
          // device back. Restart with a fresh OS-chosen port as well; a
          // stale bound port can never force a crash-loop.
          Promise.resolve(this.serviceVersion(settings)).then(async version => {
            if (this.stopped) return
            // The exit may have been the harness relaunching ITSELF: the
            // replacement is already booting detached, on a port we are never
            // told. Do NOT adopt it — a host we did not start runs a runtime
            // whose version we cannot establish, and recording the current
            // version for it would pin the device to whatever it happens to
            // be running (see connectLocal). Clear every host over this dsh
            // home instead and start one we own: the task-board plugin only
            // releases its ledger once the owning pid dies, so the leftover
            // would crash-loop this spawn.
            if ((await this.reapLocalHosts(settings)) > 0) await sleep(2000)
            if (epoch !== this.connectEpoch || this.stopped) return
            await this.spawnLocalService(settings, 0, version || serveVersion)
            // A stale timer (superseded by a newer connect) must not emit a
            // ready for a service it no longer owns.
            if (epoch !== this.connectEpoch || this.stopped) return
            this.localRetries = 0
            // The OS may have chosen a new port; publish it so every window
            // follows the live URL instead of a dead one. Without this emit
            // the restart left windows pointed at the stale port and forced a
            // manual "重新连接".
            this.setStatus({
              state: 'ready',
              url: this.url(),
              detail: `已自动重连（端口 ${this.localPort}）`,
              serviceOwner: 'self',
            })
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
      // Record the REAL service pid, not the wrapper's: a keepPid sweep (or a
      // recorded-pid backstop) that targets the wrapper leaves the service
      // running as an orphan — and one that targets the service while
      // protecting the wrapper kills the very host it validated.
      this.writeLocalState(settings, {
        pid: servicePid ?? service.child.pid,
        port: actualPort,
        version: serveVersion,
        // Persisted so a later connect that adopts this very service (same
        // pid, still alive) can present its token instead of a bare port.
        url: this.localWebUrl,
      })
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
      // Before failing, clear whatever the handoff left behind: the child may
      // have exited because dsh-market relaunched the host detached (its
      // replacement's stdout goes to a temp file, never to our pipe), and that
      // replacement now holds the task-board ledger on a port we were never
      // told. We do not adopt it — a host we did not start runs a runtime whose
      // version we cannot establish, and recording ours for it would pin the
      // device to whatever it happens to be running. Sweep it so the retry (or
      // the next connect) starts from a clean home instead of crash-looping
      // against the ledger it still holds.
      await this.reapLocalHosts(settings).catch(() => 0)
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
    // Re-derived by whichever branch below adopts a service; a token minted
    // for a remote service that has since died must never reach a window.
    this.remoteWebUrl = ''
    this.remoteAnnouncedUrl = ''

    // Deliberately NOT serialized under a remote lock. A lock here buys
    // nothing that matters and costs a failure mode we have already been
    // bitten by:
    //
    //   * Concurrent *access* is harmless — the remote harness is a web
    //     service and this shell only renders it. Two shells (or two aliases
    //     reaching the same machine) reading the same port is the normal
    //     case, not a conflict. Measured: two shells connecting at once both
    //     succeed and both land on the same service.
    //   * The one thing serialization would protect is the spawn race: two
    //     shells both seeing a dead port and both starting a service, leaving
    //     one unrecorded. That race is closed below without a lock, by
    //     waiting for the peer to publish (`awaitPeerService`) and by
    //     sweeping strays on the reuse path (`reapStrayRemoteHosts`).
    //   * Against that, a lock carries its own outage: it goes stale only
    //     after 2h, and a shell that dies between acquire and release (or an
    //     ssh drop inside the finally) leaves every other shell waiting until
    //     the timeout fires and the connect FAILS. Serializing startup would
    //     reintroduce exactly the "reconnect does nothing" symptom this code
    //     exists to fix.
    //
    // Reuse a previously started remote service when its build still matches.
    // This fast path spawns nothing, so it cannot orphan a process.
    const fresh = await this.readRemoteState(settings)
    if (fresh !== null && fresh.version === version) {
      // Ask the host itself before spending an ssh tunnel on the recorded
      // port: a service that already died would otherwise cost a full tunnel
      // setup and surface ssh's `channel N: open failed: Connection refused`
      // in the log before falling through. A state that matches is not
      // evidence the host is alive — a crash or a remote reboot leaves it
      // intact — so reuse only a LIVE service.
      if (await this.remoteProbePort(settings, fresh.port)) {
        this.remotePort = fresh.port
        await this.startTunnelOnFreePort(settings, fresh.port)
        // Re-host the token this service announced onto the LOCAL end of the
        // tunnel: that is the authority the browser presents, and therefore
        // the one the service binds the session cookie to.
        this.remoteWebUrl = rehostUrl(fresh.url ?? '', this.localPort)
        const token = this.remoteWebUrl
        const probe = await probeOnce(this.url())
        // Same rule as the local twin: a remote service we cannot
        // authenticate against is not reusable — restart it for a fresh
        // token rather than reporting a connect that renders the 401 page.
        const authenticated = !(probe.needsAuth === true && token === '')
        if (probe.needsAuth === true && token === '') {
          this.log(`远端 dsh web（端口 ${fresh.port}）要求启动令牌且本地无可用票据，重启以获取新的认证 URL…`)
          this.remoteWebUrl = ''
        }
        if (probe.up && probe.isDsh && authenticated) {
          this.log(`复用远端 dsh web（端口 ${fresh.port}，版本 ${version.slice(0, 8)}）`)
          // Sweep strays BEFORE declaring ready. This is the only path that
          // runs on every healthy connect, so it is the only place a second
          // host sharing this home can be evicted — the slow path's
          // `reapRemoteHosts` is never reached once reuse works.
          await this.reapStrayRemoteHosts(settings, fresh.pid).catch(() => 0)
          this.setStatus({
            state: 'ready',
            url: this.url(),
            detail: `已连接（${displayLabel(target)}，复用远端服务）`,
            serviceOwner: 'remote',
          })
          return
        }
        // Tunnel is up but nothing dsh answers behind it: fall through.
      }
      this.log(`远端服务已退出（端口 ${fresh.port}），自动重启…`)
    }
    // The recorded port may also be stale because the harness relaunched
    // ITSELF: dsh-market's self-restart starts the replacement detached with
    // its stdout sent to a temp file, so the port it moved to never reaches
    // us and the state still names the port of the process that exited.
    //
    // Do NOT adopt the replacement: a host we did not start runs a runtime
    // whose version we cannot establish from here (a remote host launches
    // `bin.js` by a path relative to its cwd, so its command line carries no
    // runtime dir to match). Recording the CURRENT version for it would leave
    // the state file lying, and the next connect would take the reuse fast
    // path and pin the device to that unknown build for good.
    //
    // Follow a PEER shell that is mid-startup instead. Two shells that both
    // saw the recorded port die would otherwise race: ours sweeps the host
    // theirs has just spawned, their close watcher fires and sweeps ours, and
    // the two ping-pong without ever connecting. A lock does not close that
    // window either — it re-reads the state on entry, but a peer still waiting
    // for its port has not written one yet. Polling does.
    const peer = await this.awaitPeerService({
      version,
      readState: () => this.readRemoteState(settings),
      probePort: port => this.remoteProbePort(settings, port),
    })
    if (peer !== null) {
      this.log(`跟随其他终端已启动的远端 dsh web（端口 ${peer.port}）`)
      this.remotePort = peer.port
      await this.startTunnelOnFreePort(settings, peer.port)
      // The peer shell recorded the URL its own spawn announced; adopt it on
      // this shell's forward port.
      const peerState = await this.readRemoteState(settings)
      this.remoteWebUrl = rehostUrl(peerState?.url ?? '', this.localPort)
      const url = this.url()
      const ready = await waitReady(url)
      await this.reapStrayRemoteHosts(settings, peer.pid).catch(() => 0)
      this.setStatus({
        state: 'ready',
        url,
        detail: ready.isDsh
          ? `已连接（${displayLabel(target)}，跟随其他终端）`
          : '隧道已建立，但该端口响应的可能不是 DeepSeek Harness',
        serviceOwner: 'remote',
      })
      return
    }
    // Nobody else is serving, so a host we could NOT reach may still be
    // holding the remote task-board ledger. Clear every host over this dsh
    // home before spawning — `reapRemoteService` alone only ever knew about
    // the recorded pid and port, which is exactly what a self-restart
    // invalidates.
    if ((await this.reapRemoteHosts(settings, fresh ?? state)) > 0) await sleep(2000)
    const remotePort = await this.launchRemoteService(settings, 0, version)

    this.remotePort = remotePort
    await this.startTunnelOnFreePort(settings, remotePort)
    // Move the freshly announced token URL onto the local forward port so the
    // window opens an authenticated URL instead of a bare one.
    this.remoteWebUrl = rehostUrl(this.remoteAnnouncedUrl, this.localPort)
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
   * Every `dsh web` host on the remote machine: its loopback ports and whether
   * it serves this shell's remote dsh home (`~/.dsh`, hard-coded by the remote
   * state/pid/port files — `settings.local.dshHome` is local-only).
   * @returns {Promise<Array<{pid: number, usesHome: boolean, ports: number[]}>>}
   */
  async remoteHostCandidates(settings) {
    const scan = await this.remoteRun(settings.ssh.host, REMOTE_HOST_SCAN, { timeoutMs: 20_000 })
      .catch(() => null)
    if (scan === null || scan.code !== 0) return []
    return parseRemoteHostScan(scan.lines)
  }

  /**
   * Whether a remote port answers with the dsh boot page. Runs ON the remote
   * host: the port is not reachable from here until a tunnel is built, which
   * is exactly what we are trying to decide.
   *
   * `curl`, not `node -e fetch(...)`: a remote box may ship an ancient node
   * (v12 has no global `fetch`), and the old probe silently answered "no"
   * there — a healthy service was reported dead and reaped on every connect.
   */
  async remoteProbePort(settings, port) {
    if (!Number.isInteger(port) || port <= 0) return false
    const result = await this.remoteRun(
      settings.ssh.host,
      `curl -s --max-time 5 http://127.0.0.1:${port}/ | grep -c "__DSH_BOOT__"`,
      { timeoutMs: 20_000 },
    ).catch(() => null)
    if (result === null || result.code !== 0) return false
    return result.lines.some(line => /^[1-9]/u.test(line.trim()))
  }

  /**
   * Wait briefly for a PEER shell to finish starting a service, and follow it
   * if it does. Returns the peer's recorded state, or null when the grace
   * period expires with nothing healthy to follow.
   *
   * This is what keeps two shells from ping-ponging. Two of them that both saw
   * the recorded port die would otherwise race: each concludes nothing is
   * serving, sweeps every host over the dsh home, and spawns its own — so each
   * one kills what the other just built, the loser's close watcher fires, and
   * the pair thrashes without ever connecting.
   *
   * A mutual-exclusion lock does NOT close that window. It re-reads the state
   * on entry, which is the right thing, but a peer that is still waiting for
   * its port has not written a state yet — so a locker still sees nothing and
   * still sweeps the peer's half-built host. Only waiting helps, because the
   * thing we are waiting for is the peer's write.
   *
   * Following is safe by construction: we only ever follow a host whose
   * recorded version equals ours, which is the same condition the reuse fast
   * path already requires. Anything else falls through to a clean restart.
   * @param {object} options
   * @param {string} options.version - the runtime version we want to serve
   * @param {() => ({pid: number, port: number, version: string}|null)|Promise<{pid: number, port: number, version: string}|null>} options.readState
   *      may return the state (sync, e.g. local `readLocalState`) or a Promise
   *      of it (async, e.g. remote `readRemoteState`) — both are awaited here
   * @param {(port: number) => Promise<boolean>} options.probePort
   * @param {number} [options.attempts]
   * @param {number} [options.intervalMs]
   * @returns {Promise<{pid: number, port: number, version: string}|null>}
   */
  async awaitPeerService({ version, readState, probePort, attempts = PEER_WAIT_ATTEMPTS, intervalMs = PEER_WAIT_INTERVAL_MS }) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await sleep(intervalMs)
      // Promise.resolve().then(...) neutralises BOTH shapes a readState can
      // take: a SYNC one (local state reads are plain fs.readFileSync
      // wrappers — calling .catch on their plain return throws "readState(...)
      // .catch is not a function") and a sync throw, which would otherwise
      // reject this loop exactly like the async failure below.
      const fresh = await Promise.resolve().then(readState).catch(() => null)
      if (fresh === null || fresh.version !== version) continue
      if (!Number.isInteger(fresh.port) || fresh.port <= 0) continue
      if (!(await probePort(fresh.port).catch(() => false))) continue
      return fresh
    }
    return null
  }

  /**
   * Reap EVERY `dsh web` host over this shell's remote dsh home — the remote
   * twin of `reapLocalHosts`. Only called once following a peer has been ruled
   * out, so anything still running is a host we could not reach: the task-board
   * plugin releases its ledger lock only when the owning pid dies, so a wedged
   * host crash-loops every spawn below. `usesHome` confines this to OUR home,
   * so a colleague's instance on a shared box is never touched.
   *
   * The sweep can see nothing at all when `lsof` is missing; the recorded pid
   * is then still signalled, preserving the old targeted behaviour.
   * @returns {Promise<number>} how many host processes were signalled.
   */
  async reapRemoteHosts(settings, state = null) {
    const candidates = await this.remoteHostCandidates(settings)
    const pids = candidates.filter(host => host.usesHome).map(host => host.pid)
    const recorded = state !== null && state !== undefined && Number.isInteger(state.pid) ? state.pid : 0
    if (recorded > 0 && !pids.includes(recorded)) {
      // Unclassified (sweep missed it or saw it outside our home). Only add it
      // when the sweep did not see it — a host we CAN see serving another home
      // must never be killed.
      if (!candidates.some(host => host.pid === recorded)) pids.push(recorded)
    }
    if (pids.length === 0) return 0
    const killed = await this.killRemotePids(settings.ssh.host, pids)
    if (killed.length > 0) this.log(`清理残留远端 dsh web（pid ${killed.join('、')}）…`)
    return killed.length
  }

  /**
   * Signal remote pids and wait for them to actually go: report which ones are
   * alive, TERM them, poll up to ~5s for the host to release the task-board
   * ledger, then KILL any straggler.
   *
   * One round-trip, because every one of these costs a full ssh handshake and
   * the whole sweep only ever runs while the user is watching a spinner.
   *
   * Counting only the live ones keeps the log — and the caller's "did we reap
   * anything?" decision — honest: a stale recorded pid is the common case and
   * must not read as a kill.
   * @returns {Promise<number[]>} the pids that were alive and got signalled.
   */
  async killRemotePids(target, pids) {
    const list = pids.filter(pid => Number.isInteger(pid) && pid > 0).join(' ')
    if (list === '') return []
    const result = await this.remoteRun(
      target,
      `alive=""; for p in ${list}; do if kill -0 $p 2>/dev/null; then alive="$alive $p"; fi; done; echo "ALIVE$alive"; if [ -n "$alive" ]; then for p in $alive; do kill $p 2>/dev/null; done; for i in 1 2 3 4 5 6 7 8 9 10; do left=0; for p in $alive; do if kill -0 $p 2>/dev/null; then left=1; fi; done; if [ $left -eq 0 ]; then break; fi; sleep 0.5; done; for p in $alive; do kill -9 $p 2>/dev/null; done; sleep 0.5; fi`,
      { timeoutMs: 30_000 },
    ).catch(() => null)
    if (result === null || result.code !== 0) return []
    const reported = result.lines
      .map(line => /^ALIVE(.*)$/u.exec(line.trim()))
      .find(match => match !== null)
    if (reported === undefined) return []
    return reported[1]
      .trim()
      .split(/\s+/u)
      .filter(part => part !== '')
      .map(Number)
      .filter(pid => Number.isInteger(pid) && pid > 0)
  }

  /**
   * Kill every `dsh web` host over this dsh home EXCEPT the one the state file
   * names — the remote twin of `reapLocalHosts(settings, keepPid)`.
   *
   * This is what makes "one host per home" an invariant instead of a hope.
   * Two shells that both saw the recorded port die can each spawn a host
   * before the other publishes its port (the grace period in
   * `awaitPeerService` is 6s; a cold remote spawn takes ~14s), leaving two
   * hosts sharing one session store. Nothing fixes that later: the reuse fast
   * path returns before it reaches `reapRemoteHosts`, so the stray would
   * survive for good.
   *
   * Measured on a real machine (two shells, port killed underneath both): the
   * race does happen — both shells spawn, and for a while two hosts serve the
   * same home. It self-limits rather than self-heals, though: the loser's
   * `rm -f` of the pid/port files lands before the winner announces its port,
   * so BOTH shells end up recording the winner, and the state file stays
   * self-consistent (it names a live pid). The spare host is left for this
   * sweep to evict on the NEXT connect — verified: one connect over a home
   * with two hosts kills exactly the unrecorded one and keeps the recorded
   * one. So the race costs one stray process, not a wedged device.
   *
   * The state file is the arbiter, not "whichever port we happen to be
   * attached to". Two shells sweeping concurrently therefore agree on who to
   * spare and who to kill, and cannot ping-pong. A missing or nonsensical
   * `keepPid` means we cannot tell them apart, so we kill nothing — this check
   * only ever errs toward leaving a stray alive.
   * @returns {Promise<number>} how many stray hosts were signalled.
   */
  async reapStrayRemoteHosts(settings, keepPid) {
    if (!Number.isInteger(keepPid) || keepPid <= 0) return 0
    const candidates = await this.remoteHostCandidates(settings)
    const pids = candidates
      .filter(host => host.usesHome && host.pid !== keepPid)
      .map(host => host.pid)
    if (pids.length === 0) return 0
    const killed = await this.killRemotePids(settings.ssh.host, pids)
    if (killed.length > 0) this.log(`清理多余远端 dsh web（pid ${killed.join('、')}）…`)
    return killed.length
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
    // No `--no-open` here, and deliberately not version-gated either: the
    // remote service always starts through ssh, so the harness sees
    // SSH_CONNECTION/SSH_TTY and skips the default-browser handoff on its
    // own. Passing the flag would add nothing and would abort an old remote
    // runtime with "unknown option".
    // The service writes its OWN pid before exec-ing node: `$$` is the
    // launching sh, and `exec` replaces it with node IN THE SAME PROCESS, so
    // pidfile always records the real node pid. Writing `$!` instead used to
    // record the setsid wrapper's pid — on most Linux setups that wrapper
    // exits immediately, making the wait loop below misjudge the service as
    // dead and leaving the written state pointing at a dead pid.
    const runNode = `cd ${dir} && BIN=apps/cli/lib/bin.js; [ -f "$BIN" ] || BIN=node_modules/@deepseek-ai/dsh/lib/bin.js; echo $$ > ${pidFile}; exec node "$BIN" web --port ${remotePort} > ${portFile} 2>> ${logFile} < /dev/null`
    const startCommand = `if command -v setsid >/dev/null 2>&1; then setsid sh -c ${shellQuote(runNode)} </dev/null >/dev/null 2>&1 & else nohup sh -c ${shellQuote(runNode)} >/dev/null 2>&1 </dev/null & fi`
    const start = await this.remoteRun(
      settings.ssh.host,
      `${remoteToolchainPrefix()} mkdir -p "$HOME"/.dsh; rm -f ${portFile} ${pidFile}; ${startCommand}`,
      { timeoutMs: 20_000 },
    )
    if (start.code !== 0) throw new Error(`远程服务启动失败：${start.lines.join('\n')}`)

    // Wait for the service's port announcement. The crash detector only
    // fires when the pidfile EXISTS (the service already exec'd node) AND
    // that pid is dead — a service still starting (no pidfile yet) just
    // keeps waiting. A wrapper-pid that exits early can therefore never be
    // mistaken for a crashed service.
    const wait = await this.remoteRun(
      settings.ssh.host,
      `for i in $(seq 1 150); do line=$(tr -d '\\r' < ${portFile} 2>/dev/null | head -1); case "$line" in "dsh web: "*) echo "$line"; exit 0 ;; esac; pid=$(cat ${pidFile} 2>/dev/null || true); if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then echo service-exited; tail -n 20 ${logFile} 2>/dev/null; exit 1; fi; sleep 0.2; done; echo port-timeout; exit 1`,
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
    // Kept verbatim (remote authority) so a later shell can re-host it onto
    // its own forward port — see `rehostUrl`.
    this.remoteAnnouncedUrl = announced.url
    // writeRemoteState now surfaces a failed remote write instead of
    // silently leaving the stale state file behind (the cause of "port in
    // state never updates" reports).
    const written = await this.writeRemoteState(settings, { pid, port: announced.port, version, url: announced.url })
    if (written !== true) throw new Error('远程服务状态写入失败：远端 state 文件不可写。')
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
    // A self-restart invalidates the recorded pid: the replacement keeps
    // running on a port the state never learned, and it still owns the
    // task-board ledger — the spawn below would crash-loop against it.
    if ((await this.reapRemoteHosts(settings, state)) > 0) await sleep(2000)
    const version = await this.serviceVersion(settings)
    return this.launchRemoteService(settings, 0, version)
  }
}

module.exports = {
  ConnectionManager,
  probeOnce,
  waitReady,
  rehostUrl,
  dshWebProcesses,
  listeningLoopbackPorts,
  processUsesHome,
  parseRemoteHostScan,
  parseRemoteProbe,
  REMOTE_HOST_SCAN,
  PEER_WAIT_ATTEMPTS,
  PEER_WAIT_INTERVAL_MS,
}
