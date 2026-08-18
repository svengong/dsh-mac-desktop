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
 * @param {object} options - cmd, args, cwd, env, timeoutMs, onLine.
 * @returns {object} {code, signal, timedOut, lines} - resolves for any exit;
 * rejects only when the binary cannot be spawned.
 *
 * The child runs in its own process group (`detached: true`) so the timeout
 * can SIGKILL the whole tree (pnpm/npm installs spawn grandchildren) instead
 * of leaving orphans behind. Every spawned child is also registered in the
 * process registry so the app-quit teardown (`killActiveChildren`) can
 * terminate in-flight builds and services that no session reference covers.
 */
function runCommand({ cmd, args = [], cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS, onLine }) {
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
    trackChild(child)
    const lines = []
    let timedOut = false
    let settled = false
    const pump = linePump(line => {
      lines.push(line)
      if (onLine) onLine(line)
    })
    child.stdout.on('data', pump)
    child.stderr.on('data', pump)
    const timer = setTimeout(() => {
      timedOut = true
      // Group-kill: a SIGKILL to the leader alone leaves pnpm/git
      // grandchildren running in the same group.
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }, timeoutMs)
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`无法启动 ${cmd}: ${error.message}`))
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      pump.flush()
      resolve({ code, signal, timedOut, lines })
    })
  })
}

/**
 * Keep a server process alive in its own process group.
 * @returns {{ child: import('node:child_process').ChildProcess, stop: () => void }}
 * `stop()` sends SIGTERM to the whole group; call it at most once.
 */
function spawnService({ cmd, args, cwd, env, onLine }) {
  const child = spawn(cmd, args, {
    cwd,
    env: env === undefined ? process.env : env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
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
// in-flight work (a pnpm install running in a staging dir, a plugin install,
// a tunnel) even when no session/connection reference points at it anymore.

const activeChildren = new Set()

function trackChild(child) {
  if (child === null || child === undefined) return
  activeChildren.add(child)
  child.once('close', () => activeChildren.delete(child))
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
}

module.exports = { runCommand, spawnService, spawnDetached, DEFAULT_TIMEOUT_MS, killActiveChildren, trackChild }
