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
      // `dirty` means "a tracked file is modified, which would block a
      // fast-forward pull". Untracked files (`?? ` in --porcelain) do NOT
      // block `git pull --ff-only` and are deliberately excluded — otherwise
      // incidental untracked files (agent notes, scratch output) would pin the
      // checkout to its old HEAD forever and make every "update" a silent
      // no-op that keeps reporting "behind".
      dirty: dirty.code === 0 && dirty.lines.some(line => !line.startsWith('??')),
    }
  }

  /**
   * Whether this device should prefer official npm artifacts over a source
   * build: local or SSH-remote with an official (or default) repo URL.
   * Custom forks keep the source pipeline. The registry preflight in
   * queryArtifact decides whether the channel is actually usable; when the
   * chain is broken the caller falls back to source building.
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
    if (this.preferArtifact(settings)) {
      const artifact = await this.queryArtifact(settings)
      if (artifact.ok) {
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
      this.onLine(artifact.reason)
      this.onLine('回退到源码构建检查。')
    }
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
    // stat -c %Y is GNU (Linux), stat -f %m is BSD (macOS). GNU stat's
    // `-f %m` prints a filesystem-info block to STDOUT and exits 1, which
    // would pollute the first line — so GNU must be tried FIRST (it fails
    // silently on macOS, whose BSD stat writes errors to stderr only).
    const result = await this.connection.remoteRun(
      settings.ssh.host,
      `stat -c %Y ${remotePath(settings.ssh.remoteRepoDir)}/apps/cli/lib/bin.js 2>/dev/null || stat -f %m ${remotePath(settings.ssh.remoteRepoDir)}/apps/cli/lib/bin.js 2>/dev/null || echo ${Date.now()}`,
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
        // Phase 2: official npm artifact first (local + official repo URL).
        // The artifact pipeline installs a prebuilt CLI into a versioned dir,
        // verifies it, and atomically switches `current` — no checkout, no
        // pnpm build. It falls back to the source pipeline below when the
        // registry chain is broken or the install fails.
        if (this.preferArtifact(settings)) {
          const artifactOutcome = await this.artifactPipeline(settings)
          if (artifactOutcome.choseArtifact) {
            if (artifactOutcome.rolledBack) {
              return { ok: false, error: artifactOutcome.error, rolledBack: true, rollbackVersion: artifactOutcome.rollbackVersion }
            }
            return { ok: true, artifact: true, version: artifactOutcome.version }
          }
        }
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
   * Returns {choseArtifact:false} when the artifact channel is unavailable so
   * the caller falls back to the source pipeline.
   */
  async artifactPipeline(settings) {
    const query = await this.queryArtifact(settings)
    if (!query.ok) {
      this.onLine(query.reason)
      return { choseArtifact: false }
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
   * remote `current`, then restart the remote service. Falls back to the
   * source pipeline only through the caller's {choseArtifact:false} path; a
   * failed install throws (and is rolled back if the switch already happened).
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
