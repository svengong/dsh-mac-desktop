'use strict'

/**
 * Child-process runners.
 *
 * `runCommand` runs a bounded foreground command (git, pnpm, ssh) and streams
 * its stdout/stderr lines to a callback; `spawnService` keeps a long-running
 * server process in its own process group so the shell can terminate the whole
 * tree (the pnpm/node child included) with one group kill.
 */

const { spawn } = require('node:child_process')

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

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
 * The child runs in its own process group (`detached: true`) so the timeout
 * can SIGKILL the whole tree (pnpm/npm installs spawn grandchildren) instead
 * of leaving orphans behind. `shouldAbort` is a cooperative cancellation
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
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(cmd, args, {
        cwd,
        env: env === undefined ? process.env : env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
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
    const killGroup = signal => {
      try {
        process.kill(-child.pid, signal)
      } catch {
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
    // 自动退出，会变成孤儿实例。macOS 无 PDEATHSIG，故用 shell wrapper
    // 记住父 pid 并循环探测——父进程消失则 kill 服务进程；服务进程自行
    // 退出则 shell 透传其退出码退出，保证 close 事件照常触发。
    const guard = [
      'ppid=$PPID',
      '"$@" & child=$!',
      'while kill -0 "$child" 2>/dev/null; do',
      '  if ! kill -0 "$ppid" 2>/dev/null; then kill "$child" 2>/dev/null; break; fi',
      '  sleep 1',
      'done',
      'wait "$child" 2>/dev/null',
    ].join('\n')
    child = spawn('sh', ['-c', guard, 'sh', cmd, ...args], {
      cwd,
      env: env === undefined ? process.env : env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
  } else {
    child = spawn(cmd, args, {
      cwd,
      env: env === undefined ? process.env : env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
  }
  // Also register services so app quit kills them even when a session
  // reference was lost before its stop() was called.
  trackChild(child)
  const pump = linePump(onLine)
  child.stdout.on('data', pump)
  child.stderr.on('data', pump)
  child.on('error', error => {
    if (onLine) onLine(`[spawn] ${error.message}`)
  })
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
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
  const child = spawn(cmd, args, {
    cwd,
    env: env === undefined ? process.env : env,
    stdio: 'ignore',
    detached: true,
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
    try {
      process.kill(-child.pid, signal)
    } catch {
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
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
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
module.exports = { runCommand, spawnService, spawnDetached, DEFAULT_TIMEOUT_MS, killActiveChildren, cancelOwnedChildren, trackChild }
