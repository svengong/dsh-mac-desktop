'use strict'

/**
 * In-process TCP port allocation.
 *
 * A TCP "is the port free?" probe followed by a later `bind`/`ssh -L` is
 * inherently racy: two workspaces can observe the same free port and then
 * collide on it. This module serializes the shell's own allocations:
 *
 * - `findFreePort(start)` probes `127.0.0.1` and skips ports the shell has
 *   already reserved, so a local web service and an SSH forward can never
 *   pick the same fallback port inside one app instance.
 * - `reservePort` / `releasePort` bracket the probe-to-bind window. A caller
 *   MUST release the reservation after the child process stops or fails.
 * - Remote ports get the same treatment with a `ssh:<host>` key, because two
 *   sessions on the same remote host can race on the remote loopback port.
 *
 * This does not (and cannot) reserve against other processes; the existing
 * connect-time probe and "configured port taken → next free port" policy still
 * cover that case.
 */

const net = require('node:net')

const PORT_LIMIT = 65535
const PORT_SCAN_SPAN = 30

const localReservations = new Set()
const remoteReservations = new Map()
const remoteLocks = new Map()

function isValidPort(value) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 1 && number <= PORT_LIMIT
}

/** Probe whether `127.0.0.1:<port>` accepts TCP connections. */
function tcpProbe(port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let settled = false
    const done = value => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** The first free TCP port at or after `start`, bounded at +30. */
async function findFreePort(start) {
  const base = isValidPort(start) ? start : 1
  for (let port = base; port <= Math.min(base + PORT_SCAN_SPAN, PORT_LIMIT); port += 1) {
    if (localReservations.has(port)) continue
    if (!(await tcpProbe(port))) return port
  }
  throw new Error(`端口 ${base} 起连续 ${PORT_SCAN_SPAN + 1} 个端口都被占用，无法启动服务。`)
}

function reservePort(port) {
  if (!isValidPort(port)) return false
  if (localReservations.has(port)) return false
  localReservations.add(port)
  return true
}

function releasePort(port) {
  if (!isValidPort(port)) return false
  return localReservations.delete(port)
}

/** `findFreePort` for a remote host, skipping this process's own reservations. */
async function findFreeRemotePort(probeFn, hostKey, start) {
  const base = isValidPort(start) ? start : 1
  let slots = remoteReservations.get(hostKey)
  if (slots === undefined) {
    slots = new Set()
    remoteReservations.set(hostKey, slots)
  }
  for (let port = base; port <= Math.min(base + PORT_SCAN_SPAN, PORT_LIMIT); port += 1) {
    if (slots.has(port)) continue
    const probe = await probeFn(port)
    if (probe !== undefined && !probe) return port
    if (probe === undefined) return port
  }
  throw new Error(`远程端口 ${base} 起连续 ${PORT_SCAN_SPAN + 1} 个端口都被占用，无法启动服务。`)
}

function reserveRemotePort(hostKey, port) {
  if (!isValidPort(port)) return false
  let slots = remoteReservations.get(hostKey)
  if (slots === undefined) {
    slots = new Set()
    remoteReservations.set(hostKey, slots)
  }
  if (slots.has(port)) return false
  slots.add(port)
  return true
}

function reservedRemotePorts(hostKey) {
  return [...(remoteReservations.get(hostKey) ?? [])].sort((a, b) => a - b)
}

function releaseRemotePort(hostKey, port) {
  const slots = remoteReservations.get(hostKey)
  if (slots === undefined) return false
  const changed = slots.delete(port)
  if (slots.size === 0) remoteReservations.delete(hostKey)
  return changed
}

/** Serialize asynchronous work for one key (e.g. `ssh:<host>`). */
async function runExclusive(key, task) {
  const previous = remoteLocks.get(key) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(task)
  remoteLocks.set(key, current)
  try {
    return await current
  } finally {
    if (remoteLocks.get(key) === current) remoteLocks.delete(key)
  }
}

function hasLocalReservation(port) {
  return localReservations.has(port)
}

module.exports = {
  PORT_SCAN_SPAN,
  findFreePort,
  findFreeRemotePort,
  isValidPort,
  releasePort,
  releaseRemotePort,
  reservePort,
  reserveRemotePort,
  reservedRemotePorts,
  runExclusive,
  tcpProbe,
  hasLocalReservation,
}
