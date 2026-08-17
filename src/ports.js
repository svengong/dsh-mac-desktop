'use strict'

/**
 * In-process TCP port allocation for the few places that still need an
 * explicit local port: SSH local forward ports.
 *
 * Local and remote web services now start with `--port 0` and report the
 * OS-chosen port, so their probe→bind race is gone. An `ssh -L` forward does
 * not report its allocated port, so we still bracket that allocation:
 *
 * - `findFreePort(start)` probes 127.0.0.1 and skips ports already reserved
 *   by this shell;
 * - `reservePort` / `releasePort` cover the probe-to-bind window.
 *
 * This does not (and cannot) reserve against other processes; the SSH forward
 * path still falls back to the next free port when the preferred one is busy.
 */

const net = require('node:net')

const PORT_LIMIT = 65535
const PORT_SCAN_SPAN = 30

const reservations = new Set()

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
    if (reservations.has(port)) continue
    if (!(await tcpProbe(port))) return port
  }
  throw new Error(`端口 ${base} 起连续 ${PORT_SCAN_SPAN + 1} 个端口都被占用，无法建立转发。`)
}

function reservePort(port) {
  if (!isValidPort(port)) return false
  if (reservations.has(port)) return false
  reservations.add(port)
  return true
}

function releasePort(port) {
  if (!isValidPort(port)) return false
  return reservations.delete(port)
}

function hasReservation(port) {
  return reservations.has(port)
}

module.exports = {
  PORT_SCAN_SPAN,
  findFreePort,
  isValidPort,
  releasePort,
  reservePort,
  tcpProbe,
  hasReservation,
}
