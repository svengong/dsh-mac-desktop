'use strict'

/**
 * UpdateManager — the shell's unified update surface.
 *
 * The update rows are scoped to the active device: the always-present
 * `harness` row delegates to the existing Updater pipeline (git pull →
 * pnpm install → build → restart service), and any additional rows come from
 * that device's own `update.components` (npm plugins updated through the
 * official `dsh plugin --profile <name> add <pkg>` path, and git presets
 * mirrored into `$DSH_HOME/.agent-presets/<id>`).
 *
 * The class is plain Node (no Electron) so it is smoke-testable; window and
 * menu wiring live in main.js.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { request } = require('node:https')
const { URL } = require('node:url')
const {
  componentView, DEFAULT_COMPONENTS, expandHome, hashTreeSync, isNewerVersion, packageNameOfSpec, pluginSpecKind,
} = require('./components')
const { runCommand } = require('./runner')
const { remotePath, remoteToolchainPrefix, shellQuote } = require('./ssh')
const runtimeStore = require('./runtime-store')
const { runtimeLayout } = require('./runtime-layout')

const LONG_TIMEOUT_MS = 45 * 60 * 1000
const PLUGIN_TIMEOUT_MS = 10 * 60 * 1000
const NETWORK_TIMEOUT_MS = 20 * 1000
const REMOTE_PREFIX = remoteToolchainPrefix()

/** State each runtime component row carries between checks. */
function blankRow(def) {
  return {
    ...componentView(def),
    status: 'idle',
    current: '',
    latest: '',
    updateAvailable: false,
    summary: '尚未检查',
    error: '',
  }
}

/**
 * Fetch one JSON document over HTTPS with a hard timeout and bounded redirects.
 * @param {string} url - absolute https URL.
 * @param {number} timeoutMs - per-attempt timeout.
 * @param {number} redirects - remaining redirect budget.
 * @returns {Promise<object>} parsed JSON body.
 */
function fetchJson(url, timeoutMs = NETWORK_TIMEOUT_MS, redirects = 3) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch (error) {
      reject(new Error(`无效的 registry URL：${url}`))
      return
    }
    if (target.protocol !== 'https:') {
      reject(new Error(`registry 必须使用 https：${url}`))
      return
    }
    const req = request(target, { method: 'GET', headers: { accept: 'application/json' } }, response => {
      if (response.statusCode !== undefined && response.statusCode >= 300 && response.statusCode < 400) {
        const location = response.headers.location
        response.resume()
        if (redirects > 0 && typeof location === 'string' && location !== '') {
          fetchJson(new URL(location, target).toString(), timeoutMs, redirects - 1).then(resolve, reject)
        } else {
          reject(new Error(`registry 重定向失败（${response.statusCode}）`))
        }
        return
      }
      if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume()
        reject(new Error(`registry 返回 HTTP ${response.statusCode ?? '未知'}：${url}`))
        return
      }
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          reject(new Error(`registry 响应不是 JSON：${error.message}`))
        }
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求 registry 超时（${timeoutMs / 1000} 秒）`)))
    req.on('error', error => reject(new Error(`请求 registry 失败：${error.message}`)))
    req.end()
  })
}

/** The idempotent workspace patch the better-sidebar install script documents. */
function workspacePatchScript() {
  return `const fs = require('node:fs');
const p = process.argv[1];
let t = fs.readFileSync(p, 'utf8');
const before = t;
t = t.replace(/^(\\s*)(node-pty|protobufjs):.*$/gm, '$1$2: true');
if (!/^\\s*allowBuilds:\\s*$/m.test(t)) {
  t += '\\nallowBuilds:\\n  node-pty: true\\n  protobufjs: true\\n';
} else {
  for (const k of ['node-pty', 'protobufjs']) {
    if (!new RegExp('^\\\\s*' + k + ':\\\\s*true\\\\s*$', 'm').test(t)) {
      t = t.replace(/^(\\s*allowBuilds:\\s*)$/m, '$1\\n  ' + k + ': true');
    }
  }
}
if (!/^\\s*-\\s+dsh-better-sidebar\\s*$/m.test(t)) {
  if (/^\\s*minimumReleaseAgeExclude:\\s*$/m.test(t)) {
    t = t.replace(/^(\\s*minimumReleaseAgeExclude:\\s*)$/m, '$1\\n  - dsh-better-sidebar');
  } else {
    t += '\\nminimumReleaseAgeExclude:\\n  - dsh-better-sidebar\\n';
  }
}
if (t !== before) fs.writeFileSync(p, t);
console.log(t === before ? 'unchanged' : 'updated');`
}

class UpdateManager {
  /**
   * @param {object} deps - shell wiring.
   * @param {() => object} deps.getSettings - current normalized settings.
   * @param {(patch: object) => object} deps.saveUpdate - persist partial `update` section.
   * @param {object} deps.connection - ConnectionManager instance.
   * @param {object} deps.harnessUpdater - existing Updater instance.
   * @param {(line: string) => void} deps.onLog - line sink (session log + panels).
   * @param {() => void} deps.onState - fired after every state mutation.
   */
  constructor({ getSettings, saveUpdate, connection, harnessUpdater, onLog, onState }) {
    this.getSettings = getSettings
    this.saveUpdate = saveUpdate
    this.connection = connection
    this.harnessUpdater = harnessUpdater
    this.owner = () => connection.owner()
    this.onLog = onLog || (() => {})
    this.onState = onState || (() => {})
    this.busy = false
    this.rows = new Map()
    this.settings = getSettings()
    this.reloadComponents()
  }

  log(line) {
    this.onLog(line)
  }

  emit() {
    this.onState()
  }

  setBusy(value) {
    if (this.busy === value) return
    this.busy = value
    this.emit()
  }

  /** Re-read persisted component definitions (built-ins + user entries). */
  reloadComponents() {
    const update = this.settings.update
    const defs = Array.isArray(update?.components) ? update.components : DEFAULT_COMPONENTS
    const next = new Map()
    for (const def of defs) {
      const previous = this.rows.get(def.id)
      const row = blankRow(def)
      if (previous !== undefined) {
        Object.assign(row, {
          status: previous.status,
          current: previous.current,
          latest: previous.latest,
          updateAvailable: previous.updateAvailable,
          summary: previous.summary,
          error: previous.error,
        })
      }
      next.set(def.id, row)
    }
    this.rows = next
  }

  patchRow(id, patch) {
    const row = this.rows.get(id)
    if (row === undefined) return
    this.rows.set(id, { ...row, ...patch })
    this.emit()
  }

  /** JSON-safe snapshot for the renderer, menu labels, and notifications. */
  snapshot() {
    const components = [...this.rows.values()]
    const available = components.filter(row => row.enabled && row.updateAvailable)
    return {
      busy: this.busy,
      autoCheckOnLaunch: this.settings.update?.autoCheckOnLaunch !== false,
      lastCheckAt: this.settings.update?.lastCheckAt ?? '',
      components,
      available,
    }
  }

  enabledComponents() {
    return [...this.rows.values()].filter(row => row.enabled)
  }

  component(id) {
    const row = this.rows.get(id)
    if (row === undefined) throw new Error(`未知更新组件：${id}`)
    return row
  }

  /** The dsh home the current connection mode manages. */
  managedDshHome() {
    const settings = this.getSettings()
    if (settings.mode === 'ssh') return '~/.dsh'
    return expandHome(settings.local.dshHome || '~/.dsh')
  }

  installedPresetPath(def) {
    return path.join(this.managedDshHome(), '.agent-presets', def.presetId)
  }

  profilePath(def) {
    return path.join(this.managedDshHome(), 'profiles', def.profile)
  }

  /**
   * Resolve a preset checkout directory for the active device. Local mode
   * expands `~/`; ssh mode keeps the path remote (see remotePresetCheckoutDir).
   */
  presetCheckoutDir(def) {
    const settings = this.getSettings()
    const raw = def.checkoutDir || `~/OpenSoft/${def.id}`
    if (settings.mode === 'ssh') return this.remotePresetCheckoutDir(raw)
    return expandHome(raw)
  }

  /**
   * Rewrite an accidental local-machine absolute checkout path for ssh mode.
   * The previous global preset default stored `os.homedir()` (the shell
   * machine's home); using that path on the remote fails with a permission
   * error. Map it back to `~/...` so it resolves in the remote home.
   */
  remotePresetCheckoutDir(raw) {
    const localHome = os.homedir()
    if (raw.startsWith(localHome + path.sep)) {
      return `~/${raw.slice(localHome.length + 1).split(path.sep).join('/')}`
    }
    return raw
  }

  // ── local/remote command helpers ───────────────────────────────────────────

  gitCommand() {
    const settings = this.getSettings()
    return settings.mode === 'ssh' ? 'remote' : 'local'
  }

  localTools() {
    return this.connection.resolvedTools()
  }

  async runGit(args, { cwd, onLine } = {}) {
    const settings = this.getSettings()
    if (settings.mode === 'ssh') {
      const checkout = remotePath(cwd ?? settings.ssh.remoteRepoDir)
      return this.connection.remoteRun(
        settings.ssh.host,
        `cd ${checkout} && git -c core.hooksPath=/dev/null ${args.map(shellQuote).join(' ')}`,
        { timeoutMs: 120_000, onLine },
      )
    }
    const tools = this.localTools()
    return runCommand({
      cmd: tools.git || 'git',
      args: ['-c', 'core.hooksPath=/dev/null', ...args],
      cwd: cwd ?? settings.local.repoDir,
      env: tools.env,
      timeoutMs: 120_000,
      onLine,
      owner: this.owner(),
    })
  }

  async remoteCatJson(remoteFile) {
    const settings = this.getSettings()
    const result = await this.connection.remoteRun(
      settings.ssh.host,
      `cat ${remoteFile}`,
      { timeoutMs: 30_000 },
    )
    if (result.code !== 0) throw new Error(`无法读取远端文件：${remoteFile}`)
    return JSON.parse(result.lines.join('\n'))
  }

  async remoteDirsDiffer(left, right) {
    const settings = this.getSettings()
    const result = await this.connection.remoteRun(
      settings.ssh.host,
      `diff -qr ${remotePath(left)} ${remotePath(right)} >/dev/null 2>&1; echo $?`,
      { timeoutMs: 30_000 },
    )
    if (result.code !== 0) throw new Error(`远端目录比较失败：${result.lines.join('\n')}`)
    const code = Number((result.lines[0] ?? '2').trim())
    if (code === 0) return false
    if (code === 1) return true
    throw new Error('远端目录比较失败（diff 退出码非 0/1）')
  }

  // ── component checks ───────────────────────────────────────────────────────

  async checkHarness() {
    const row = this.component('harness')
    this.patchRow('harness', { status: 'checking', summary: 'git fetch 远端更新信息…', error: '' })
    const facts = await this.harnessUpdater.check()
    // Official-artifact verdict (local + official repo): no git facts at all,
    // the harness row mirrors the registry state instead of a branch.
    if (facts.artifact !== undefined && facts.artifact.ok && facts.updateAvailable !== undefined) {
      this.patchRow('harness', {
        status: 'ready',
        current: facts.currentNpm !== '' ? `v${facts.currentNpm}` : '未安装',
        latest: `v${facts.artifact.version}`,
        updateAvailable: facts.updateAvailable,
        summary: facts.summary,
        error: '',
      })
      return
    }
    if (!facts.gitRepo || facts.upstream === '') {
      this.patchRow('harness', {
        status: 'error',
        current: facts.branch,
        summary: facts.summary,
        error: facts.summary,
      })
      return
    }
    const current = `${facts.branch}${facts.dirty ? '（工作区有改动）' : ''}`
    const latest = facts.behind > 0 ? facts.upstream : current
    const settings = this.getSettings()
    const activeVersion = await this.connection.serviceVersion(settings)
    const sourceVersion = await this.connection.currentVersion(settings)
    const rolledBack = activeVersion !== '' && sourceVersion !== '' && activeVersion !== sourceVersion
    this.patchRow('harness', {
      status: 'ready',
      current: rolledBack ? `${current} · 运行 ${activeVersion.slice(0, 8)}` : current,
      latest,
      updateAvailable: facts.behind > 0 || rolledBack,
      summary: rolledBack
        ? `当前运行已回滚版本 ${activeVersion.slice(0, 8)}，源仓库为 ${sourceVersion.slice(0, 8)}`
        : facts.summary,
      error: '',
    })
  }

  dependencyKey(profile, def, spec) {
    const dependencies = profile.dependencies ?? {}
    if (dependencies[def.packageName] !== undefined) return def.packageName
    // Git/path specs are recorded under the package's REAL name, which may
    // differ from the component id. Find the dependency whose saved spec
    // matches what the shell installed.
    for (const [name, saved] of Object.entries(dependencies)) {
      if (typeof saved === 'string' && (saved === spec || saved.includes(spec))) return name
    }
    return def.packageName
  }

  async readInstalledNpm(def) {
    const settings = this.getSettings()
    const spec = def.installSpec || def.packageName || def.id
    try {
      if (settings.mode === 'ssh') {
        const profileFile = remotePath(`${this.managedDshHome()}/profiles/${def.profile}/package.json`)
        const profile = await this.remoteCatJson(profileFile)
        const key = this.dependencyKey(profile, def, spec)
        const nodePkg = remotePath(`${this.managedDshHome()}/profiles/${def.profile}/node_modules/${key}/package.json`)
        try {
          return { version: (await this.remoteCatJson(nodePkg)).version ?? '', spec: profile.dependencies?.[key] ?? '' }
        } catch {
          return { version: '', spec: profile.dependencies?.[key] ?? '' }
        }
      }
      const profile = JSON.parse(fs.readFileSync(path.join(this.profilePath(def), 'package.json'), 'utf8'))
      const key = this.dependencyKey(profile, def, spec)
      const nodePkg = path.join(this.profilePath(def), 'node_modules', key, 'package.json')
      try {
        return { version: JSON.parse(fs.readFileSync(nodePkg, 'utf8')).version ?? '', spec: profile.dependencies?.[key] ?? '' }
      } catch {
        return { version: '', spec: profile.dependencies?.[key] ?? '' }
      }
    } catch {
      return { version: '', spec: '' }
    }
  }

  async checkNpmComponent(def) {
    const spec = def.installSpec || def.packageName || def.id
    const kind = pluginSpecKind(spec)
    this.patchRow(def.id, {
      status: 'checking',
      summary: kind === 'registry' ? '查询 npm registry…' : '读取本地/远端已安装状态…',
      error: '',
    })
    try {
      const installed = await this.readInstalledNpm(def)
      if (kind !== 'registry') {
        // Git/path/tarball specs cannot be compared through `/latest`; the
        // shell re-runs the exact `dsh plugin add <spec>` as the update.
        const missing = installed.version === '' && installed.spec === ''
        this.patchRow(def.id, {
          status: 'ready',
          current: installed.version !== ''
            ? `v${String(installed.version).replace(/^v/, '')}`
            : installed.spec !== '' ? installed.spec : '未安装',
          latest: spec,
          updateAvailable: true,
          summary: missing
            ? `未安装，点击更新执行 dsh plugin add ${spec}`
            : `自定义安装源（${kind}），点击更新重新执行 dsh plugin add ${spec}`,
          error: '',
        })
        return { latest: spec, installed: installed.version || installed.spec }
      }
      const registryUrl = String(def.registryUrl).replace(/\/$/, '')
      const latest = await fetchJson(`${registryUrl}/${def.packageName}/latest`)
      const latestVersion = typeof latest.version === 'string' ? latest.version : ''
      if (latestVersion === '') throw new Error('registry 响应缺少 version 字段')
      const installedVersion = installed.version || installed.spec || ''
      const missing = installedVersion === ''
      const updateAvailable = missing || isNewerVersion(latestVersion, installedVersion)
      this.patchRow(def.id, {
        status: 'ready',
        current: missing ? '未安装' : `v${String(installedVersion).replace(/^v/, '')}`,
        latest: `v${latestVersion.replace(/^v/, '')}`,
        updateAvailable,
        summary: missing
          ? `未安装，可点击更新执行 dsh plugin add ${spec}`
          : updateAvailable ? `可更新到 v${latestVersion}` : '已是最新',
        error: '',
      })
      return { latest: latestVersion, installed: installedVersion }
    } catch (error) {
      this.patchRow(def.id, { status: 'error', summary: '检查失败', error: error.message })
      throw error
    }
  }


  async checkPresetComponent(def) {
    const row = this.component(def.id)
    this.patchRow(def.id, { status: 'checking', summary: 'git fetch 预设仓库…', error: '' })
    const settings = this.getSettings()
    const checkout = this.presetCheckoutDir(def)
    const exists = settings.mode === 'ssh'
      ? (await this.runGit(['rev-parse', '--is-inside-work-tree'], { cwd: checkout })).code === 0
      : fs.existsSync(path.join(checkout, '.git'))
    if (!exists) {
      // A configured git-preset source that has not been cloned yet is an
      // install opportunity, not a broken row: the update action clones it
      // and mirrors the preset directory.
      this.patchRow(def.id, {
        status: def.repoUrl === '' ? 'error' : 'ready',
        summary: def.repoUrl === ''
          ? '本地源目录不存在，且未配置仓库地址'
          : '源目录不存在，更新时将自动克隆并安装',
        current: '未检出',
        latest: def.repoUrl === '' ? '—' : def.repoUrl,
        updateAvailable: def.repoUrl !== '',
        error: def.repoUrl === '' ? `源目录不存在：${checkout}` : '',
      })
      return
    }


    const fetch = await this.runGit(['fetch', '--quiet'], { cwd: checkout })
    if (fetch.code !== 0) {
      this.patchRow(def.id, { status: 'error', summary: 'git fetch 失败', error: fetch.lines.slice(-3).join('\n') })
      return
    }
    const branch = await this.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: checkout })
    const upstream = await this.runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: checkout })
    const dirty = await this.runGit(['status', '--porcelain'], { cwd: checkout })
    let behind = 0
    if (upstream.code === 0) {
      const counts = await this.runGit(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], { cwd: checkout })
      if (counts.code === 0) {
        const match = /^(\d+)\s+(\d+)$/.exec(counts.lines.join('\n').trim())
        if (match) behind = Number(match[2])
      }
    }
    let synced = true
    try {
      if (settings.mode === 'ssh') {
        const source = `${checkout}/${def.sourceDir}`
        const target = `${this.managedDshHome()}/.agent-presets/${def.presetId}`
        synced = !(await this.remoteDirsDiffer(source, target))
      } else {
        synced = hashTreeSync(path.join(checkout, def.sourceDir)) === hashTreeSync(this.installedPresetPath(def))
      }
    } catch (error) {
      this.patchRow(def.id, { status: 'error', summary: '比较安装副本失败', error: error.message })
      return
    }
    const branchName = branch.code === 0 ? (branch.lines[0] ?? '').trim() : '?'
    const current = `${branchName}${dirty.code === 0 && dirty.lines.length > 0 ? '（工作区有改动）' : ''}`
    const updateAvailable = behind > 0 || !synced
    this.patchRow(def.id, {
      status: 'ready',
      current,
      latest: upstream.code === 0 ? (upstream.lines[0] ?? '').trim() : '—',
      updateAvailable,
      summary: behind > 0
        ? `落后 ${behind} 个提交${synced ? '' : '，且安装副本不同步'}`
        : !synced ? '安装副本与源目录不一致' : '已是最新',
      error: '',
    })
  }

  /** Check one component by id; a per-row failure becomes its error state. */
  async checkOne(id) {
    if (this.busy) return this.snapshot()
    this.setBusy(true)
    this.settings = this.getSettings()
    this.reloadComponents()
    try {
      const def = this.component(id)
      if (!def.enabled) throw new Error(`组件已停用：${def.title}`)
      if (def.kind === 'harness') await this.checkHarness()
      else if (def.kind === 'npm') await this.checkNpmComponent(def)
      else if (def.kind === 'git-preset') await this.checkPresetComponent(def)
      else throw new Error(`未知组件类型：${def.kind}`)
      this.saveUpdate({ lastCheckAt: new Date().toISOString() })
      this.settings = this.getSettings()
      return this.snapshot()
    } catch (error) {
      this.patchRow(id, { status: 'error', summary: '检查失败', error: error.message })
      throw error
    } finally {
      this.setBusy(false)
    }
  }

  /** Check every enabled component; one failure never skips the others. */
  async checkAll() {
    if (this.busy) return this.snapshot()
    this.setBusy(true)
    this.settings = this.getSettings()
    this.reloadComponents()
    const checks = this.enabledComponents().map(async row => {
      const def = this.rows.get(row.id)
      try {
        if (def.kind === 'harness') await this.checkHarness()
        else if (def.kind === 'npm') await this.checkNpmComponent(def)
        else if (def.kind === 'git-preset') await this.checkPresetComponent(def)
      } catch (error) {
        this.patchRow(row.id, { status: 'error', summary: '检查失败', error: error.message })
        this.onLog(`✗ 检查失败：${error.message}`)
      }
    })
    await Promise.all(checks)
    const lastCheckAt = new Date().toISOString()
    this.saveUpdate({ lastCheckAt })
    this.settings = this.getSettings()
    this.setBusy(false)
    return this.snapshot()
  }

  // ── component updates ──────────────────────────────────────────────────────

  async ensureBetterSidebarWorkspace(def) {
    // These pnpm workspace entries are part of dsh-better-sidebar's official
    // install contract. Other npm bundles may have their own documented
    // prerequisites; the shell must not invent policy for them.
    if (def.packageName !== 'dsh-better-sidebar') return
    const settings = this.getSettings()
    const workspace = path.join(this.profilePath(def), 'pnpm-workspace.yaml')
    if (settings.mode === 'ssh') {
      const remoteWorkspace = remotePath(`${this.managedDshHome()}/profiles/${def.profile}/pnpm-workspace.yaml`)
      const result = await this.connection.remoteRun(
        settings.ssh.host,
        `${REMOTE_PREFIX} node -e ${shellQuote(workspacePatchScript())} ${remoteWorkspace}`,
        { timeoutMs: 60_000, onLine: line => this.log(line) },
      )
      if (result.code !== 0) throw new Error(`远端 workspace 设置准备失败：${result.lines.join('\n')}`)
      this.log(`workspace 设置：${result.lines[0] ?? ''}`)
      return
    }
    const script = workspacePatchScript()
    const result = await runCommand({
      cmd: this.localTools().node,
      args: ['-e', script, workspace],
      env: this.localTools().env,
      timeoutMs: 60_000,
      onLine: line => this.log(line),
      owner: this.owner(),
    })
    if (result.code !== 0) throw new Error(`workspace 设置准备失败：${result.lines.join('\n')}`)
    this.log(`workspace 设置：${result.lines[0] ?? ''}`)
  }


  async updateNpmComponent(def) {
    const requestedSpec = def.installSpec || def.packageName || def.id
    const kind = pluginSpecKind(requestedSpec)
    const registryUrl = String(def.registryUrl || 'https://registry.npmjs.org').replace(/\/$/, '')
    let spec = requestedSpec
    let latestVersion = ''

    if (kind === 'registry') {
      const packageName = packageNameOfSpec(requestedSpec) || def.packageName
      // A bare `pnpm add pkg` leaves an exact dependency such as `"pkg":
      // "0.12.1"` untouched on pnpm 11, so only a bare package is promoted to
      // `pkg@x.y.z`. Specs that already carry a tag/range (or `npm:` alias)
      // are forwarded verbatim and the user keeps control of the policy.
      if (packageName === requestedSpec) {
        const metadata = await fetchJson(`${registryUrl}/${packageName}/latest`)
        latestVersion = typeof metadata.version === 'string' ? metadata.version : ''
        if (latestVersion === '') throw new Error(`无法解析 ${packageName} 的最新版本（registry 响应缺少 version）`)
        spec = `${packageName}@${latestVersion}`
      } else {
        try {
          const metadata = await fetchJson(`${registryUrl}/${packageName}/latest`)
          latestVersion = typeof metadata.version === 'string' ? metadata.version : ''
        } catch (error) {
          this.log(`版本检查失败，仍按原安装参数执行：${error.message}`)
        }
      }
    }

    this.patchRow(def.id, {
      status: 'updating',
      summary: `执行官方命令：dsh plugin --profile ${def.profile} add ${spec}`,
      error: '',
    })
    this.log(kind === 'registry' && latestVersion !== ''
      ? `npm 最新版本：${latestVersion}，按 ${spec} 更新。`
      : `按自定义安装参数执行：dsh plugin --profile ${def.profile} add ${spec}`)
    const settings = this.getSettings()
    await this.harnessUpdater.ensureToolchain(settings)
    await this.ensureBetterSidebarWorkspace(def)
    const registryEnv = `export npm_config_registry=${shellQuote(registryUrl)};`
    if (settings.mode === 'ssh') {
      const serviceDir = await this.connection.remoteServiceDir(settings)
      const result = await this.connection.remoteRun(
        settings.ssh.host,
        `${REMOTE_PREFIX} ${registryEnv} export DSH_HOME="$HOME"/.dsh; cd ${serviceDir} && BIN=apps/cli/lib/bin.js; [ -f "$BIN" ] || BIN=node_modules/@deepseek-ai/dsh/lib/bin.js; node "$BIN" plugin --profile ${def.profile} add ${shellQuote(spec)}`,
        { timeoutMs: PLUGIN_TIMEOUT_MS, onLine: line => this.log(line) },
      )
      if (result.code !== 0) throw new Error(`插件更新失败（退出码 ${result.code}）：${result.lines.slice(-6).join('\n')}`)
    } else {
      const tools = this.connection.resolvedTools({ refresh: true })
      const runtimeDir = runtimeStore.localActiveRuntimeDir(settings) ?? settings.local.repoDir
      const layout = runtimeLayout(runtimeDir)
      if (layout === null) throw new Error(`运行时尚未构建：${runtimeDir}`)
      const binPath = layout.bin
      // `dsh plugin` resolves pnpm from PATH, while the shell's clean env
      // intentionally excludes login-shell dirs; prepend the resolved pnpm's
      // own directory so the official CLI invocation finds the same pnpm.
      const pnpmDir = tools.pnpm === '' ? '' : path.dirname(tools.pnpm)
      const pluginEnv = {
        ...tools.env,
        DSH_HOME: this.managedDshHome(),
        npm_config_registry: registryUrl,
        PATH: pnpmDir === '' ? tools.env.PATH : `${pnpmDir}:${tools.env.PATH}`,
      }
      const result = await runCommand({
        cmd: tools.node,
        args: [binPath, 'plugin', '--profile', def.profile, 'add', spec],
        cwd: settings.local.repoDir,
        env: pluginEnv,
        timeoutMs: PLUGIN_TIMEOUT_MS,
        onLine: line => this.log(line),
        owner: this.owner(),
      })
      if (result.code !== 0) throw new Error(`插件更新失败（退出码 ${result.code}）：${result.lines.slice(-6).join('\n')}`)
    }
    await this.checkNpmComponent(def)
    this.patchRow(def.id, { status: 'ready', summary: '已更新，重启后生效' })
    return true
  }

  async ensurePresetCheckout(def) {
    const settings = this.getSettings()
    const checkout = this.presetCheckoutDir(def)
    const exists = settings.mode === 'ssh'
      ? (await this.runGit(['rev-parse', '--is-inside-work-tree'], { cwd: checkout })).code === 0
      : fs.existsSync(path.join(checkout, '.git'))
    if (exists) return
    if (def.repoUrl === '') throw new Error(`预设仓库地址为空，无法克隆：${checkout}`)
    this.log(`克隆预设仓库 ${def.repoUrl} → ${checkout}`)
    let result
    if (settings.mode === 'ssh') {
      result = await this.connection.remoteRun(
        settings.ssh.host,
        `git -c core.hooksPath=/dev/null clone ${shellQuote(def.repoUrl)} ${remotePath(checkout)}`,
        { timeoutMs: 120_000, onLine: line => this.log(line) },
      )
    } else {
      result = await this.runGit(['clone', def.repoUrl, checkout], { cwd: undefined })
    }
    if (result.code !== 0) throw new Error(`克隆预设仓库失败：${result.lines.slice(-4).join('\n')}`)
  }

  async updatePresetComponent(def) {
    this.patchRow(def.id, { status: 'updating', summary: '同步预设目录…', error: '' })
    const settings = this.getSettings()
    await this.ensurePresetCheckout(def)
    const checkout = this.presetCheckoutDir(def)
    const facts = {
      upstream: await this.runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: checkout }),
      dirty: await this.runGit(['status', '--porcelain'], { cwd: checkout }),
    }
    const dirty = facts.dirty.code === 0 && facts.dirty.lines.length > 0
    if (facts.upstream.code === 0 && !dirty) {
      const pull = await this.runGit(['pull', '--ff-only'], { cwd: checkout, onLine: line => this.log(line) })
      if (pull.code !== 0) throw new Error(`预设仓库 git pull 失败：${pull.lines.slice(-6).join('\n')}`)
    } else if (dirty) {
      this.log('预设仓库工作区有改动，跳过 git pull，按当前源目录同步。')
    }
    const target = this.installedPresetPath(def)
    const source = path.join(checkout, def.sourceDir)
    if (settings.mode === 'ssh') {
      const remoteTarget = remotePath(`${this.managedDshHome()}/.agent-presets/${def.presetId}`)
      const remoteSource = remotePath(path.posix.join(checkout, def.sourceDir))
      const copy = await this.connection.remoteRun(
        settings.ssh.host,
        `rm -rf ${remoteTarget} && mkdir -p ${remotePath(`${this.managedDshHome()}/.agent-presets`)} && cp -R ${remoteSource} ${remoteTarget}`,
        { timeoutMs: 60_000, onLine: line => this.log(line) },
      )
      if (copy.code !== 0) throw new Error(`远端同步预设失败：${copy.lines.slice(-6).join('\n')}`)
    } else {
      fs.rmSync(target, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.cpSync(source, target, { recursive: true })
    }
    await this.checkPresetComponent(def)
    this.patchRow(def.id, { status: 'ready', summary: '已同步，重启后生效' })
    return true
  }

  async updateHarness() {
    this.patchRow('harness', {
      status: 'updating',
      summary: 'git pull → staging build → 原子切换 current → 重启服务',
      error: '',
    })
    const outcome = await this.harnessUpdater.runPipeline({ includePull: true })
    if (!outcome.ok) {
      const summary = outcome.rolledBack === true
        ? `新版本启动失败，已回滚到 ${outcome.rollbackVersion}`
        : '更新失败'
      this.patchRow('harness', { status: 'error', summary, error: outcome.error?.message ?? summary })
      throw outcome.error ?? new Error(summary)
    }
    this.patchRow('harness', { status: 'ready', summary: '已更新、原子切换并重启', updateAvailable: false })
    return true
  }

  async restartService() {
    this.log('重启 DSH 服务使更新生效…')
    await this.connection.restartService()
  }

  /**
   * Serialize install/mirror work for one user component across shell
   * instances. Harness pipelines already take their own build lock.
   */
  async withComponentLock(def, task) {
    const settings = this.getSettings()
    const name = `update-${def.id}`
    if (settings.mode === 'ssh') {
      return runtimeStore.withRemoteLock(
        settings,
        (host, inner, options) => this.connection.remoteRun(host, inner, options),
        name,
        task,
        { timeoutMs: PLUGIN_TIMEOUT_MS + 5 * 60_000 },
      )
    }
    return runtimeStore.withLocalLock(settings, name, task, {
      timeoutMs: PLUGIN_TIMEOUT_MS + 5 * 60_000,
    })
  }

  /** Update one component; npm/preset updates end with a service restart. */
  async updateOne(id) {
    if (this.busy) throw new Error('已有更新任务执行中')
    this.settings = this.getSettings()
    this.reloadComponents()
    const def = this.component(id)
    if (!def.enabled) throw new Error(`组件已停用：${def.title}`)
    this.setBusy(true)
    try {
      if (def.kind === 'harness') {
        await this.updateHarness()
        return { ok: true, restarted: true }
      }
      await this.withComponentLock(def, async () => {
        if (def.kind === 'npm') await this.updateNpmComponent(def)
        else if (def.kind === 'git-preset') await this.updatePresetComponent(def)
        else throw new Error(`未知组件类型：${def.kind}`)
      })
      await this.restartService()
      return { ok: true, restarted: true }
    } finally {
      this.setBusy(false)
    }
  }

  /** Update every available enabled component; harness always goes last. */
  async updateAll() {
    if (this.busy) throw new Error('已有更新任务执行中')
    this.settings = this.getSettings()
    this.reloadComponents()
    const targets = this.enabledComponents()
      .filter(row => row.updateAvailable)
      .sort((a, b) => (a.kind === 'harness' ? 1 : 0) - (b.kind === 'harness' ? 1 : 0))
    if (targets.length === 0) {
      await this.checkAll()
      return { ok: true, changed: [], restarted: false }
    }
    this.setBusy(true)
    try {
      const changed = []
      let restarted = false
      for (const target of targets) {
        try {
          if (target.kind === 'harness') {
            await this.updateHarness()
            changed.push(target.id)
            restarted = true
            continue
          }
          await this.withComponentLock(target, async () => {
            if (target.kind === 'npm') await this.updateNpmComponent(target)
            else if (target.kind === 'git-preset') await this.updatePresetComponent(target)
            else throw new Error(`未知组件类型：${target.kind}`)
          })
          changed.push(target.id)
        } catch (error) {
          this.patchRow(target.id, { status: 'error', summary: '更新失败', error: error.message })
          throw error
        }
      }
      // The harness pipeline restarts the service itself; plugin/preset
      // updates need one explicit restart so host-half changes take effect.
      if (!restarted && changed.length > 0) {
        await this.restartService()
        restarted = true
      }
      this.log('\n更新完成。')
      return { ok: true, changed, restarted }
    } finally {
      this.setBusy(false)
    }
  }

  /** Notification key for the currently available set (dedupe auto prompts). */
  notificationKey() {
    return this.snapshot().available
      .map(row => `${row.id}:${row.latest}`)
      .sort()
      .join('|')
  }
}

module.exports = { UpdateManager, fetchJson, workspacePatchScript }
