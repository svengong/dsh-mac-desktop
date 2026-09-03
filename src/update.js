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
const { DEFAULT_REGISTRY, queryNpmArtifact, installNpmArtifact } = require('./artifact')
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
    // The cancel intent is the single source of truth for the whole update
    // flow: the main process (UI) sets it, this pipeline polls it, and
    // cancelSessionTask's SIGTERM is only the escalation when a remote ssh
    // command ignores polling for its whole timeout window.
    this.cancelled = false
    this.cancelling = false
    this.cancelReason = '用户取消'
    // The pipeline phase. Checked after each stage: the atomic switch +
    // restart section is a non-cancellable critical section, while the
    // download/install section can be aborted at any step boundary.
    this.phase = 'idle'
    // Local update intent bookkeeping: writePendingUpdate is only cleared
    // when the cancel flow settles the pipeline, so an abandoned intent file
    // (shell killed) can never be mistaken for a completed update.
    this.pendingWritten = false
  }

  setBusy(value) {
    if (this.busy === value) return
    this.busy = value
    this.onBusyChange(value)
  }

  setPhase(phase) {
    if (this.phase === phase) return
    this.phase = phase
    if (typeof this.onPhaseChange === 'function') this.onPhaseChange(phase)
  }

  /**
   * The cancel flow splits into two steps so the UI never freezes on one
   * long await: `requestCancel()` flips the intent synchronously (the button
   * flips instantly), and `awaitCancelled()` waits for the pipeline to
   * settle. A non-busy updater is already settled.
   */
  requestCancel(reason = '用户取消') {
    if (!this.busy && !this.cancelling) return
    this.cancelled = true
    this.cancelling = true
    this.cancelReason = reason
    this.setPhase('cancelling')
  }

  /** Whether a cancel was requested but the pipeline has not settled yet. */
  isCancelling() {
    return this.cancelling
  }

  /** Current in-flight cancel promise so concurrent cancel clicks share one settle. */
  get cancelPromise() {
    return this._cancelPromise ?? null
  }

  async awaitCancelled() {
    if (!this.cancelling) return this.cancelled
    if (this._cancelPromise !== null) return this._cancelPromise
    this._cancelPromise = this._waitCancelled()
    try {
      return await this._cancelPromise
    } finally {
      this._cancelPromise = null
    }
  }

  /**
   * Wait for the tracked pipeline promise to settle WITHOUT re-entering the
   * busy flag; when a task is cancelled, the promise held by the main
   * process settles at most TASK_CANCEL_TIMEOUT_MS later. A pipeline that
   * never resolves (spawn errors) is dropped here — the lock-cleanup best
   * effort below still ran, and a stale lock is reaped by its next owner.
   */
  async _waitCancelled() {
    const tracked = this._pipelinePromise
    if (tracked !== null && tracked !== undefined) {
      const outcome = await Promise.race([
        tracked.catch(() => null),
        new Promise(resolve => setTimeout(resolve, 15_000)),
      ])
      // The cancel request may have landed after the pipeline's non-cancellable
      // critical section (atomic switch + restart) already finished: that is
      // a completed update, not a cancellation.
      if (outcome !== null && outcome !== undefined && outcome.ok === true) {
        this.cancelled = false
        this.cancelReason = ''
      }
    }
    if (this.cancelled) {
      this.onLine(`\n✗ 更新已取消：${this.cancelReason}。旧版本继续运行。`)
    }
    return this.cancelled
  }

  async runStep(label, run) {
    this.onLine(`\n==> ${label}`)
    const result = await run()
    if (result.code !== 0) throw new Error(`${label} 失败（退出码 ${result.code}）。详见上方日志。`)
    return result
  }

  /** Throw the canonical cancelled error at a cancellable step boundary. */
  throwCancelled() {
    const error = new Error(`更新已取消：${this.cancelReason}`)
    error.code = 'CANCELLED'
    error.name = 'UpdateCancelledError'
    throw error
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

  /**
   * The registry every artifact operation for this device must use: the
   * configured one, or the official default when none is set. Preflight and
   * install share it so a version one step resolves is resolvable by the next.
   */
  registryUrl(settings) {
    return settings.update?.registryUrl ?? ''
  }

  /** Registry preflight for the official npm artifact (never throws). */
  async queryArtifact(settings) {
    return queryNpmArtifact({ registryUrl: this.registryUrl(settings) })
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

  /**
   * Whether ANY runnable runtime exists for this device (npm artifact OR a
   * source-built checkout). The connection path still falls back to the
   * source checkout when no artifact is installed, so a device that displays
   * a working harness must never be reported as 「未安装」.
   */
  async hasAnyRuntime(settings) {
    if (settings.mode === 'local') {
      if (runtimeStore.localActiveRuntimeDir(settings) !== null) return true
      try {
        const { runtimeLayout } = require('./runtime-layout')
        if (runtimeLayout(settings.local.repoDir) !== null) return true
      } catch {
        // Fall through.
      }
      return false
    }
    const remoteRun = (host, inner, options) => this.connection.remoteRun(host, inner, options)
    // The same probe the connection's isBuilt() uses for remote mode:
    // active runtime dir first, source checkout as the legacy fallback.
    const result = await remoteRun(
      settings.ssh.host,
      `if test -f "$HOME"/.dsh/runtime/current/apps/cli/lib/bin.js || test -f "$HOME"/.dsh/runtime/current/node_modules/@deepseek-ai/dsh/lib/bin.js || test -f ${remotePath(settings.ssh.remoteRepoDir)}/apps/cli/lib/bin.js || test -f ${remotePath(settings.ssh.remoteRepoDir)}/node_modules/@deepseek-ai/dsh/lib/bin.js; then echo yes; else echo no; fi`,
      { timeoutMs: 20_000 },
    )
    if (result.code !== 0) return false
    return result.lines.includes('yes')
  }

  async check() {
    const settings = this.getSettings()
    // The shell installs the official npm artifact exclusively; an
    // unavailable registry surfaces as the check result.
    const artifact = await this.queryArtifact(settings)
    if (!artifact.ok) {
      this.onLine(artifact.reason)
      return { artifact, currentNpm: '', updateAvailable: false, summary: artifact.reason }
    }
    const current = await this.npmCurrentVersion(settings)
    const currentVersion = current.startsWith('npm:') ? current.slice(4) : ''
    // 「未安装」must mean NO runnable runtime at all. A legacy source-built
    // deployment (pre-release devices) is NOT an npm artifact, but it IS a
    // running harness — it just needs the user to click 更新并重启 once to
    // migrate onto the official artifact. There is deliberately no separate
    // migration framework: the existing update button IS the migration.
    const hasRuntime = currentVersion !== '' || await this.hasAnyRuntime(settings)
    const legacy = hasRuntime && currentVersion === ''
    const updateAvailable = currentVersion === '' || isNewerVersion(artifact.version, currentVersion)
    const installedText = currentVersion !== '' ? `（当前 ${currentVersion}）` : legacy ? '（检测到旧版本，更新将迁移到官方产物）' : '（未安装）'
    const channelText = artifact.channel === 'latest' || artifact.channel === '' ? '' : `（${artifact.channel}）`
    // A release that won on a non-stable tag is worth one visible line: the
    // version alone does not say it came from a pre-release track.
    if (artifact.note !== undefined && artifact.note !== '') this.onLine(artifact.note)
    this.onLine(`官方产物：${NPM_PACKAGE}@${artifact.version}${channelText}${installedText}${updateAvailable ? '，可更新。' : '，已最新。'}`)
    return {
      artifact, currentNpm: currentVersion, updateAvailable,
      hasRuntime,
      legacy,
      summary: updateAvailable
        ? `官方预构建版 v${artifact.version} 可用${channelText}${legacy ? '（当前为旧版本）' : ''}`
        : `官方预构建版 v${artifact.version}${channelText}（已最新）`,
    }
  }

  /**
   * Run the update pipeline: install the official npm artifact into a
   * versioned runtime dir → verify → atomic `current` switch → restart.
   * A failed new artifact automatically rolls back to the previous version.
   *
   * Cancellation contract: the request path (registry query, toolchain
   * bootstrap, download/install) is cancellable at step boundaries — a
   * cancelled pipeline stops WITHOUT switching `current`, so the old version
   * keeps running untouched. Once the atomic switch starts (`phase:
   * 'activating'`), the pipeline is a non-cancellable critical section: the
   * switch + service restart always completes (or rolls back) so the device
   * is never left with a half-switched runtime or a stale `current`.
   * @param {object} _options - retained for call-site compatibility.
   * @returns {Promise<{ok: boolean}>}
   */
  async runPipeline(_options = {}) {
    if (this.busy) return { ok: false, error: new Error('已有更新任务执行中') }
    this.setBusy(true)
    this.pendingWritten = false
    // A leftover cancellation token from an earlier aborted worker must never
    // cancel this fresh pipeline; spawnUpdateWorker clears it for the worker
    // path and this clears it for the in-shell path.
    try {
      const settings = this.getSettings()
      if (settings.mode === 'local') runtimeStore.clearCancelToken(settings)
    } catch {
      // Best-effort.
    }
    this._pipelinePromise = this.runPipelineInner(_options)
    const tracked = this._pipelinePromise
    tracked.finally(() => {
      if (this._pipelinePromise === tracked) this._pipelinePromise = null
    }).catch(() => {})
    return this._pipelinePromise
  }

  async runPipelineInner(_options = {}) {
    const cancelError = () => {
      const error = new Error(`更新已取消：${this.cancelReason}`)
      error.code = 'CANCELLED'
      error.name = 'UpdateCancelledError'
      return error
    }
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
      const lockName = runtimeStore.buildLockName(settings)
      const shouldAbort = () => this.cancelled
      if (settings.mode === 'ssh') {
        return await runtimeStore.withRemoteLock(settings, remoteRun, lockName, executePipeline, {
          timeoutMs: LONG_TIMEOUT_MS + 5 * 60_000,
          shouldAbort,
        })
      }
      return await runtimeStore.withLocalLock(settings, lockName, executePipeline, {
        timeoutMs: LONG_TIMEOUT_MS + 5 * 60_000,
        shouldAbort,
      })
    } catch (error) {
      if (this.cancelled || error.code === 'CANCELLED') return { ok: false, cancelled: true, reason: this.cancelReason, error: cancelError() }
      this.onLine(`\n✗ ${String(error.message || error)}`)
      return { ok: false, error }
    } finally {
      // A settled pipeline (ok or error) has no unfinished intent left;
      // a killed process never reaches this point and leaves the pending
      // file behind for next-launch resume. The local install-dir cleanup is
      // deliberately NOT tied to this flag: a cancelled local install still
      // has to wait for its npm child to exit before it can be reaped.
      try {
        const current = this.getSettings()
        if (current.mode === 'local') {
          runtimeStore.clearPendingUpdate(current)
          runtimeStore.clearCancelToken(current)
        }
      } catch {
        // Best-effort.
      }
      this.pendingWritten = false
      this.cancelling = false
      this.setPhase('idle')
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
    this.setPhase('querying')
    const query = await this.queryArtifact(settings)
    if (this.cancelled) this.throwCancelled()
    if (!query.ok) {
      throw new Error(query.reason)
    }
    this.setPhase('preparing')
    await this.ensureToolchain(settings)
    if (this.cancelled) this.throwCancelled()
    const version = query.version
    if (settings.mode === 'ssh') {
      return this.remoteArtifactPipeline(settings, version)
    }
    const tools = this.connection.resolvedTools({ refresh: true })
    if (tools.node === '') {
      throw new Error('未找到兼容的 node（需 22.19+ 或 24+）。请安装 Node.js，或在「设置 → 高级」中手动指定 node 路径。')
    }
    runtimeStore.writePendingUpdate(settings, { intent: 'artifact', version })
    this.pendingWritten = true
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
    this.setPhase('downloading')
    let installed
    try {
      installed = await installNpmArtifact({
        nodeBin: tools.node,
        runtimeDir: buildDir,
        spec: `${NPM_PACKAGE}@${version}`,
        env: tools.env,
        // Same registry the preflight resolved the version from — otherwise
        // the install silently follows ~/.npmrc and can disagree with the
        // metadata the preflight trusted.
        registryUrl: this.registryUrl(settings),
        onLine: line => this.onLine(line),
        owner: this.owner(),
        shouldAbort: () => this.cancelled,
      })
    } catch (error) {
      // A cancelled local install reaps its half-written version dir right
      // away (the child is dead by then, or the abort raced the cleanup and
      // the next attempt re-rm's it anyway). Real failures get the same
      // reaping: a broken version dir must never linger as a rollback target.
      fs.rmSync(buildDir, { recursive: true, force: true })
      throw error
    }
    // Critical section starts here. Between the atomic switch and a settled
    // service restart, cancel is ignored: the device must never be left with
    // `current` pointing at an unverified runtime or a dead service.
    this.setPhase('activating')
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
    this.pendingWritten = true
    // Skip when the active remote runtime is already this artifact version.
    const manifest = await runtimeStore.readRemoteRootManifest(settings, remoteRun)
    const active = await runtimeStore.remoteActiveRuntimeDir(settings, remoteRun)
    if (this.cancelled) this.throwCancelled()
    if (manifest.current === token && active !== null) {
      this.onLine(`远端官方产物 v${version} 已安装，跳过下载。`)
      return { choseArtifact: true, fresh: false, version }
    }
    this.onLine(`远端下载官方预构建版 ${NPM_PACKAGE}@${version} → ${versionDir} …`)
    this.setPhase('downloading')
    // Pin the registry here too: the remote npm would otherwise use the
    // remote machine's ~/.npmrc, which need not be the registry whose
    // dist-tags the preflight just read.
    const registry = String(this.registryUrl(settings) || DEFAULT_REGISTRY).replace(/\/$/, '')
    const install = await remoteRun(
      settings.ssh.host,
      `rm -rf ${versionDir} && mkdir -p ${versionDir} && ${remoteToolchainPrefix()} cd ${versionDir} && npm install --prefix ${versionDir} --no-audit --no-fund --registry ${registry} ${NPM_PACKAGE}@${version}`,
      { timeoutMs: 20 * 60_000, onLine: line => this.onLine(line), shouldAbort: () => this.cancelled },
    )
    if (install.aborted === true) {
      // The ssh child group was terminated mid-install; the half-written
      // version dir is reaped so a later rollback can never target it.
      await remoteRun(settings.ssh.host, `rm -rf ${versionDir} 2>/dev/null || true`, { timeoutMs: 15_000 })
      this.throwCancelled()
    }
    if (install.code !== 0) {
      const tail = install.lines.slice(-8).join('\n')
      // An ETARGET here is the same stale-metadata failure the local path
      // retries: name it plainly instead of letting npm's raw wording stand.
      const hint = /notarget|no matching version found|ETARGET/iu.test(tail)
        ? `\n\n该 registry（${registry}）未报告依赖所需的版本，通常是镜像同步滞后或远端 npm 缓存过期，可在远端执行 npm cache clean --force 后重试。`
        : ''
      throw new Error(`远端官方产物安装失败（退出码 ${install.code}）：${tail}${hint}`)
    }
    // Cancelling the remote install only aborts at step boundaries (the ssh
    // child group is killed by cancelSessionTask; the remote command group
    // dies with the ssh connection and the half-written version dir is
    // re-rm'd by the next attempt). Between `activating` and a settled
    // restart the pipeline is a non-cancellable critical section.
    if (this.cancelled) {
      await remoteRun(settings.ssh.host, `rm -rf ${versionDir} 2>/dev/null || true`, { timeoutMs: 15_000 })
      this.throwCancelled()
    }
    const verify = await remoteRun(
      settings.ssh.host,
      `if test -f ${versionDir}/node_modules/@deepseek-ai/dsh/lib/bin.js; then echo ok; else echo missing; fi`,
      { timeoutMs: 20_000 },
    )
    if (!verify.lines.includes('ok')) throw new Error(`远端官方产物校验失败：${versionDir}`)
    this.setPhase('activating')
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
    // A corepack-only "pnpm" is not enough for the official `dsh plugin`
    // path, which execs a real `pnpm` from PATH. Install a standalone pnpm
    // into `.dsh-tools` so child processes (and harness upgrades) always see
    // a real pnpm executable.
    if (tools.pnpm !== '' && tools.pnpmPrefix.length === 0) return
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
