'use strict'

const { randomUUID } = require('node:crypto')
const { fetchJson } = require('./update-manager')
const { NPM_PACKAGE } = require('./runtime-layout')
const { withRemoteLock } = require('./runtime-store')
const { remoteToolchainPrefix, shellQuote } = require('./ssh')
const { nodeDistArchive } = require('./platform')
const {
  PORTABLE_NODE_BUNDLED, parseNodeVersion, nodeVersionMeets, resolvePortableNodeVersion, nodeRequirementError,
} = require('./node-engine')

const TOOL_ROOT = '"$HOME"/.dsh-tools'

async function readRemoteNodeEngine(settings, remoteRun, dir) {
  const pkg = `${dir}/node_modules/${NPM_PACKAGE}/package.json`
  const result = await remoteRun(settings.ssh.host, [
    `if test -f ${dir}/apps/cli/lib/bin.js; then cat ${dir}/package.json;`,
    `elif test -f ${pkg}; then cat ${pkg}; fi`,
  ].join(' '), { timeoutMs: 20_000 })
  if (result.code !== 0) return ''
  try {
    return JSON.parse(result.lines.join('\n')).engines?.node ?? ''
  } catch {
    return ''
  }
}

async function prepareRemoteNode(settings, remoteRun, { floor, artifactVersion, onLine = () => {}, fetchIndex = fetchJson }) {
  const run = (command, options) => remoteRun(settings.ssh.host, command, { timeoutMs: 30_000, ...options })
  const probe = async command => {
    const result = await run(command)
    return result.code === 0 ? result.lines.map(parseNodeVersion).find(Boolean) || '' : ''
  }
  const probePath = () => probe(`${remoteToolchainPrefix()} node --version`)
  let currentVersion = ''
  let version
  try {
    const effectiveVersion = await probePath()
    if (nodeVersionMeets(effectiveVersion, floor)) return effectiveVersion
    return await withRemoteLock(settings, remoteRun, 'portable-node', async () => {
      const recovery = await run(`D=${TOOL_ROOT}; if [ ! -e "$D/node" ] && [ -d "$D/node.old" ]; then mv "$D/node.old" "$D/node"; fi`)
      if (recovery.code !== 0) throw new Error(recovery.lines.join(' '))
      currentVersion = await probe(`${TOOL_ROOT}/node/bin/node --version`)
      const installedVersion = await probePath()
      if (nodeVersionMeets(installedVersion, floor)) return installedVersion

      const host = await run('uname -s && uname -m')
      const os = host.lines.find(line => /^(Linux|Darwin)$/.test(line.trim()))?.trim()
      const cpu = host.lines.find(line => /^(aarch64|arm64|x86_64|x64|amd64)$/.test(line.trim()))?.trim()
      if (host.code !== 0 || !os || !cpu) throw new Error('无法识别远端 Node.js 下载所需的系统或架构。')
      const arch = /^(aarch64|arm64)$/.test(cpu) ? 'arm64' : 'x64'
      const target = { windows: false, platform: os.toLowerCase() }
      version = await resolvePortableNodeVersion({
        floor, fetchJson: fetchIndex, distFile: nodeDistArchive(PORTABLE_NODE_BUNDLED, arch, target).indexFile,
      })
      const dist = nodeDistArchive(version, arch, target)
      const stage = `${TOOL_ROOT}/node.download-${randomUUID()}`
      onLine(`正在下载远端便携版 Node.js v${version}（产物要求 >=${floor}）…`)
      try {
        const staged = await run([
          'set -e;',
          `S=${stage}; mkdir -p "$S/node";`,
          `curl -fsSL ${shellQuote(dist.url)} -o "$S/node.tar.gz";`,
          'tar -xzf "$S/node.tar.gz" --strip-components=1 -C "$S/node";',
          '"$S/node/bin/node" --version',
        ].join(' '), { timeoutMs: 15 * 60_000, onLine })
        if (staged.code !== 0) throw new Error(`下载或解压失败：${staged.lines.slice(-3).join(' ')}`)
        const installed = staged.lines.map(parseNodeVersion).find(Boolean) || ''
        if (installed !== version || !nodeVersionMeets(installed, floor)) throw new Error('下载的 Node.js 未通过版本自检。')
        const swap = await run([
          'set -e;',
          `D=${TOOL_ROOT}; S=${stage};`,
          'rm -rf "$D/node.old";',
          'restore() { if [ ! -e "$D/node" ] && [ -d "$D/node.old" ]; then mv "$D/node.old" "$D/node"; fi; };',
          "trap 'restore' EXIT; trap 'exit 1' HUP INT TERM;",
          'if [ -e "$D/node" ]; then mv "$D/node" "$D/node.old"; fi;',
          'mv "$S/node" "$D/node";',
          'rm -rf "$D/node.old" || true',
        ].join(' '))
        if (swap.code !== 0) throw new Error(`替换失败：${swap.lines.slice(-3).join(' ')}`)
        onLine(currentVersion
          ? `远端便携版 Node.js 升级：v${currentVersion} → v${installed}（产物要求 >=${floor}）`
          : `远端便携版 Node.js v${installed} 已就绪（产物要求 >=${floor}）`)
        return installed
      } finally {
        await run(`rm -rf ${stage}`).catch(() => {})
      }
    }, { timeoutMs: 20 * 60_000 })
  } catch (error) {
    throw new Error(nodeRequirementError({ floor, artifactVersion, currentVersion, targetVersion: version, detail: error.message, remote: true }))
  }
}

module.exports = { prepareRemoteNode, readRemoteNodeEngine }
