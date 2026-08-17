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
 * @returns {Promise<{code: number|null, signal: string|null, timedOut: boolean, lines: string[]}>}
 * Resolves for any exit; rejects only when the binary cannot be spawned.
 */
function runCommand({ cmd, args = [], cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS, onLine }) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(cmd, args, {
        cwd,
        env: env === undefined ? process.env : env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(new Error(`无法启动 ${cmd}: ${error.message}`))
      return
    }
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
      child.kill('SIGKILL')
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

module.exports = { runCommand, spawnService, DEFAULT_TIMEOUT_MS }
