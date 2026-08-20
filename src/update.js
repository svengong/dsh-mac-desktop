'use strict'

/**
 * Updater — the check/install/restart pipeline behind the 「更新」 menu.
 *
 * The shell installs the harness from the official npm artifact
 * (`@deepseek-ai/dsh`) exclusively — no source checkout, no pnpm build.
 * Steps: registry preflight → npm install into a versioned runtime dir →
 * verify → atomic `current` switch → restart the service. A failed new
 * artifact rolls back to the previous version automatically.
 */

const fs = require('node:fs')
const path = require('node:path')
const { runCommand } = require('./runner')
const { remotePath, shellQuote, remoteToolchainPrefix } = require('./ssh')
const { engineOk } = require('./tools')
const { isNewerVersion } = require('./components')
const { queryNpmArtifact, installNpmArtifact } = require('./artifact')
const { NPM_PACKAGE, npmArtifactVersion } = require('./runtime-layout')
const { OFFICIAL_REPO_URL } = require('./settings')
const runtimeStore = require('./runtime-store')

const LONG_TIMEOUT_MS = 45 * 60 * 1000
const REMOTE_PREFIX = remoteToolchainPrefix()

/**
 * Return the first non-empty line of a remote command's output that satisfies
 * `predicate`, or '' when none matches. `remoteRun` already isolates the
 * command payload from any login-shell banner, so this only has to pick the
 * one reporting line (e.g. the node version) out of a command's own output.
 */
function firstLineMatching(lines, predicate) {
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed !== '' && predicate(trimmed)) return trimmed
  }
  return ''
}

class Updater {
  constructor({ getSettings, connection, onLine, onBusyChange }) {
    this.getSettings = getSettings
    this.connection = connection
    this.owner = () => connection.owner()
    this.onLine = onLine || (() => {})
    this.onBusyChange = onBusyChange || (() => {})
    this.busy = false
  }

  setBusy(value) {
    if (this.busy === value) return
    this.busy = value
    this.onBusyChange(value)
  }

  async runStep(label, run) {
    this.onLine(`\n==> ${label}`)
    const result = await run()
    if (result.code !== 0) throw new Error(`${label} 失败（退出码 ${result.code}）。详见上方日志。`)
    return result
  }

  /**
   * Whether this device should use the official npm artifact. The shell now
   * installs the official artifact exclusively (no source build), so this
   * only distinguishes official-repo devices from custom forks.
   */
  preferArtifact(settings) {
    const url = settings.mode === 'local'
      ? String(settings.local.repoUrl || '').trim()
      : settings.mode === 'ssh' ? String(settings.ssh.remoteRepoUrl || '').trim() : ''
    return url === '' || url === OFFICIAL_REPO_URL
  }

  /** Registry preflight for the official npm artifact (never throws). */
  async queryArtifact(settings) {
    return queryNpmArtifact({ registryUrl: settings.update?.registryUrl ?? '' })
  }

  /**
   * The currently active npm-layout version token ('npm:...'), or '' when
   * the active runtime is not an npm artifact (source-built or none).
   */
  async npmCurrentVersion(settings) {
    if (settings.mode === 'local') {
      const active = runtimeStore.localActiveRuntimeDir(settings)
      if (active === null) return ''
      return npmArtifactVersion(active)
    }
    const remoteRun = (host, inner, options) => this.connection.remoteRun(host, inner, options)
    const manifest = await runtimeStore.readRemoteRootManifest(settings, remoteRun)
    const active = await runtimeStore.remoteActiveRuntimeDir(settings, remoteRun)
    if (manifest.current !== null && active !== null && manifest.current.startsWith('npm')) {
      return `npm:${manifest.current.slice(3)}`
    }
    return ''
  }

  async check() {
    const settings = this.getSettings()
    // The shell now installs the official npm artifact exclusively; there is
    // no source-build fallback, so an unavailable registry is surfaced as the
    // check result rather than a git branch comparison.
    const artifact = await this.queryArtifact(settings)
    if (!artifact.ok) {
      this.onLine(artifact.reason)
      return { gitRepo: false, branch: '', upstream: '', ahead: 0, behind: 0, dirty: false, summary: artifact.reason }
    }
    const current = await this.npmCurrentVersion(settings)
    const currentVersion = current.startsWith('npm:') ? current.slice(4) : ''
    const updateAvailable = currentVersion === '' || isNewerVersion(artifact.version, currentVersion)
    this.onLine(`官方产物：${NPM_PACKAGE}@${artifact.version}${currentVersion !== '' ? `（当前 ${currentVersion}）` : '（未安装）'}${updateAvailable ? '，可更新。' : '，已最新。'}`)
    return {
      gitRepo: false, branch: '', upstream: '', ahead: 0, behind: 0, dirty: false,
      artifact, currentNpm: currentVersion,
      updateAvailable,
      summary: updateAvailable ? `官方预构建版 v${artifact.version} 可用` : `官方预构建版 v${artifact.version}（已最新）`,
    }
  }

  /**
   * Run the update pipeline: install the official npm artifact into a
   * versioned runtime dir → verify → atomic `current` switch → restart.
   * A failed new artifact automatically rolls back to the previous version.
   * @param {object} _options - retained for call-site compatibility.
   * @returns {Promise<{ok: boolean}>}
   */
  async runPipeline(_options = {}) {
    this.setBusy(true)
    try {
      const settings = this.getSettings()
      const remoteRun = (host, inner, options) => this.connection.remoteRun(host, inner, options)
      const executePipeline = async () => {
        const artifactOutcome = await this.artifactPipeline(settings)
        if (artifactOutcome.rolledBack) {
          return { ok: false, error: artifactOutcome.error, rolledBack: true, rollbackVersion: artifactOutcome.rollbackVersion }
        }
        return { ok: true, artifact: true, version: artifactOutcome.version }
      }
      const lockName = settings.mode === 'ssh'
        ? `build-${settings.ssh.host}-${settings.ssh.remoteRepoDir}`
        : `build-${path.basename(settings.local.repoDir)}`
      if (settings.mode === 'ssh') {
        return await runtimeStore.withRemoteLock(settings, remoteRun, lockName, executePipeline, {
          timeoutMs: LONG_TIMEOUT_MS + 5 * 60_000,
        })
      }
      return await runtimeStore.withLocalLock(settings, lockName, executePipeline, {
        timeoutMs: LONG_TIMEOUT_MS + 5 * 60_000,
      })
    } catch (error) {
      this.onLine(`\n✗ ${String(error.message || error)}`)
      return { ok: false, error }
    } finally {
      // A settled pipeline (ok or error) has no unfinished intent left;
      // a killed process never reaches this point and leaves the pending
      // file behind for next-launch resume.
      try {
        const current = this.getSettings()
        if (current.mode === 'local') runtimeStore.clearPendingUpdate(current)
      } catch {
        // Best-effort.
      }
      this.setBusy(false)
    }
  }

  /**
   * The official-artifact update path: registry preflight → npm install into
   * a versioned runtime dir → verify → atomic `current` switch → restart.
   * The artifact is the ONLY install channel now; an unavailable registry or
   * a broken publish chain throws (no source-build fallback).
   */
  async artifactPipeline(settings) {
    const query = await this.queryArtifact(settings)
    if (!query.ok) {
      throw new Error(query.reason)
    }
    await this.ensureToolchain(settings)
    const version = query.version
    if (settings.mode === 'ssh') {
      return this.remoteArtifactPipeline(settings, version)
    }
    const tools = this.connection.resolvedTools({ refresh: true })
    if (tools.node === '') {
      throw new Error('未找到兼容的 node（需 22.19+ 或 24+）。请安装 Node.js，或在「设置 → 高级」中手动指定 node 路径。')
    }
    runtimeStore.writePendingUpdate(settings, { intent: 'artifact', version })
    const active = runtimeStore.localActiveRuntimeDir(settings)
    const currentNpm = this.npmCurrentVersion(settings)
    if (currentNpm === `npm:${version}` && active !== null) {
      this.onLine(`官方产物 v${version} 已安装，跳过下载。`)
      return { choseArtifact: true, fresh: false, version }
    }
    const buildDir = runtimeStore.localVersionDir(settings, `npm:${version}`)
    fs.rmSync(buildDir, { recursive: true, force: true })
    fs.mkdirSync(buildDir, { recursive: true })
    this.onLine(`下载官方预构建版 ${NPM_PACKAGE}@${version} → ${buildDir} …`)
    let installed
    try {
      installed = await installNpmArtifact({
        nodeBin: tools.node,
        runtimeDir: buildDir,
        spec: `${NPM_PACKAGE}@${version}`,
        env: tools.env,
        onLine: line => this.onLine(line),
        owner: this.owner(),
      })
    } catch (error) {
      fs.rmSync(buildDir, { recursive: true, force: true })
      throw error
    }
    this.onLine(`已安装 ${installed}，原子切换 current …`)
    const previous = runtimeStore.readLocalRootManifest(settings).current ?? null
    const activated = runtimeStore.activateLocalRuntime(settings, `npm:${version}`)
    this.onLine(`已切换到官方产物 ${activated}（上一版本：${previous ?? '无'}）。`)
    try {
      await this.runStep('重启服务', async () => {
        await this.connection.restartService()
        return { code: 0, lines: [] }
      })
    } catch (error) {
      if (previous !== null && previous !== '') {
        const rollbackVersion = runtimeStore.rollbackLocalRuntime(settings)
        if (rollbackVersion !== null && rollbackVersion !== '') {
          this.onLine(`新产物启动失败，已回滚到 ${rollbackVersion}，尝试恢复旧服务…`)
          try {
            await this.connection.restartService()
            this.onLine('旧版本已恢复，本次更新未生效。')
            return { choseArtifact: true, fresh: false, rolledBack: true, rollbackVersion, error }
          } catch (rollbackError) {
            this.onLine(`旧版本恢复失败：${String(rollbackError.message || rollbackError)}`)
          }
        }
      }
      throw error
    }
    return { choseArtifact: true, fresh: true, version }
  }

  /**
   * SSH-remote official-artifact install: npm install the prebuilt CLI into
   * ~/.dsh/runtime/<npm-token> on the remote, verify, atomically switch the
   * remote `current`, then restart the remote service. A failed install
   * throws (and is rolled back if the switch already happened).
   */
  async remoteArtifactPipeline(settings, version) {
    const remoteRun = (host, inner, options) => this.connection.remoteRun(host, inner, options)
    const token = runtimeStore.versionToken(`npm:${version}`)
    const versionDir = runtimeStore.remoteVersionDir(`npm:${version}`)
    runtimeStore.writePendingUpdate(settings, { intent: 'artifact', version })
    // Skip when the active remote runtime is already this artifact version.
    const manifest = await runtimeStore.readRemoteRootManifest(settings, remoteRun)
    const active = await runtimeStore.remoteActiveRuntimeDir(settings, remoteRun)
    if (manifest.current === token && active !== null) {
      this.onLine(`远端官方产物 v${version} 已安装，跳过下载。`)
      return { choseArtifact: true, fresh: false, version }
    }
    this.onLine(`远端下载官方预构建版 ${NPM_PACKAGE}@${version} → ${versionDir} …`)
    const install = await remoteRun(
      settings.ssh.host,
      `rm -rf ${versionDir} && mkdir -p ${versionDir} && ${remoteToolchainPrefix()} cd ${versionDir} && npm install --prefix ${versionDir} --no-audit --no-fund ${NPM_PACKAGE}@${version}`,
      { timeoutMs: 20 * 60_000, onLine: line => this.onLine(line) },
    )
    if (install.code !== 0) {
      throw new Error(`远端官方产物安装失败（退出码 ${install.code}）：${install.lines.slice(-8).join('\n')}`)
    }
    const verify = await remoteRun(
      settings.ssh.host,
      `if test -f ${versionDir}/node_modules/@deepseek-ai/dsh/lib/bin.js; then echo ok; else echo missing; fi`,
      { timeoutMs: 20_000 },
    )
    if (!verify.lines.includes('ok')) throw new Error(`远端官方产物校验失败：${versionDir}`)
    this.onLine('已安装，原子切换远端 current …')
    const previous = manifest.current ?? null
    const activated = await runtimeStore.activateRemoteRuntime(settings, remoteRun, `npm:${version}`)
    this.onLine(`已切换到远端官方产物 ${activated}（上一版本：${previous ?? '无'}）。`)
    try {
      await this.runStep('重启服务', async () => {
        await this.connection.restartService()
        return { code: 0, lines: [] }
      })
    } catch (error) {
      if (previous !== null && previous !== '') {
        try {
          const rollbackVersion = await runtimeStore.rollbackRemoteRuntime(settings, remoteRun)
          if (rollbackVersion !== null && rollbackVersion !== '') {
            this.onLine(`新产物启动失败，已回滚到 ${rollbackVersion}，尝试恢复旧服务…`)
            try {
              await this.connection.restartService()
              this.onLine('旧版本已恢复，本次更新未生效。')
              return { choseArtifact: true, fresh: false, rolledBack: true, rollbackVersion, error }
            } catch (rollbackError) {
              this.onLine(`旧版本恢复失败：${String(rollbackError.message || rollbackError)}`)
            }
          }
        } catch (rollbackError) {
          this.onLine(`回滚失败：${String(rollbackError.message || rollbackError)}`)
        }
      }
      throw error
    }
    return { choseArtifact: true, fresh: true, version }
  }

  /**
   * Make the toolchain self-contained for the configured mode — the system
   * environment is never a dependency.
   *
   * Local: when no engine-compatible node resolves, download the portable
   * node tarball into `<repo>/.dsh-tools/node`; when no pnpm runs, install
   * the repo-pinned pnpm into `<repo>/.dsh-tools` via npm.
   *
   * Remote: same, but everything happens in `~/.dsh-tools` on the remote
   * through ssh; a remote system toolchain (however old) is never required.
   */
  async ensureToolchain(settings) {
    if (settings.mode === 'ssh') {
      await this.ensureRemoteToolchain(settings)
      return
    }
    let tools = this.connection.resolvedTools()
    if (tools.node === '') await this.bootstrapLocalNode(settings)
    tools = this.connection.resolvedTools({ refresh: true })
    if (tools.pnpm !== '') return
    await this.installLocalPnpm(settings, tools.node)
  }

  async bootstrapLocalNode(settings) {
    const tools = this.connection.resolvedTools()
    const version = '22.19.0'
    const platform = process.platform === 'darwin' ? 'darwin' : 'linux'
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const baseDir = path.join(settings.local.repoDir, '.dsh-tools')
    const nodeDir = path.join(baseDir, 'node')
    const archive = path.join(baseDir, 'node.tar.gz')
    fs.mkdirSync(nodeDir, { recursive: true })
    const url = `https://nodejs.org/dist/v${version}/node-v${version}-${platform}-${arch}.tar.gz`
    this.onLine(`未找到兼容的 node，正在下载便携版 node v${version} 到 ${nodeDir} …`)
    const fetch = await runCommand({
      cmd: '/usr/bin/curl',
      args: ['-fsSL', '-o', archive, url],
      env: tools.env,
      timeoutMs: 10 * 60_000,
      onLine: line => this.onLine(`[curl] ${line}`),
      owner: this.owner(),
    })
    if (fetch.code !== 0) throw new Error(`便携版 node 下载失败（${url}）。请检查网络。`)
    const unpack = await runCommand({
      cmd: '/usr/bin/tar',
      args: ['-xzf', archive, '--strip-components=1', '-C', nodeDir],
      env: tools.env,
      timeoutMs: 5 * 60_000,
      onLine: line => this.onLine(`[tar] ${line}`),
      owner: this.owner(),
    })
    fs.rmSync(archive, { force: true })
    if (unpack.code !== 0) throw new Error('便携版 node 解压失败。')
    const resolved = this.connection.resolvedTools({ refresh: true })
    if (resolved.node === '') throw new Error('便携版 node 已就位但仍无法运行。')
  }

  async installLocalPnpm(settings, nodePath) {
    const npmPath = path.join(path.dirname(nodePath), 'npm')
    if (!fs.existsSync(npmPath)) throw new Error('node 目录中没有 npm，无法安装 pnpm。')
    const version = await this.pnpmVersionFromPackageManager(settings) || '11.7.0'
    const installDir = path.join(settings.local.repoDir, '.dsh-tools')
    this.onLine(`正在把 pnpm@${version} 安装到仓库目录 .dsh-tools（不依赖系统环境）…`)
    const result = await runCommand({
      cmd: npmPath,
      args: ['install', '--prefix', installDir, `pnpm@${version}`],
      env: this.connection.resolvedTools().env,
      timeoutMs: 10 * 60_000,
      onLine: line => this.onLine(`[npm] ${line}`),
      owner: this.owner(),
    })
    if (result.code !== 0) throw new Error(`pnpm 本地安装失败：${result.lines.join('\n')}`)
    const resolved = this.connection.resolvedTools({ refresh: true })
    if (resolved.pnpm === '') throw new Error('pnpm 已安装到 .dsh-tools 但仍无法运行，请打开服务日志查看详情。')
  }

  async ensureRemoteToolchain(settings) {
    const target = settings.ssh.host
    const nodeProbe = await this.connection.remoteRun(target, `${REMOTE_PREFIX} node --version`, { timeoutMs: 60_000 })
    const nodeLine = firstLineMatching(nodeProbe.lines, engineOk)
    if (nodeProbe.code !== 0 || nodeLine === '') {
      const archOut = await this.connection.remoteRun(target, 'uname -m', { timeoutMs: 30_000 })
      const rawArch = firstLineMatching(archOut.lines, line => /^(aarch64|arm64|x86_64|x64|amd64)$/.test(line))
      const arch = rawArch === 'aarch64' || rawArch === 'arm64' ? 'arm64' : 'x64'
      const version = '22.19.0'
      const url = `https://nodejs.org/dist/v${version}/node-v${version}-linux-${arch}.tar.gz`
      this.onLine(`远程缺少兼容的 node，正在把便携版 node v${version} 下载到远端 ~/.dsh-tools/node …`)
      const bootstrap = await this.connection.remoteRun(target, [
        'set -e;',
        'mkdir -p "$HOME"/.dsh-tools/node "$HOME"/.dsh-tools/tmp;',
        `curl -fsSL ${shellQuote(url)} -o "$HOME"/.dsh-tools/tmp/node.tar.gz;`,
        'tar -xzf "$HOME"/.dsh-tools/tmp/node.tar.gz --strip-components=1 -C "$HOME"/.dsh-tools/node;',
        'rm -f "$HOME"/.dsh-tools/tmp/node.tar.gz;',
        '"$HOME"/.dsh-tools/node/bin/node --version;',
      ].join(' '), {
        timeoutMs: 15 * 60_000,
        onLine: line => this.onLine(`[remote-bootstrap] ${line}`),
      })
      if (bootstrap.code !== 0) throw new Error(`远程便携版 node 安装失败：${bootstrap.lines.join('\n')}`)
    }
    const pnpmProbe = await this.connection.remoteRun(target, `${REMOTE_PREFIX} pnpm --version`, { timeoutMs: 60_000 })
    if (pnpmProbe.code !== 0) {
      const version = await this.pnpmVersionFromPackageManager(settings) || '11.7.0'
      this.onLine(`正在把 pnpm@${version} 安装到远端 ~/.dsh-tools …`)
      const pnpmInstall = await this.connection.remoteRun(
        target,
        `${REMOTE_PREFIX} npm install --prefix "$HOME"/.dsh-tools pnpm@${version}`,
        { timeoutMs: 10 * 60_000, onLine: line => this.onLine(`[npm] ${line}`) },
      )
      if (pnpmInstall.code !== 0) throw new Error(`远程 pnpm 安装失败：${pnpmInstall.lines.join('\n')}`)
    }
    const verify = await this.connection.remoteRun(target, `${REMOTE_PREFIX} node --version && pnpm --version`, { timeoutMs: 60_000 })
    if (verify.code !== 0 || firstLineMatching(verify.lines, engineOk) === '') {
      throw new Error(`远程自包含工具链安装后仍不可用：${verify.lines.join('\n')}`)
    }
    this.onLine(`远程自包含工具链就绪：${verify.lines.map(line => line.trim()).filter(Boolean).join('，')}`)
  }

  /** The pnpm version pinned in the repo's package.json `packageManager` field. */
  async pnpmVersionFromPackageManager(settings) {
    try {
      let manifestText
      if (settings.mode === 'ssh') {
        const result = await this.connection.remoteRun(
          settings.ssh.host,
          `cat ${remotePath(settings.ssh.remoteRepoDir)}/package.json`,
          { timeoutMs: 30_000 },
        )
        if (result.code !== 0) return ''
        manifestText = result.lines.join('\n')
      } else {
        manifestText = fs.readFileSync(path.join(settings.local.repoDir, 'package.json'), 'utf8')
      }
      const manifest = JSON.parse(manifestText)
      const match = /^pnpm@(.+)$/.exec(String(manifest.packageManager || ''))
      return match ? match[1] : ''
    } catch {
      return ''
    }
  }
}

module.exports = { Updater }
