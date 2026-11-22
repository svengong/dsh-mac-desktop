'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { runCommand } = require('./runner')
const { extractNodeArchive, findExecutableIn, nodeDistArchive } = require('./platform')

const { nodeVersionAt, resolveTools } = require('./tools')
const { fetchJson } = require('./update-manager')
const { withLocalLock } = require('./runtime-store')
const { DEFAULT_NODE_RANGE, PORTABLE_NODE_BUNDLED, nodeVersionMeets, resolvePortableNodeVersion, nodeRequirementError } = require('./node-engine')

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

function portableVersion(nodeDir) {
  return nodeVersionAt(findExecutableIn(path.join(nodeDir, 'bin'), 'node') || findExecutableIn(nodeDir, 'node'))
}

function removeStaging(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 })
  } catch {
    // Windows can keep the previous executable open while dsh web is running.
    // A later bootstrap can retry cleanup without invalidating the new Node.
  }
}

/** Verify a staged archive before replacing the existing portable runtime. */
async function ensurePortableNode({ toolRoot, nodeRange = DEFAULT_NODE_RANGE, version, artifactVersion, onLine = () => {}, env }) {
  const nodeDir = path.join(toolRoot, 'node')
  const backup = path.join(toolRoot, 'node.old')
  let currentVersion = ''
  try {
    // Tool directories can be shared by workspaces with different data homes.
    return await withLocalLock({ local: { dshHome: toolRoot } }, 'portable-node', async () => {
      // Recover a process killed between the two renames.
      if (!fs.existsSync(nodeDir) && fs.existsSync(backup)) fs.renameSync(backup, nodeDir)
      currentVersion = portableVersion(nodeDir)
      if (nodeVersionMeets(currentVersion, nodeRange)) return { ok: true, nodeDir }

      version ??= await resolvePortableNodeVersion({ nodeRange, fetchJson, distFile: nodeDistArchive(PORTABLE_NODE_BUNDLED).indexFile })
      if (!nodeVersionMeets(version, nodeRange)) throw new Error('下载版本不符合运行要求。')
      const dist = nodeDistArchive(version)
      const staging = fs.mkdtempSync(path.join(toolRoot, `node.download-${process.pid}-`))
      try {
        const archive = path.join(staging, `node.${dist.kind}`)
        const extracted = path.join(staging, 'node')
        fs.mkdirSync(extracted)
        onLine(`正在下载便携版 Node.js v${version}（产物要求 ${nodeRange}）…`)
        let fetched = await downloadFile(dist.url, archive, { onLine })
        if (!fetched) {
          const curl = await runCommand({
            cmd: process.platform === 'win32' ? 'curl.exe' : '/usr/bin/curl',
            args: ['-fsSL', '-o', archive, dist.url],
            env,
            timeoutMs: 10 * 60_000,
            onLine: line => onLine(`[curl] ${line}`),
          }).catch(() => null)
          fetched = curl?.code === 0
        }
        if (!fetched) throw new Error('下载失败。')
        const unpack = await extractNodeArchive({ runCommand, archive, destDir: extracted, kind: dist.kind, env })
        if (unpack.code !== 0) throw new Error(`解压失败：${unpack.lines.slice(-3).join(' ')}`)
        const installed = portableVersion(extracted)
        if (installed !== version || !nodeVersionMeets(installed, nodeRange)) throw new Error('下载的 Node.js 未通过版本自检。')

        // A nonempty directory can't be overwritten with rename. Keep the
        // previous directory until the staged tree is in its final location.
        fs.rmSync(backup, { recursive: true, force: true, maxRetries: 2 })
        const hadOld = fs.existsSync(nodeDir)
        if (hadOld) fs.renameSync(nodeDir, backup)
        try {
          fs.renameSync(extracted, nodeDir)
        } catch (error) {
          if (hadOld) fs.renameSync(backup, nodeDir)
          throw error
        }
        removeStaging(backup)
        onLine(currentVersion
          ? `便携版 Node.js 升级：v${currentVersion} → v${installed}（产物要求 ${nodeRange}）`
          : `便携版 Node.js v${installed} 已就绪（产物要求 ${nodeRange}）`)
        return { ok: true, nodeDir }
      } finally {
        removeStaging(staging)
      }
    }, { timeoutMs: 30 * 60_000 })
  } catch (error) {
    return {
      ok: false,
      nodeDir,
      error: nodeRequirementError({ nodeRange, artifactVersion, currentVersion, targetVersion: version, detail: error.message }),
    }
  }
}

async function prepareLocalNode(settings, { nodeRange, artifactVersion, onLine }) {
  let tools = resolveTools(settings, { nodeRange, refresh: true })
  const toolRoot = path.join(settings.local.repoDir, '.dsh-tools')
  const portable = path.join(toolRoot, 'node')
  if (tools.node !== '' && (
    tools.node === settings.toolPaths?.node ||
    tools.node.startsWith(portable + path.sep) ||
    (!fs.existsSync(portable) && !fs.existsSync(path.join(toolRoot, 'node.old')))
  )) return tools
  const outcome = await ensurePortableNode({
    toolRoot,
    nodeRange,
    artifactVersion,
    onLine,
    env: tools.env,
  })
  if (!outcome.ok) {
    if (tools.node === '') throw new Error(outcome.error)
    onLine(`${outcome.error} 本次使用已验证的 Node.js：${tools.node}`)
    return tools
  }
  tools = resolveTools(settings, { nodeRange, refresh: true })
  if (tools.node === '') throw new Error(nodeRequirementError({ nodeRange, artifactVersion }))
  return tools
}

module.exports = { ensurePortableNode, prepareLocalNode }
