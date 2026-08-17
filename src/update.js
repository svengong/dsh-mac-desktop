'use strict'

/**
 * Updater — the check/build/restart pipeline behind the 「更新」 menu.
 *
 * Both modes run the same steps; only the executor differs:
 *
 * - local: git/pnpm run directly with `cwd` = the local repo dir.
 * - ssh: each step runs on the remote through `connection.remoteRun` with a
 *   `cd` prefix, so remote tools resolve through the remote login shell.
 *
 * Steps: ensure repo (clone locally/remotely when missing) → git pull
 * --ff-only (skipped when the worktree is dirty or there is no upstream) →
 * pnpm install → pnpm run build → restart the harness service.
 * The shell itself never changes across an update: it only loads a fixed URL.
 */

const fs = require('node:fs')
const path = require('node:path')
const { runCommand } = require('./runner')
const { remotePath, shellQuote, remoteToolchainPrefix } = require('./ssh')
const { engineOk } = require('./tools')
const runtimeStore = require('./runtime-store')

const LONG_TIMEOUT_MS = 45 * 60 * 1000
const REMOTE_PREFIX = remoteToolchainPrefix()

class Updater {
  constructor({ getSettings, connection, onLine, onBusyChange }) {
    this.getSettings = getSettings
    this.connection = connection
    this.onLine = onLine || (() => {})
    this.onBusyChange = onBusyChange || (() => {})
    this.busy = false
  }

  setBusy(value) {
    if (this.busy === value) return
    this.busy = value
    this.onBusyChange(value)
  }

  localRun(args, options = {}) {
    const tools = this.connection.resolvedTools()
    return runCommand({
      cmd: tools.git || 'git',
      // Bypass user-global hooks: the shell's fetch/pull/status do not need
      // developer-workflow hooks, and a hook that assumes a full dev
      // environment (e.g. git-lfs) fails the clean-env pipeline.
      args: ['-c', 'core.hooksPath=/dev/null', ...args],
      cwd: this.getSettings().local.repoDir,
      env: tools.env,
      timeoutMs: options.timeoutMs,
      onLine: options.onLine,
    })
  }

  async remoteGit(args, options = {}) {
    const settings = this.getSettings()
    const dir = remotePath(settings.ssh.remoteRepoDir)
    return this.connection.remoteRun(
      settings.ssh.host,
      `cd ${dir} && git -c core.hooksPath=/dev/null ${args.map(shellQuote).join(' ')}`,
      {
        timeoutMs: options.timeoutMs,
        onLine: options.onLine,
      },
    )
  }

  async runStep(label, run) {
    this.onLine(`\n==> ${label}`)
    const result = await run()
    if (result.code !== 0) throw new Error(`${label} 失败（退出码 ${result.code}）。详见上方日志。`)
    return result
  }

  /** Whether the configured repo is a git repo with an upstream branch. */
  async gitFacts() {
    const settings = this.getSettings()
    const run = settings.mode === 'ssh'
      ? args => this.remoteGit(args, { timeoutMs: 60_000 })
      : args => this.localRun(args, { timeoutMs: 60_000 })
    const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (branch.code !== 0) return { gitRepo: false, branch: '', upstream: '', ahead: 0, behind: 0, dirty: false, head: '' }
    const head = await run(['rev-parse', 'HEAD'])
    const upstream = await run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    const dirty = await run(['status', '--porcelain'])
    let ahead = 0
    let behind = 0
    if (upstream.code === 0) {
      const counts = await run(['rev-list', '--left-right', '--count', 'HEAD...@{u}'])
      if (counts.code === 0) {
        const match = /^(\d+)\s+(\d+)$/.exec(counts.lines.join('\n').trim())
        if (match) {
          ahead = Number(match[1])
          behind = Number(match[2])
        }
      }
    }
    return {
      gitRepo: true,
      branch: (branch.lines[0] || '').trim(),
      head: head.code === 0 ? (head.lines[0] || '').trim() : '',
      upstream: upstream.code === 0 ? (upstream.lines[0] || '').trim() : '',
      ahead,
      behind,
      dirty: dirty.code === 0 && dirty.lines.length > 0,
    }
  }

  async check() {
    const settings = this.getSettings()
    this.onLine('获取远端更新信息（git fetch）…')
    const fetch = settings.mode === 'ssh'
      ? await this.remoteGit(['fetch', '--quiet'], { timeoutMs: 120_000, onLine: line => this.onLine(line) })
      : await this.localRun(['fetch', '--quiet'], { timeoutMs: 120_000, onLine: line => this.onLine(line) })
    if (fetch.code !== 0) {
      this.onLine(`git fetch 失败（退出码 ${fetch.code}）。请检查网络或 git 远程配置。`)
      return { gitRepo: false, branch: '', upstream: '', ahead: 0, behind: 0, dirty: false, summary: 'git fetch 失败' }
    }
    const facts = await this.gitFacts()
    if (!facts.gitRepo) {
      this.onLine('当前仓库不是 git 仓库（或未配置 origin/upstream），无法检查更新。')
      return { ...facts, summary: '不是 git 仓库，无法检查更新' }
    }
    if (facts.upstream === '') {
      this.onLine(`当前分支 ${facts.branch} 没有上游分支，无法检查更新。`)
      return { ...facts, summary: '没有上游分支，无法检查更新' }
    }
    this.onLine(`分支：${facts.branch}`)
    this.onLine(`上游：${facts.upstream}`)
    if (facts.dirty) this.onLine('工作区有未提交改动（更新时将跳过 git pull）。')
    if (facts.ahead > 0) this.onLine(`本地领先上游 ${facts.ahead} 个提交。`)
    if (facts.behind === 0) {
      this.onLine('已是最新版本。')
      return { ...facts, summary: '已是最新版本' }
    }
    this.onLine(`落后上游 ${facts.behind} 个提交，可以更新。`)
    return { ...facts, summary: `落后上游 ${facts.behind} 个提交` }
  }

  /** Version token for the build we are about to run. */
  async buildVersion(settings, facts) {
    if (facts.head !== '' && !facts.dirty) return facts.head
    if (settings.mode === 'local') {
      try {
        const stat = fs.statSync(path.join(settings.local.repoDir, 'apps/cli/lib/bin.js'))
        return `dirty:${stat.mtimeMs}`
      } catch {
        return `dirty:${Date.now()}`
      }
    }
    const result = await this.connection.remoteRun(
      settings.ssh.host,
      `stat -f %m ${remotePath(settings.ssh.remoteRepoDir)}/apps/cli/lib/bin.js 2>/dev/null || echo ${Date.now()}`,
      { timeoutMs: 15_000 },
    )
    return `dirty:${(result.lines[0] || String(Date.now())).trim()}`
  }

  async localInstallBuild(settings, tools, cwd) {
    await this.runStep('pnpm install', () => runCommand({
      cmd: tools.pnpm,
      args: [...tools.pnpmPrefix, 'install'],
      cwd,
      env: tools.env,
      timeoutMs: LONG_TIMEOUT_MS,
      onLine: line => this.onLine(line),
    }))
    await this.runStep('pnpm run build', () => runCommand({
      cmd: tools.pnpm,
      args: [...tools.pnpmPrefix, 'run', 'build'],
      cwd,
      env: tools.env,
      timeoutMs: LONG_TIMEOUT_MS,
      onLine: line => this.onLine(line),
    }))
  }

  async remoteInstallBuild(settings, workDir) {
    await this.runStep('pnpm install', () => this.connection.remoteRun(
      settings.ssh.host,
      `${REMOTE_PREFIX} cd ${workDir} && pnpm install`,
      { timeoutMs: LONG_TIMEOUT_MS, onLine: line => this.onLine(line) },
    ))
    await this.runStep('pnpm run build', () => this.connection.remoteRun(
      settings.ssh.host,
      `${REMOTE_PREFIX} cd ${workDir} && pnpm run build`,
      { timeoutMs: LONG_TIMEOUT_MS, onLine: line => this.onLine(line) },
    ))
  }

  async prepareLocalRuntime(settings, facts, tools) {
    const version = await this.buildVersion(settings, facts)
    const token = runtimeStore.versionToken(version)
    const manifest = runtimeStore.readLocalRootManifest(settings)
    const activeDir = runtimeStore.localActiveRuntimeDir(settings)
    if (manifest.current === token && activeDir !== null) {
      this.onLine(`运行时 ${token} 已构建，跳过 staging install/build。`)
      return { workDir: activeDir, version: token, activated: false, previous: manifest.previous }
    }
    if (facts.dirty) {
      this.onLine('工作区有未提交改动：直接在源目录构建（此模式无上一版本快照）。')
      await this.localInstallBuild(settings, tools, settings.local.repoDir)
      return { workDir: settings.local.repoDir, version: token, activated: false, previous: null }
    }
    const buildDir = runtimeStore.localVersionDir(settings, version)
    fs.rmSync(buildDir, { recursive: true, force: true })
    this.onLine(`准备 staging 构建目录：${buildDir}`)
    await this.runStep('git worktree add', () => this.localRun(
      ['worktree', 'add', '--detach', buildDir, facts.head],
      { timeoutMs: 10 * 60_000, onLine: line => this.onLine(line) },
    ))
    try {
      await this.localInstallBuild(settings, tools, buildDir)
    } catch (error) {
      await this.localRun(['worktree', 'remove', '--force', buildDir]).catch(() => {})
      throw error
    }
    runtimeStore.writeLocalRuntimeManifest(settings, version, { sourceVersion: facts.head })
    const activated = runtimeStore.activateLocalRuntime(settings, version)
    this.onLine(`已原子切换到运行时 ${activated}（上一版本：${manifest.current ?? '无'}）。`)
    return {
      workDir: runtimeStore.localActiveRuntimeDir(settings) ?? buildDir,
      version: activated,
      activated: true,
      previous: manifest.current,
    }
  }

  async prepareRemoteRuntime(settings, facts, remoteRun) {
    const version = await this.buildVersion(settings, facts)
    const token = runtimeStore.versionToken(version)
    const manifest = await runtimeStore.readRemoteRootManifest(settings, remoteRun)
    const activeDir = await runtimeStore.remoteActiveRuntimeDir(settings, remoteRun)
    if (manifest.current === token && activeDir !== null) {
      this.onLine(`远端运行时 ${token} 已构建，跳过 staging install/build。`)
      return { workDir: activeDir, version: token, activated: false, previous: manifest.previous }
    }
    if (facts.dirty) {
      this.onLine('远端工作区有未提交改动：直接在源目录构建（此模式无上一版本快照）。')
      await this.remoteInstallBuild(settings, remotePath(settings.ssh.remoteRepoDir))
      return { workDir: remotePath(settings.ssh.remoteRepoDir), version: token, activated: false, previous: null }
    }
    const buildDir = runtimeStore.remoteVersionDir(version)
    const source = remotePath(settings.ssh.remoteRepoDir)
    this.onLine(`准备远端 staging 构建目录：${buildDir}`)
    const add = await this.connection.remoteRun(
      settings.ssh.host,
      `rm -rf ${buildDir}; cd ${source} && git -c core.hooksPath=/dev/null worktree add --detach ${buildDir} ${facts.head}`,
      { timeoutMs: 10 * 60_000, onLine: line => this.onLine(line) },
    )
    if (add.code !== 0) throw new Error(`远端 git worktree add 失败：${add.lines.join('\n')}`)
    try {
      await this.remoteInstallBuild(settings, buildDir)
    } catch (error) {
      await this.connection.remoteRun(
        settings.ssh.host,
        `cd ${source} && git worktree remove --force ${buildDir} 2>/dev/null || rm -rf ${buildDir}`,
        { timeoutMs: 30_000 },
      )
      throw error
    }
    const activated = await runtimeStore.activateRemoteRuntime(settings, remoteRun, version)
    this.onLine(`已原子切换远端运行时 ${activated}（上一版本：${manifest.current ?? '无'}）。`)
    return { workDir: await runtimeStore.remoteActiveRuntimeDir(settings, remoteRun) ?? buildDir, version: activated, activated: true, previous: manifest.current }
  }

  /**
   * Run the update pipeline: pull (optional) → staged install/build →
   * atomic `current` switch → restart. A failed new runtime automatically
   * falls back to the previous finished version.
   * @param {object} options - includePull, toleratePullFailure.
   * @returns {Promise<{ok: boolean}>}
   */
  async runPipeline({ includePull = true, toleratePullFailure = false } = {}) {
    this.setBusy(true)
    try {
      const settings = this.getSettings()
      const remoteRun = (host, inner, options) => this.connection.remoteRun(host, inner, options)
      const executePipeline = async () => {
        let tools = this.connection.resolvedTools()
        await this.runStep('确保仓库就绪', () => settings.mode === 'ssh'
          ? this.connection.ensureRemoteRepo(settings)
          : this.connection.ensureLocalRepo(settings))
        await this.ensureToolchain(settings)
        if (settings.mode === 'local') tools = this.connection.resolvedTools({ refresh: true })
        const facts = await this.gitFacts()
        if (includePull && facts.gitRepo && facts.upstream !== '') {
          if (facts.dirty) {
            this.onLine('工作区有未提交改动，跳过 git pull。')
          } else {
            try {
              await this.runStep('git pull --ff-only', () => settings.mode === 'ssh'
                ? this.remoteGit(['pull', '--ff-only'], { timeoutMs: 10 * 60_000, onLine: line => this.onLine(line) })
                : this.localRun(['pull', '--ff-only'], { timeoutMs: 10 * 60_000, onLine: line => this.onLine(line) }))
            } catch (error) {
              if (!toleratePullFailure) throw error
              this.onLine(`git pull 失败（${error.message}），继续安装与构建。`)
            }
          }
        }
        if (settings.mode === 'ssh') {
          const toolchain = await this.connection.remoteRun(settings.ssh.host, `${REMOTE_PREFIX} node --version && pnpm --version`, { timeoutMs: 60_000 })
          if (toolchain.code !== 0) {
            throw new Error(
              `远程机器（${settings.ssh.host}）自包含工具链不可用（退出码 ${toolchain.code}）。\n` +
              '远端 ~/.dsh-tools 引导失败，请打开服务日志查看下载/安装输出。',
            )
          }
          this.onLine(`远程 node/pnpm：${toolchain.lines.map(line => line.trim()).filter(Boolean).join('，')}`)
        } else {
          if (tools.node === '') throw new Error('未找到兼容的 node（需 22.19+ 或 24+）。请安装 Node.js，或在「设置 → 高级」中指定 node 路径。')
          const nodeVersion = await runCommand({ cmd: tools.node, args: ['--version'], env: tools.env, timeoutMs: 60_000 })
          if (nodeVersion.code !== 0) throw new Error(`node 不可用（退出码 ${nodeVersion.code}）。`)
          const pnpmVersion = await runCommand({
            cmd: tools.pnpm,
            args: [...tools.pnpmPrefix, '--version'],
            env: tools.env,
            cwd: settings.local.repoDir,
            timeoutMs: 60_000,
          })
          if (pnpmVersion.code !== 0) throw new Error(`pnpm 不可用（退出码 ${pnpmVersion.code}）。`)
          this.onLine(`node：${(nodeVersion.lines[0] || '').trim()}；pnpm：${(pnpmVersion.lines[0] || '').trim()}`)
        }

        const prepared = settings.mode === 'ssh'
          ? await this.prepareRemoteRuntime(settings, facts, remoteRun)
          : await this.prepareLocalRuntime(settings, facts, tools)
        this.onLine(`运行时目录：${prepared.workDir}`)

        try {
          await this.runStep('重启服务', async () => {
            await this.connection.restartService()
            return { code: 0, lines: [] }
          })
        } catch (error) {
          if (prepared.activated && prepared.previous !== null && prepared.previous !== '') {
            const rollbackVersion = settings.mode === 'ssh'
              ? await runtimeStore.rollbackRemoteRuntime(settings, remoteRun)
              : runtimeStore.rollbackLocalRuntime(settings)
            if (rollbackVersion !== null && rollbackVersion !== '') {
              this.onLine(`新运行时启动失败，已回滚到 ${rollbackVersion}，尝试恢复旧服务…`)
              try {
                await this.connection.restartService()
                this.onLine('旧运行时已恢复，本次更新未生效。')
                return { ok: false, error, rolledBack: true, rollbackVersion }
              } catch (rollbackError) {
                this.onLine(`旧运行时恢复失败：${String(rollbackError.message || rollbackError)}`)
              }
            }
          }
          throw error
        }
        this.onLine('\n完成：服务已重启。')
        return { ok: true }
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
      if (String(error.message || error).includes('pnpm install')) {
        this.onLine('提示：常见原因——网络/代理导致 registry 不可达；pnpm 版本过低（该仓库要求 pnpm 10+）；目录不是 deepseek-harness 仓库。')
      }
      return { ok: false, error }
    } finally {
      this.setBusy(false)
    }
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
    })
    if (fetch.code !== 0) throw new Error(`便携版 node 下载失败（${url}）。请检查网络。`)
    const unpack = await runCommand({
      cmd: '/usr/bin/tar',
      args: ['-xzf', archive, '--strip-components=1', '-C', nodeDir],
      env: tools.env,
      timeoutMs: 5 * 60_000,
      onLine: line => this.onLine(`[tar] ${line}`),
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
    })
    if (result.code !== 0) throw new Error(`pnpm 本地安装失败：${result.lines.join('\n')}`)
    const resolved = this.connection.resolvedTools({ refresh: true })
    if (resolved.pnpm === '') throw new Error('pnpm 已安装到 .dsh-tools 但仍无法运行，请打开服务日志查看详情。')
  }

  async ensureRemoteToolchain(settings) {
    const target = settings.ssh.host
    const nodeProbe = await this.connection.remoteRun(target, `${REMOTE_PREFIX} node --version`, { timeoutMs: 60_000 })
    const nodeLine = (nodeProbe.lines[0] || '').trim()
    if (nodeProbe.code !== 0 || !engineOk(nodeLine)) {
      const archOut = await this.connection.remoteRun(target, 'uname -m', { timeoutMs: 30_000 })
      const rawArch = (archOut.lines[0] || '').trim()
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
    if (verify.code !== 0 || !engineOk(verify.lines[0] || '')) {
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
