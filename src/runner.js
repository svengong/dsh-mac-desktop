'use strict'

/**
 * Child-process runners.
 *
 * `runCommand` runs a bounded foreground command (git, pnpm, ssh) and streams
 * its stdout/stderr lines to a callback; `spawnService` keeps a long-running
 * server process in its own process group so the shell can terminate the whole
 * tree (the pnpm/node child included) with one group kill.
 */

const path = require('node:path')
const { spawn } = require('node:child_process')
const {
  IS_WINDOWS, killTree, spawnInvocation, spawnOptions,
} = require('./platform')

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

/**
 * Prefix of the stdout line the watchParent guard prints to announce the REAL
 * service pid (`"$@" &` backgrounds the service, so the wrapper's own pid is
 * NOT it). Consumers parse this to record the true pid in state files.
 */
const SERVICE_PID_PREFIX = '__DSH_SERVICE_PID__:'

function linePump(onLine) {
  let buffer = ''
  const pump = chunk => {
    buffer += chunk.toString('utf8')
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (onLine) onLine(line)
    }
  }
  // Commands like `printf '{"pid":...}' > file` are followed by `cat file`
  // with no trailing newline; flush the final partial line on stream end.
  pump.flush = () => {
    if (buffer !== '') {
      const line = buffer.replace(/\r$/, '')
      buffer = ''
      if (onLine) onLine(line)
    }
  }
  return pump
}

/**
 * Run one command to completion.
 * @param {object} options - cmd, args, cwd, env, timeoutMs, onLine, owner, shouldAbort.
 * @returns {object} {code, signal, timedOut, aborted, lines} - resolves for any
 * exit; rejects only when the binary cannot be spawned.
 *
 * The child runs in its own process group (`detached: true`) on POSIX so the
 * timeout can SIGKILL the whole tree (pnpm/npm installs spawn grandchildren)
 * instead of leaving orphans behind.
 *
 * Windows does NOT get `detached` here, even though `taskkill /T` would still
 * reach the tree: a detached child loses its inherited stdout when the parent
 * is itself a console-less process (an app launched from Explorer, or any
 * child of one). Reproduced on Windows 11 ARM64 — the same PowerShell command
 * returned `MARKER` with `detached: false` and `""` with `detached: true`,
 * exit code 0 either way, so the failure is SILENT: every CIM/PowerShell query
 * (`Get-CimInstance Win32_Process` for process discovery, the WebContents
 * probe, the toolchain lookup) came back empty and the shell concluded there
 * were no processes at all. `windowsHide` alone is what a background helper
 * needs; `netstat`, `where` and `taskkill` are console programs whose output
 * is unaffected either way, but PowerShell is the one that matters here. `shouldAbort` is a cooperative cancellation
 * poll (default 200ms): when it flips true the whole group is SIGTERM'd and
 * the result resolves with `aborted: true` — callers that care about
 * cancellation (the update pipeline, the detached worker) can then clean up
 * their staging state instead of waiting out the full timeout. Every spawned
 * child is also registered in the process registry so the app-quit teardown
 * (`killActiveChildren`) can terminate in-flight builds and services that no
 * session reference covers.
 */
function runCommand({ cmd, args = [], cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS, onLine, owner = null, shouldAbort = null }) {
  const ABORT_POLL_MS = 200
  // `detached` on Windows is what steals a console-less parent's ability to
  // read the child's stdout (see the doc block above). Every Windows helper the
  // shell runs is short-lived and is killed by `taskkill /T`, which does not
  // need a new process group, so the flag buys nothing there and costs output.
  const detached = !IS_WINDOWS
  return new Promise((resolve, reject) => {
    let child
    try {
      // On Windows npm/pnpm are .cmd shims that node cannot exec directly;
      // spawnInvocation reroutes them through cmd.exe with a correctly quoted
      // command line (and is a no-op everywhere else).
      const invocation = spawnInvocation(cmd, args)
      child = spawn(invocation.cmd, invocation.args, {
        cwd,
        env: env === undefined ? process.env : env,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...spawnOptions({ detached }),
        ...invocation.options,
      })
    } catch (error) {
      reject(new Error(`无法启动 ${cmd}: ${error.message}`))
      return
    }
    trackChild(child, owner)
    const lines = []
    let timedOut = false
    let aborted = false
    let settled = false
    const pump = linePump(line => {
      lines.push(line)
      if (onLine) onLine(line)
    })
    child.stdout.on('data', pump)
    child.stderr.on('data', pump)
    // POSIX kills the process GROUP (grandchildren of an npm/pnpm install);
    // Windows walks the child tree with taskkill. One helper, both OSes.
    const killGroup = signal => {
      if (!killTree(child.pid, signal)) {
        try {
          child.kill(signal)
        } catch {
          // Already gone.
        }
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      // Group-kill: a SIGKILL to the leader alone leaves pnpm/git
      // grandchildren running in the same group.
      killGroup('SIGKILL')
    }, timeoutMs)
    const abortTimer = typeof shouldAbort === 'function' ? setInterval(() => {
      if (aborted || settled) return
      let stop = false
      try {
        stop = Boolean(shouldAbort())
      } catch {
        stop = false
      }
      if (!stop) return
      aborted = true
      killGroup('SIGTERM')
      // Escalate to SIGKILL when the group ignores the graceful signal, so a
      // cancelled update can never hang the pipeline for the full timeout.
      setTimeout(() => {
        if (settled) return
        killGroup('SIGKILL')
      }, 5000)
    }, ABORT_POLL_MS) : null
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (abortTimer !== null) clearInterval(abortTimer)
      reject(new Error(`无法启动 ${cmd}: ${error.message}`))
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (abortTimer !== null) clearInterval(abortTimer)
      pump.flush()
      resolve({ code, signal, timedOut, aborted, lines })
    })
  })
}

/**
 * Keep a server process alive in its own process group.
 * @returns {{ child: import('node:child_process').ChildProcess, stop: () => void }}
 * `stop()` sends SIGTERM to the whole group; call it at most once.
 */
function spawnService({ cmd, args, cwd, env, onLine, watchParent = false }) {
  let child
  if (watchParent) {
    // 父进程监护（防孤儿实例）：detached 子进程在壳（父进程）死亡后不会
    // 自动退出，会变成孤儿实例。macOS 无 PDEATHSIG，Windows 更没有任何等价
    // 物，因此统一用一个 node 监护进程（service-guard.js）记住父 pid 并循环
    // 探测——父进程消失则杀掉服务整棵树；服务自行退出则透传其退出码退出，
    // 保证 close 事件照常触发。
    //
    // The guard and the service are TWO processes, so child.pid (the guard)
    // is NOT the service pid. The guard echoes SERVICE_PID_PREFIX with the
    // real one — the local dsh web state file must record THAT pid, or a
    // keepPid sweep "protecting" the guard kills the service meant to be kept.
    //
    // node, not sh: the old wrapper was a POSIX shell script that relied on
    // "$@" backgrounding and `ps -o stat=`, and Windows has neither. node is
    // the one runtime the shell is guaranteed to have, so one guard covers
    // both platforms instead of three shell dialects.
    child = spawn(process.execPath, [
      path.join(__dirname, 'service-guard.js'),
      String(process.pid),
      cmd,
      ...args,
    ], {
      cwd,
      // ELECTRON_RUN_AS_NODE: `process.execPath` is the ELECTRON binary, which
      // would otherwise treat the guard script as an app entry and boot a whole
      // (invisible) Electron main process for every service. As plain node the
      // guard costs a few MB instead of ~100MB.
      env: { ...(env === undefined ? process.env : env), ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...spawnOptions(),
    })
  } else {
    const invocation = spawnInvocation(cmd, args)
    child = spawn(invocation.cmd, invocation.args, {
      cwd,
      env: env === undefined ? process.env : env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...spawnOptions(),
      ...invocation.options,
    })
  }
  // Also register services so app quit kills them even when a session
  // reference was lost before its stop() was called.
  trackChild(child)
  const pump = linePump(onLine)
  child.stdout.on('data', pump)
  child.stderr.on('data', pump)
  child.on('error', error => {
    if (onLine) onLine('[spawn] ' + error.message)
  })
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    if (child.exitCode !== null || child.signalCode !== null) return
    // Group kill on POSIX, tree kill on Windows. The guard forwards the stop
    // to the service either way.
    if (!killTree(child.pid, 'SIGTERM')) {
      try {
        child.kill('SIGTERM')
      } catch {
        // Already gone.
      }
    }
  }
  return { child, stop }
}

/**
 * Spawn a detached helper that must SURVIVE the shell (the update worker).
 * Deliberately NOT registered in the process registry: app quit must not
 * kill it. Returns the unref'd child.
 */
function spawnDetached({ cmd, args = [], cwd, env }) {
  const invocation = spawnInvocation(cmd, args)
  const child = spawn(invocation.cmd, invocation.args, {
    cwd,
    env: env === undefined ? process.env : env,
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
    ...invocation.options,
  })
  child.unref()
  return child
}

// ── process registry ──────────────────────────────────────────────────────
//
// Every child this module spawns is tracked here so app quit can terminate
// in-flight work (a pnpm install running in a staging dir, a Harness install,
// a tunnel) even when no session/connection reference points at it anymore.

const activeChildren = new Set()
const ownedChildren = new Map()

function trackChild(child, owner = null) {
  if (child === null || child === undefined) return
  activeChildren.add(child)
  if (owner !== null && owner !== undefined && owner !== '') {
    let owned = ownedChildren.get(owner)
    if (owned === undefined) {
      owned = new Set()
      ownedChildren.set(owner, owned)
    }
    owned.add(child)
  }
  child.once('close', () => {
    activeChildren.delete(child)
    if (owner !== null && owner !== undefined && owner !== '') {
      const owned = ownedChildren.get(owner)
      if (owned !== undefined) {
        owned.delete(child)
        if (owned.size === 0) ownedChildren.delete(owner)
      }
    }
  })
}

/** SIGTERM the whole process group of every child owned by one terminal task. */
function cancelOwnedChildren(owner, signal = 'SIGTERM') {
  if (owner === null || owner === undefined || owner === '') return 0
  const owned = ownedChildren.get(owner)
  if (owned === undefined || owned.size === 0) return 0
  let killed = 0
  for (const child of [...owned]) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    killed += 1
    if (!killTree(child.pid, signal)) {
      try {
        child.kill(signal)
      } catch {
        // Already gone.
      }
    }
  }
  return killed
}

function killActiveChildren() {
  for (const child of activeChildren) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    if (!killTree(child.pid, 'SIGTERM')) {
      try {
        child.kill('SIGTERM')
      } catch {
        // Already gone.
      }
    }
  }
  activeChildren.clear()
  ownedChildren.clear()
}
module.exports = { runCommand, spawnService, spawnDetached, DEFAULT_TIMEOUT_MS, killActiveChildren, cancelOwnedChildren, trackChild, SERVICE_PID_PREFIX }