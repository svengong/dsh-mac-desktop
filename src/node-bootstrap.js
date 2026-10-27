'use strict'

/**
 * Portable-node bootstrap, shared by the shell and the detached update worker.
 *
 * WHY this is its own module: the very first connect on a clean machine has no
 * node, and the official artifact cannot be installed without one. The shell
 * used to own that download inside `Updater.bootstrapLocalNode`, which the
 * DETACHED WORKER cannot call (it has no ConnectionManager). So on a fresh
 * Windows install the worker started, ran `resolveTools()`, found no node, and
 * exited with `phase: 'error'` — while the shell's connect chain had already
 * handed off to it. Net effect for the user: a connecting screen that never
 * resolves and no hint that node is what is missing.
 *
 * Downloading node needs no node (plain `fetch` + `tar`), so it can run
 * anywhere. Keep it dependency-light: this file must stay requireable from the
 * worker's minimal environment.
 */

const fs = require('node:fs')
const path = require('node:path')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { runCommand } = require('./runner')
const { extractNodeArchive, nodeDistArchive } = require('./platform')

/** The node version the shell vendors. Keep in sync with the engine range. */
const PORTABLE_NODE_VERSION = '22.19.0'

/**
 * Download a URL to a file. Returns false (never throws) so callers can fall
 * back to curl on hosts where node's fetch is blocked.
 * @param {string} url
 * @param {string} dest
 * @param {{onLine?: (line: string) => void, timeoutMs?: number}} [options]
 * @returns {Promise<boolean>}
 */
async function downloadFile(url, dest, { onLine = () => {}, timeoutMs = 10 * 60_000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    onLine(`[download] ${url}`)
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok || response.body === null) {
      onLine(`[download] HTTP ${response.status}`)
      return false
    }
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(dest))
    return true
  } catch (error) {
    onLine(`[download] ${String(error.message || error)}`)
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ensure a runnable portable node exists under `<toolRoot>/node`.
 *
 * Idempotent: when `isRunnable()` already reports a usable node the download is
 * skipped entirely, so calling this on every connect costs one stat.
 *
 * @param {object} options
 * @param {string} options.toolRoot - directory that receives `node/` (the
 *   `.dsh-tools` folder beside the checkout).
 * @param {() => boolean} options.isRunnable - whether node already resolves.
 * @param {(line: string) => void} options.onLine - progress sink.
 * @param {object} [options.env] - child environment for tar/curl.
 * @param {string} [options.version] - override the vendored version.
 * @returns {Promise<{ok: boolean, nodeDir: string, error?: string}>}
 */
async function ensurePortableNode({ toolRoot, isRunnable, onLine, env, version = PORTABLE_NODE_VERSION }) {
  const nodeDir = path.join(toolRoot, 'node')
  if (typeof isRunnable === 'function' && isRunnable()) return { ok: true, nodeDir }
  const dist = nodeDistArchive(version)
  fs.mkdirSync(nodeDir, { recursive: true })
  const archive = path.join(toolRoot, `node.${dist.kind === 'zip' ? 'zip' : 'tar.gz'}`)
  onLine(`未找到兼容的 node，正在下载便携版 node v${version} 到 ${nodeDir} …`)
  let fetched = await downloadFile(dist.url, archive, { onLine, timeoutMs: 10 * 60_000 })
  if (!fetched) {
    // A host that blocks node's fetch may still ship curl.
    const curl = await runCommand({
      cmd: process.platform === 'win32' ? 'curl.exe' : '/usr/bin/curl',
      args: ['-fsSL', '-o', archive, dist.url],
      env,
      timeoutMs: 10 * 60_000,
      onLine: line => onLine(`[curl] ${line}`),
    }).catch(() => null)
    if (curl === null || curl.code !== 0) {
      return { ok: false, nodeDir, error: `便携版 node 下载失败（${dist.url}）。请检查网络。` }
    }
  }
  const unpack = await extractNodeArchive({ runCommand, archive, destDir: nodeDir, kind: dist.kind, env, timeoutMs: 5 * 60_000 })
  fs.rmSync(archive, { force: true })
  if (unpack.code !== 0) return { ok: false, nodeDir, error: '便携版 node 解压失败。' }
  if (typeof isRunnable === 'function' && !isRunnable()) {
    return { ok: false, nodeDir, error: '便携版 node 已就位但仍无法运行。' }
  }
  return { ok: true, nodeDir }
}

module.exports = { PORTABLE_NODE_VERSION, downloadFile, ensurePortableNode }
