'use strict'

/**
 * Service guard — the cross-platform replacement for the `sh` watchParent
 * wrapper in runner.js.
 *
 * Why a separate process at all: a detached child does NOT die with the shell.
 * On POSIX the wrapper polled `$PPID` and killed the service when the shell
 * vanished (macOS has no PDEATHSIG either). Windows has no shell equivalent
 * and no PDEATHSIG, so the same job is done here in node:
 *
 *  - announce the REAL service pid on stdout with SERVICE_PID_PREFIX, so the
 *    state file records the service itself rather than this guard (a keepPid
 *    sweep that protects the guard would kill the service it meant to keep);
 *  - poll the parent; when it is gone, kill the service tree;
 *  - when the service exits on its own, exit with ITS code — the shell's close
 *    watcher depends on that to schedule a restart.
 *
 * Usage: node service-guard.js <parent pid> <cmd> [args…]
 * Windows note: `cmd` is spawned through a shell because real launchers there
 * are `.cmd` shims (pnpm), which node cannot exec directly.
 */

const { spawn } = require('node:child_process')
const { killTree, spawnInvocation } = require('./platform')

const SERVICE_PID_PREFIX = '__DSH_SERVICE_PID__:'
const POLL_MS = 1000

function main() {
  const argv = process.argv.slice(2)
  const parentPid = Number(argv[0])
  const cmd = argv[1]
  const args = argv.slice(2)
  if (!Number.isInteger(parentPid) || parentPid <= 0 || cmd === undefined) {
    console.error('usage: service-guard.js <parent pid> <cmd> [args...]')
    process.exit(2)
  }
  // The guard itself runs as node (ELECTRON_RUN_AS_NODE=1). That marker must
  // NOT reach the service: it would make any Electron binary in the service's
  // own toolchain behave as plain node. Strip it before spawning.
  const childEnv = { ...process.env }
  delete childEnv.ELECTRON_RUN_AS_NODE
  // A .cmd/.bat shim (pnpm, npm) is only runnable through cmd.exe on Windows;
  // spawnInvocation handles that quoting and is a no-op on POSIX.
  const invocation = spawnInvocation(cmd, args)
  const child = spawn(invocation.cmd, invocation.args, {
    env: childEnv,
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
    ...invocation.options,
  })
  process.stdout.write(`${SERVICE_PID_PREFIX}${child.pid}\n`)

  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    if (child.exitCode === null && child.signalCode === null) killTree(child.pid, 'SIGTERM')
  }

  // The shell asks us to stop by killing this guard; take the service with us.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.on(signal, () => {
        stop()
        // Give the tree a moment to die, then leave. The shell's close watcher
        // is already treating this as an intentional stop.
        setTimeout(() => process.exit(0), 250)
      })
    } catch {
      // Signal name unsupported on this platform.
    }
  }

  const parentTimer = setInterval(() => {
    if (!parentAlive(parentPid)) {
      stop()
      clearInterval(parentTimer)
      setTimeout(() => process.exit(0), 250)
    }
  }, POLL_MS)
  parentTimer.unref()

  child.on('error', error => {
    console.error(`[guard] ${error.message}`)
    process.exit(1)
  })
  child.on('close', (code, signal) => {
    clearInterval(parentTimer)
    if (signal !== null) process.exit(0)
    process.exit(Number.isInteger(code) ? code : 0)
  })
}

/** Whether the shell process that spawned us still exists. */
function parentAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

main()
