'use strict'

/**
 * Official-artifact channel for the harness runtime (Phase 2).
 *
 * The harness publishes a prebuilt CLI to npm (`@deepseek-ai/dsh`), so the
 * shell can install a runtime WITHOUT a source checkout or a local pnpm
 * build — download → verify → atomic `current` switch, like VS Code's
 * extension/update model. This module owns:
 *
 * - `queryNpmArtifact`: registry preflight — resolves the latest version.
 * - `installNpmArtifact`: `npm install --prefix <runtimeDir>` of the pinned
 *   spec into a fresh version dir (idempotent, resumable);
 * - `verifyNpmArtifact`: the installed bin and package version exist before
 *   the web profile is checked and the dir is activated.
 */

const fs = require('node:fs')
const path = require('node:path')
const { fetchJson } = require('./update-manager')
const { runCommand } = require('./runner')
const { NPM_PACKAGE, npmArtifactVersion } = require('./runtime-layout')
const { compareVersions } = require('./components')
const { npmFor } = require('./platform')
const { DEFAULT_NODE_FLOOR, parseNodeFloor } = require('./node-engine')

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const BOOT_CHECK_ARGS = Object.freeze(['web', '--dump-config'])
const BOOT_CHECK_TIMEOUT_MS = 60_000

// The published CLI imports validation APIs absent from its published loader.
const BROKEN_RELEASE = '0.2.3-alpha.1'
const BROKEN_RELEASE_NOTE = `已跳过 v${BROKEN_RELEASE}：发布包的插件加载器缺少 EntryValidationError，无法启动。`

/**
 * An npm `notarget`/ETARGET failure means the registry that served the
 * install did not report a version its own dist-tags promised — a stale or
 * partially-replicated packument, NOT a version that was never published.
 * The mirror configured in the user's ~/.npmrc is the usual culprit: it
 * answers dist-tag queries from fresh metadata but serves dependency
 * resolution from a cached packument that predates the release.
 */
const NOTARGET_PATTERN = /notarget|no matching version found|ETARGET/iu

/** Pull the offending package name out of an npm `notarget` failure. */
function notargetPackage(text) {
  const match = /No matching version found for (@?[^@\s]+(?:\/[^@\s]+)?)@/iu.exec(String(text ?? ''))
  return match === null ? '' : match[1].trim()
}

/**
 * Every dist-tag the shell considers when resolving the newest release.
 * `latest` must stay first: it is the stable track and the documented
 * fallback when no other tag is published.
 */
const TRACKED_DIST_TAGS = Object.freeze(['latest', 'next', 'alpha', 'beta', 'rc'])

/**
 * Pick the newest published version from a registry's dist-tags.
 * Pure and smoke-testable; `queryNpmArtifact` is only its network wrapper.
 *
 * EVERY tracked tag is considered, not just `latest`: the official package
 * publishes `alpha` ahead of the stable track, so a shell that only read
 * `latest` sat on `0.1.1-rc.2` while `0.1.2-alpha.3` was already out. Unknown
 * tags are ignored (a registry may carry `canary`, `dev`, …), and the highest
 * eligible semver wins, regardless of the tag it was published on.
 * @param {object} tags - registry `dist-tags` map.
 * @returns {{ok: boolean, version: string, channel: string, reason: string, note: string}}
 */
function resolveChannelVersion(tags) {
  const source = tags !== null && typeof tags === 'object' ? tags : {}
  const fail = reason => ({ ok: false, version: '', channel: '', reason, note: '' })
  const candidates = []
  let skipped = false
  for (const tag of TRACKED_DIST_TAGS) {
    const value = source[tag]
    if (typeof value !== 'string' || value === '') continue
    if (value === BROKEN_RELEASE) {
      skipped = true
      continue
    }
    if (candidates.some(entry => entry.version === value)) continue
    candidates.push({ tag, version: value })
  }
  if (candidates.length === 0) {
    return fail(skipped ? `${BROKEN_RELEASE_NOTE} 当前没有其他可用的官方版本。` : `registry 未报告 ${NPM_PACKAGE} 的任何 dist-tag 版本`)
  }
  let best = candidates[0]
  for (const entry of candidates.slice(1)) {
    if (compareVersions(entry.version, best.version) > 0) best = entry
  }
  // Name the winning tag only when it is not the plain stable one, so an
  // ordinary stable release reads as just a version.
  const channelNote = best.tag === 'latest'
    ? ''
    : `最新可用版本来自 ${best.tag}：v${best.version}。`
  return {
    ok: true,
    version: best.version,
    channel: best.tag,
    reason: '',
    note: [skipped ? BROKEN_RELEASE_NOTE : '', channelNote].filter(Boolean).join('\n'),
  }
}

/**
 * Registry preflight for the official npm artifact. Resolves the newest
 * published version across every tracked dist-tag. Never throws.
 * @param {object} options - registryUrl, timeoutMs.
 * @returns {object} {ok, version, channel, reason, note} - reason is set when !ok.
 */
async function queryNpmArtifact({ registryUrl = '', timeoutMs = 20_000 } = {}) {
  const registry = String(registryUrl || DEFAULT_REGISTRY).replace(/\/$/, '')
  try {
    const meta = await fetchJson(`${registry}/${NPM_PACKAGE}`, timeoutMs)
    // Do NOT preflight transitive dependencies here. An earlier probe pinned
    // @deepseek-ai/dsh-web-app/latest and hard-coded the frontend package
    // name, but that name was renamed (dsh-frontend → dsh-web-frontend) and
    // latest lagged behind the version dsh actually depends on — so the probe
    // kept 404ing a perfectly installable artifact. The install's own
    // dependency resolution is authoritative: a genuinely broken chain fails
    // during installation or profile validation instead.
    const release = resolveChannelVersion(meta['dist-tags'])
    if (!release.ok) return release
    return { ...release, nodeEngine: meta.versions?.[release.version]?.engines?.node ?? '' }
  } catch (error) {
    return {
      ok: false,
      version: '',
      channel: '',
      reason: `查询官方产物失败：${error.message}`,
      note: '',
    }
  }
}

/** Resolve the pinned version's engine, including for resumed worker tasks. */
async function resolveArtifactNodeFloor({ version, nodeEngine, registryUrl, installedEngine, fetchManifest = fetchJson }) {
  let engine = nodeEngine
  if (!parseNodeFloor(engine)) {
    const registry = String(registryUrl || DEFAULT_REGISTRY).replace(/\/$/, '')
    try {
      const manifest = await fetchManifest(`${registry}/${NPM_PACKAGE}/${encodeURIComponent(version)}`, 10_000)
      engine = manifest.engines?.node
    } catch {
      // Installed metadata is still available when the version endpoint is down.
    }
  }
  return parseNodeFloor(engine) || parseNodeFloor(await installedEngine?.()) || DEFAULT_NODE_FLOOR
}

/**
 * The cache/log dirs this install owns.
 *
 * npm's default cache is `~/.npm`, and the install process does NOT control
 * who owns or sandboxes that directory. When anything about it is
 * unwritable — a root-owned `_cacache` from a `sudo npm`, a sandbox that
 * denies the path, a read-only home — npm exits 1 with EPERM before it ever
 * contacts the registry, and the user sees an update that simply never
 * happens. Reports of exactly that ("EPERM … _cacache/tmp") are what this
 * avoids: the artifact install keeps its cache beside the version it is
 * building, so it only needs the runtime root, which the shell already
 * created and owns.
 * @param {string} runtimeDir - the version dir being installed into.
 * @returns {{cache: string, logs: string}}
 */
function npmInstallDirs(runtimeDir) {
  // `<runtimeRoot>/.npm-cache` rather than inside `runtimeDir`: the version
  // dir is wiped and rebuilt on every attempt (and removed on cancel), and a
  // cache inside it would be re-downloaded every time. The sibling directory
  // survives, so retries reuse the download.
  const cache = path.join(path.dirname(runtimeDir), '.npm-cache')
  return { cache, logs: path.join(cache, '_logs') }
}

/** Human-readable reason for a failed install, keeping the directory in view. */
function describeInstallFailure(detail) {
  if (/EPERM|EACCES|permission denied/iu.test(detail)) {
    return '\n\n这是“没有写权限”导致的失败，而不是版本或网络问题：'
      + '安装进程无法写入 npm 的缓存/日志目录。壳已把缓存隔离到运行时目录，'
      + '若仍出现，请检查该目录的属主与磁盘权限。'
  }
  return ''
}

/**
 * Install the pinned official CLI into `runtimeDir` with `npm install --prefix`.
 * The runtime dir must already exist (created by the caller); node_modules is
 * created inside it. Returns the resolved bin path on success.
 *
 * The registry is passed EXPLICITLY so the install resolves against the very
 * registry the preflight queried. Leaving it implicit made the install follow
 * the user's ~/.npmrc while the preflight read the configured/official
 * registry — the two disagreed, and a mirror whose packument lagged behind
 * its dist-tags failed the install with ETARGET for a version the preflight
 * had just advertised.
 *
 * The cache and log dirs are passed explicitly for the same reason (see
 * `npmInstallDirs`): inheriting `~/.npm` lets an unrelated permission
 * problem kill an update before it starts.
 *
 * A `notarget` failure is retried instead of being reported verbatim: the
 * cached packument for the offending package is purged and the install is
 * re-run against the same registry, then — only if that also fails and a
 * non-default registry is configured — against the official registry.
 * @param {object} options - nodeBin, npmBin, runtimeDir, spec, env, onLine, timeoutMs, owner, shouldAbort, registryUrl.
 */
async function installNpmArtifact({ nodeBin, npmBin, runtimeDir, spec, env, onLine, timeoutMs = 20 * 60_000, owner = null, shouldAbort = null, registryUrl = '' }) {
  // npm ships beside node: `npm` on POSIX, `npm.cmd` on Windows.
  const npm = npmBin !== '' && npmBin !== null && npmBin !== undefined
    ? npmBin
    : npmFor(nodeBin)
  if (npm === '' || !fs.existsSync(npm)) {
    throw new Error(`npm 不可用：${npm === '' ? '(node 目录下没有 npm)' : npm}（便携版 node 应自带 npm）`)
  }
  const configured = String(registryUrl || DEFAULT_REGISTRY).replace(/\/$/, '')
  const emit = onLine === undefined ? undefined : line => onLine(`[npm] ${line}`)
  const { cache: cacheDir, logs: logsDir } = npmInstallDirs(runtimeDir)
  // The cache dir must exist before npm touches it; the whole point is to
  // never depend on `~/.npm` being writable.
  try {
    fs.mkdirSync(logsDir, { recursive: true })
  } catch (error) {
    throw new Error(`无法创建 npm 缓存目录 ${cacheDir}：${error.message}`)
  }

  const run = async registry => {
    const result = await runCommand({
      cmd: npm,
      args: [
        'install',
        '--prefix', runtimeDir,
        '--cache', cacheDir,
        '--logs-dir', logsDir,
        '--no-audit', '--no-fund', '--engine-strict', '--force=false',
        '--registry', registry,
        spec,
      ],
      cwd: runtimeDir,
      env,
      timeoutMs,
      onLine: emit,
      owner,
      shouldAbort,
    })
    if (result.aborted === true) {
      const error = new Error('官方产物安装已取消')
      error.code = 'CANCELLED'
      error.name = 'UpdateCancelledError'
      throw error
    }
    if (result.code !== 0) {
      // Keep the TAIL but also surface a permission failure's real shape: the
      // last 8 lines of an EPERM are npm's generic "chown your cache" advice,
      // which points at the wrong thing when the cache is already private.
      const tail = result.lines.slice(-8).join('\n')
      const error = new Error(
        `官方产物安装失败（退出码 ${result.code}）：${tail || '无输出'}${describeInstallFailure(tail)}`,
      )
      error.registry = registry
      throw error
    }
    const version = verifyNpmArtifact(runtimeDir)
    if (version === '') throw new Error(`官方产物安装后校验失败：${runtimeDir}`)
    return version
  }

  const version = await run(configured).catch(async error => {
    if (error.code === 'CANCELLED' || !NOTARGET_PATTERN.test(error.message)) throw error
    if (emit !== undefined) {
      emit(`[registry] ${configured} 报告的版本解析失败，判定为元数据不同步，清缓存后重试…`)
    }
    // Drop only the offending package's cached packument: a full
    // `npm cache clean --force` would force every other dependency to be
    // re-fetched on a connection that is already proving slow. The cache
    // flag must match the install's, or this would purge a cache the
    // install never reads.
    const stale = notargetPackage(error.message)
    if (stale !== '') {
      await runCommand({
        cmd: npm,
        args: ['cache', 'clean', stale, '--force', '--cache', cacheDir],
        cwd: runtimeDir,
        env,
        timeoutMs: 60_000,
        onLine: emit,
        owner,
      }).catch(() => {})
    }
    try {
      return await run(configured)
    } catch (retryError) {
      if (retryError.code === 'CANCELLED') throw retryError
      if (configured === DEFAULT_REGISTRY) throw retryError
      if (emit !== undefined) emit(`[registry] 重试仍失败，改用官方源 ${DEFAULT_REGISTRY} …`)
      try {
        return await run(DEFAULT_REGISTRY)
      } catch (fallbackError) {
        if (fallbackError.code === 'CANCELLED') throw fallbackError
        throw new Error(
          `${fallbackError.message}\n\n该 registry 未报告依赖所需的版本（${stale || '未知包'}）。`
          + `已尝试清缓存重试并回退官方源仍未成功，通常是镜像同步滞后，可稍后重试或在「设置 → 更新」中指定其他 registry。`,
        )
      }
    }
  })

  // Load the shipped web profile and its boot imports in a disposable home.
  // A version or file-existence check alone misses broken runtime imports.
  const probeHome = fs.mkdtempSync(path.join(runtimeDir, '.boot-check-'))
  try {
    const result = await runCommand({
      cmd: nodeBin,
      args: [path.join(runtimeDir, 'node_modules', NPM_PACKAGE, 'lib', 'bin.js'), ...BOOT_CHECK_ARGS],
      cwd: runtimeDir,
      env: { ...(env ?? process.env), DSH_HOME: probeHome },
      timeoutMs: BOOT_CHECK_TIMEOUT_MS,
      owner,
      shouldAbort,
    })
    assertArtifactBoot(result, spec)
  } finally {
    fs.rmSync(probeHome, { recursive: true, force: true })
  }
  return version
}

function assertArtifactBoot(result, spec) {
  if (result.aborted) {
    const error = new Error('官方产物启动校验已取消')
    error.code = 'CANCELLED'
    error.name = 'UpdateCancelledError'
    throw error
  }
  if (result.code === 0) return
  const detail = result.timedOut ? '检查超时' : (
    result.lines.find(line => /^(?:\w*Error(?: \[[A-Z_]+\])?|dsh):/iu.test(line.trim()))
    || result.lines.slice(-4).join('\n')
    || `退出码 ${result.code ?? result.signal}`
  )
  throw new Error(`${spec} 启动校验失败：${detail}`)
}

/**
 * Verify an installed npm-layout runtime and return its version token
 * (`npm:<version>`), or '' when the bin/manifest is missing.
 */
function verifyNpmArtifact(runtimeDir) {
  try {
    const bin = path.join(runtimeDir, 'node_modules', NPM_PACKAGE, 'lib', 'bin.js')
    if (!fs.existsSync(bin)) return ''
    return npmArtifactVersion(runtimeDir)
  } catch {
    return ''
  }
}

module.exports = {
  DEFAULT_REGISTRY,
  BOOT_CHECK_ARGS,
  BOOT_CHECK_TIMEOUT_MS,
  assertArtifactBoot,
  queryNpmArtifact,
  resolveArtifactNodeFloor,
  resolveChannelVersion,
  installNpmArtifact,
  npmInstallDirs,
  describeInstallFailure,
  verifyNpmArtifact,
  notargetPackage,
}
