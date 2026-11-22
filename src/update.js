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
const { resolveTools } = require('./tools')
const { isNewerVersion } = require('./components')
const {
  DEFAULT_REGISTRY, BOOT_CHECK_ARGS, BOOT_CHECK_TIMEOUT_MS, assertArtifactBoot,
  queryNpmArtifact, resolveArtifactNodeRange, installNpmArtifact,
} = require('./artifact')
const { NPM_PACKAGE, npmArtifactVersion, runtimeNodeEngine } = require('./runtime-layout')
const { OFFICIAL_REPO_URL } = require('./settings')
const runtimeStore = require('./runtime-store')
const { npmFor } = require('./platform')
const { prepareLocalNode } = require('./node-bootstrap')
const { prepareRemoteNode, readRemoteNodeEngine } = require('./remote-node')

const LONG_TIMEOUT_MS = 45 * 60 * 1000
const REMOTE_PREFIX = remoteToolchainPrefix()

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
  async runPipeline(options = {}) {
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
    this._pipelinePromise = this.runPipelineInner(options)
    const tracked = this._pipelinePromise
    tracked.finally(() => {
      if (this._pipelinePromise === tracked) this._pipelinePromise = null
    }).catch(() => {})
    return this._pipelinePromise
  }

  async runPipelineInner({ restartAfterInstall = true } = {}) {
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
        const artifactOutcome = await this.artifactPipeline(settings, restartAfterInstall)
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
        // Clear whenever THIS pipeline wrote the intent — not only in local
        // mode. The file lives in the local dshHome even for an ssh update
        // (see `remoteArtifactPipeline`), but `resumePendingUpdate` only ever
        // resumes the LOCAL device, so a leftover ssh record made the next
        // launch offer to install that version locally. The old
        // `mode === 'local'` guard leaked exactly that file.
        if (this.pendingWritten) {
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
  async artifactPipeline(settings, restartAfterInstall = true) {
    this.setPhase('querying')
    const query = await this.queryArtifact(settings)
    if (this.cancelled) this.throwCancelled()
    if (!query.ok) {
      throw new Error(query.reason)
    }
    this.setPhase('preparing')
    const version = query.version
    const remoteRun = (host, inner, options) => this.connection.remoteRun(host, inner, options)
    const nodeRange = await resolveArtifactNodeRange({
      version,
      nodeEngine: query.nodeEngine,
      registryUrl: this.registryUrl(settings),
      installedEngine: async () => {
        if (settings.mode === 'local') return runtimeNodeEngine(runtimeStore.localActiveRuntimeDir(settings))
        const dir = await runtimeStore.remoteActiveRuntimeDir(settings, remoteRun)
        return dir === null ? '' : readRemoteNodeEngine(settings, remoteRun, dir)
      },
    })
    if (this.cancelled) this.throwCancelled()
    const tools = await this.ensureToolchain(settings, { nodeRange, artifactVersion: version, onLine: this.onLine })
    if (this.cancelled) this.throwCancelled()
    if (settings.mode === 'ssh') return this.remoteArtifactPipeline(settings, version, restartAfterInstall)
    runtimeStore.writePendingUpdate(settings, { intent: 'artifact', version })
    this.pendingWritten = true
    const active = runtimeStore.localActiveRuntimeDir(settings)
    const currentNpm = await this.npmCurrentVersion(settings)
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
      if (installed !== `npm:${version}`) throw new Error(`官方产物版本校验失败：预期 v${version}，安装结果为 ${installed}。`)
      if (this.cancelled) this.throwCancelled()
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
    if (!restartAfterInstall) return { choseArtifact: true, fresh: true, version }
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
  async remoteArtifactPipeline(settings, version, restartAfterInstall = true) {
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
    const spec = `${NPM_PACKAGE}@${version}`
    try {
      const install = await remoteRun(
        settings.ssh.host,
        `rm -rf ${versionDir} && mkdir -p ${versionDir} && ${REMOTE_PREFIX} cd ${versionDir} && npm install --prefix ${versionDir} --no-audit --no-fund --engine-strict --force=false --registry ${shellQuote(registry)} ${shellQuote(spec)}`,
        { timeoutMs: 20 * 60_000, onLine: line => this.onLine(line), shouldAbort: () => this.cancelled },
      )
      if (install.aborted || this.cancelled) this.throwCancelled()
      if (install.code !== 0) {
        const tail = install.lines.slice(-8).join('\n')
        const hint = /notarget|no matching version found|ETARGET/iu.test(tail)
          ? `\n\n该 registry（${registry}）未报告依赖所需的版本，通常是镜像同步滞后或远端 npm 缓存过期，可在远端执行 npm cache clean --force 后重试。`
          : ''
        throw new Error(`远端官方产物安装失败（退出码 ${install.code}）：${tail}${hint}`)
      }
      const verify = await remoteRun(settings.ssh.host, [
        REMOTE_PREFIX,
        `cd ${versionDir} && probe=$(mktemp -d ${versionDir}/.boot-check-XXXXXX) || exit 1;`,
        `trap 'rm -rf "$probe"' EXIT;`,
        `DSH_HOME="$probe" node node_modules/${NPM_PACKAGE}/lib/bin.js ${BOOT_CHECK_ARGS.map(shellQuote).join(' ')}`,
      ].join(' '), { timeoutMs: BOOT_CHECK_TIMEOUT_MS, shouldAbort: () => this.cancelled })
      if (this.cancelled) this.throwCancelled()
      assertArtifactBoot(verify, spec)
    } catch (error) {
      await remoteRun(settings.ssh.host, `rm -rf ${versionDir} 2>/dev/null || true`, { timeoutMs: 15_000 }).catch(() => {})
      throw error
    }
    this.setPhase('activating')
    this.onLine('已安装，原子切换远端 current …')
    const previous = manifest.current ?? null
    const activated = await runtimeStore.activateRemoteRuntime(settings, remoteRun, `npm:${version}`)
    this.onLine(`已切换到远端官方产物 ${activated}（上一版本：${previous ?? '无'}）。`)
    if (!restartAfterInstall) return { choseArtifact: true, fresh: true, version }
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

  async ensureToolchain(settings, requirement) {
    if (settings.mode === 'ssh') {
      await this.ensureRemoteToolchain(settings, requirement)
      return
    }
    const tools = await prepareLocalNode(settings, requirement)
    // Plugins launch a real pnpm from PATH, so a corepack-only probe isn't enough.
    if (tools.pnpm !== '' && tools.pnpmPrefix.length === 0) return tools
    return this.installLocalPnpm(settings, tools, requirement.nodeRange)
  }

  async installLocalPnpm(settings, tools, nodeRange) {
    // npm ships beside node: `npm` on POSIX, `npm.cmd` on Windows.
    const npmPath = npmFor(tools.node)
    if (npmPath === '') throw new Error('node 目录中没有 npm，无法安装 pnpm。')
    const version = await this.pnpmVersionFromPackageManager(settings) || '11.7.0'
    const installDir = path.join(settings.local.repoDir, '.dsh-tools')
    this.onLine(`正在把 pnpm@${version} 安装到仓库目录 .dsh-tools（不依赖系统环境）…`)
    const result = await runCommand({
      cmd: npmPath,
      args: ['install', '--prefix', installDir, `pnpm@${version}`],
      env: tools.env,
      timeoutMs: 10 * 60_000,
      onLine: line => this.onLine(`[npm] ${line}`),
      owner: this.owner(),
    })
    if (result.code !== 0) throw new Error(`pnpm 本地安装失败：${result.lines.join('\n')}`)
    const resolved = resolveTools(settings, { nodeRange, refresh: true })
    if (resolved.pnpm === '') throw new Error('pnpm 已安装到 .dsh-tools 但仍无法运行，请打开服务日志查看详情。')
    return resolved
  }

  async ensureRemoteToolchain(settings, requirement) {
    const target = settings.ssh.host
    const remoteRun = (host, inner, options) => this.connection.remoteRun(host, inner, options)
    const nodeVersion = await prepareRemoteNode(settings, remoteRun, requirement)
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
    await this.publishRemotePnpm(settings)
    const verify = await this.connection.remoteRun(target, `${REMOTE_PREFIX} pnpm --version`, { timeoutMs: 60_000 })
    if (verify.code !== 0) throw new Error(`远程 pnpm 安装后仍不可用：${verify.lines.join('\n')}`)
    this.onLine(`远程自包含工具链就绪：Node.js v${nodeVersion}，pnpm ${verify.lines.join(' ')}`)
  }

  /**
   * Publish the remote pnpm into the portable node's own bin directory.
   *
   * `npm install --prefix ~/.dsh-tools` puts the shim in
   * `~/.dsh-tools/node_modules/.bin`, which only a host whose launch PATH was
   * built by a shell generation that exports that directory can see — and a
   * PATH is baked into a running process, so no later fix reaches a host that
   * is already up. That is exactly how the plugin market reported "pnpm not
   * found on PATH" for a pnpm that had been installed all along: the market's
   * probe searches `~/.dsh-tools/node/bin` (first on every generation's PATH,
   * and its own `nodeBinDir`) but not `node_modules/.bin`, and the live host
   * predated that export. Linking here heals such a host without a restart,
   * because the directory is already on its PATH.
   *
   * The link is relative so the whole ~/.dsh-tools tree stays movable, and it
   * points at npm's own `.bin` shim rather than a versioned entry file
   * (`pnpm.mjs` today, `pnpm.cjs` before) so the layout survives a pnpm bump.
   * A remote with a compatible system node and no portable one is left alone:
   * it has no `node/bin` to publish into, and its launch PATH carries
   * `node_modules/.bin` directly.
   */
  async publishRemotePnpm(settings) {
    const target = settings.ssh.host
    const result = await this.connection.remoteRun(target, [
      'D="$HOME"/.dsh-tools;',
      'if [ ! -d "$D"/node/bin ] || [ -e "$D"/node/bin/pnpm ] || [ ! -e "$D"/node_modules/.bin/pnpm ]; then exit 0; fi;',
      'ln -s ../../node_modules/.bin/pnpm "$D"/node/bin/pnpm;',
      'echo linked;',
    ].join(' '), { timeoutMs: 20_000 })
    if (result.code !== 0) throw new Error(`远程 pnpm 入口发布失败：${result.lines.join('\n')}`)
    if (result.lines.some(line => line.trim() === 'linked')) {
      this.onLine('已把 pnpm 链接到远端 ~/.dsh-tools/node/bin（供已在运行的 dsh 进程直接解析）。')
    }
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
