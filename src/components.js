'use strict'

/**
 * Update-component definitions for the desktop shell.
 *
 * The catalog has ONE built-in component:
 *
 * - `harness` — the deepseek-harness source checkout itself
 *   (git pull --ff-only → pnpm install → build → restart).
 *
 * Plugin and preset update sources are NOT built in. They live in each
 * target device's own settings document (`update.components`), so a newly
 * connected remote device starts with the harness row only — the shell never
 * shows plugins the target does not have configured.
 *
 * On top of the harness row the user can add, edit, enable/disable, and
 * remove any number of device-scoped components of two safe kinds:
 *
 * - `npm`         — any npm bundle updated through the official
 *                   `dsh plugin --profile <profile> add <package>` command,
 * - `git-preset`  — any git repo whose `sourceDir` is mirrored into
 *                   `$DSH_HOME/.agent-presets/<presetId>`.
 *
 * The catalog stays a plain-data module so the settings store, the updater,
 * the menu, and the smoke test all share one source of truth. Device settings
 * override source locations and supply whole custom entries; the update
 * COMMANDS remain shell-owned, which is what keeps an update official.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')

/** Npm registry default: the public registry, overridable per component. */
const NPM_REGISTRY = 'https://registry.npmjs.org'

/** The always-present harness row; all other rows are device-scoped. */
const HARNESS = Object.freeze({
  id: 'harness',
  name: 'deepseek-harness',
  title: 'DeepSeek Harness',
  kind: 'harness',
  description: 'Harness 本体（git + pnpm install + build + 重启）',
  restart: true,
  builtin: true,
})

/** The fixed order for panels, menus, and "update all". */
const DEFAULT_COMPONENTS = Object.freeze([HARNESS])

const text = value => (typeof value === 'string' ? value.trim() : '')
const flag = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

/** Strip one pair of matching single/double quotes around a pasted command. */
function stripQuotes(value) {
  const cleaned = text(value)
  if (cleaned.length >= 2 && ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'")))) {
    return cleaned.slice(1, -1).trim()
  }
  return cleaned
}

/**
 * Extract the registry package name from a pnpm `add` spec when possible.
 * Supports `pkg`, `pkg@^1`, `@scope/pkg@latest`, and `npm:pkg@1`. Git/path/
 * tarball specs return '' and are never sent to the registry version check.
 */
function packageNameOfSpec(spec) {
  let value = stripQuotes(spec)
  if (value === '') return ''
  if (/^(github|gitlab|bitbucket):|^git\+[a-z]+:|^git@|^(file|link):|^(\.{1,2}[\\/])|^https?:\/\//.test(value)) return ''
  if (value.startsWith('/') || value.startsWith('~') || /\.git(?:#|$)/.test(value)) return ''
  if (value.startsWith('npm:')) value = value.slice(4)
  if (value.startsWith('@')) {
    const slash = value.indexOf('/')
    if (slash <= 1) return ''
    const scope = value.slice(0, slash)
    const rest = value.slice(slash + 1)
    const at = rest.indexOf('@')
    const name = at === -1 ? rest : rest.slice(0, at)
    return name === '' ? '' : `${scope}/${name}`
  }
  const at = value.indexOf('@')
  const name = at === -1 ? value : value.slice(0, at)
  return name === '' ? '' : name
}

/**
 * Classify a pnpm `add` spec. Everything `dsh plugin add <spec>` accepts is a
 * valid value; the kind only decides whether the shell can compare versions
 * against an npm registry or must fall back to "re-run the install".
 */
function pluginSpecKind(spec) {
  const value = stripQuotes(spec)
  if (value === '') return 'empty'
  if (/^(github|gitlab|bitbucket):/.test(value)) return 'git'
  if (/^git\+[a-z]+:/.test(value) || /^git@/.test(value)) return 'git'
  if (/\.git(?:#|$)/.test(value)) return 'git'
  if (/^(file|link):/.test(value) || /^(\.{1,2}[\\/])/.test(value) || value.startsWith('/') || value.startsWith('~')) return 'path'
  if (/^https?:\/\//.test(value)) return 'url'
  return 'registry'
}

/** Normalize a user-chosen component id: lowercase, spaces become dashes. */
function normalizeId(value, fallback) {
  const cleaned = text(value)
    .toLocaleLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '')
  return cleaned === '' ? fallback : cleaned
}

/**
 * Merge one persisted override onto a built-in catalog default. Unknown
 * fields are dropped and known fields are type-checked; a malformed override
 * degrades to the default rather than crashing the shell.
 * @param {object} def - catalog default.
 * @param {unknown} raw - persisted override.
 * @returns {object} normalized component definition.
 */
function normalizeComponent(def, raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    ...def,
    enabled: flag(source.enabled, def.enabled !== false),
    ...(typeof def.packageName === 'string' ? { packageName: text(source.packageName) || def.packageName } : {}),
    ...(typeof def.profile === 'string' ? { profile: text(source.profile) || def.profile } : {}),
    ...(typeof def.registryUrl === 'string' ? { registryUrl: text(source.registryUrl) || def.registryUrl } : {}),
    ...(typeof def.repoUrl === 'string' ? { repoUrl: text(source.repoUrl) || def.repoUrl } : {}),
    ...(typeof def.checkoutDir === 'string' ? { checkoutDir: text(source.checkoutDir) || def.checkoutDir } : {}),
    ...(typeof def.sourceDir === 'string' ? { sourceDir: text(source.sourceDir) || def.sourceDir } : {}),
    ...(typeof def.presetId === 'string' ? { presetId: text(source.presetId) || def.presetId } : {}),
  }
}

/**
 * Parse one user-defined component. Only the two shell-owned update kinds are
 * accepted; anything else (arbitrary commands, scripts) is dropped so the
 * settings document can never turn the shell into an arbitrary executor.
 * @param {unknown} raw - persisted user component.
 * @returns {object|null} normalized definition, or null when unusable.
 */
function normalizeUserComponent(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const kind = text(source.kind)
  const id = normalizeId(source.id, '')
  if (id === '' || (kind !== 'npm' && kind !== 'git-preset')) return null
  const repoUrl = text(source.repoUrl)
  const repoName = repoUrl.replace(/\/+$/, '').split('/').pop()?.replace(/\.git$/, '') || ''
  const npmSpec = kind === 'npm'
    ? stripQuotes(text(source.installSpec)) || stripQuotes(text(source.packageName)) || id
    : ''
  const npmName = kind === 'npm' ? text(source.packageName) || packageNameOfSpec(npmSpec) || id : ''
  const npmProfile = kind === 'npm' ? text(source.profile) || 'web' : 'web'
  const title = text(source.title)
    || (kind === 'npm' ? npmName : text(source.presetId) || repoName || id)

  const description = text(source.description) || (kind === 'npm'
    ? `npm 插件：dsh plugin --profile ${npmProfile} add ${npmSpec}`
    : `git 预设：同步 ${text(source.sourceDir) || 'preset'} 到 ~/.dsh/.agent-presets/${text(source.presetId) || id}`)
  const base = {
    id,
    name: id,
    title,
    kind,
    description,
    restart: true,
    enabled: flag(source.enabled, true),
    builtin: false,
  }
  if (kind === 'npm') {
    return {
      ...base,
      // `installSpec` is the exact value forwarded after `dsh plugin add`.
      // It accepts every pnpm add spec: npm name/range/tag, `npm:alias`,
      // `github:owner/repo`, `git+https://…`, `file:…`, a tarball, or `./dir`.
      installSpec: npmSpec,
      // `packageName` is the best-effort registry identity used for version
      // checks; git/path specs keep the component id so they can still be
      // re-installed/updated by re-running their spec.
      packageName: npmName,
      profile: npmProfile,
      registryUrl: text(source.registryUrl) || NPM_REGISTRY,
    }
  }
  return {
    ...base,
    repoUrl: text(source.repoUrl),
    checkoutDir: text(source.checkoutDir) || `~/OpenSoft/${id}`,
    sourceDir: text(source.sourceDir) || 'preset',
    presetId: text(source.presetId) || id,
  }
}

/**
 * Normalize the persisted `update.components` list: the harness row always
 * exists (overrides applied), and valid user-defined entries follow it in
 * stored order. Unknown ids, invalid kinds, and duplicates are dropped
 * instead of crashing the shell.
 * @param {unknown} raw - persisted component list.
 * @returns {object[]} normalized component list.
 */
function normalizeComponents(raw) {
  const source = Array.isArray(raw) ? raw : []
  const seen = new Set()
  const components = []
  for (const def of DEFAULT_COMPONENTS) {
    const override = source.find(entry => entry !== null && typeof entry === 'object' && entry.id === def.id)
    const normalized = normalizeComponent(def, override)
    components.push(normalized)
    seen.add(normalized.id)
  }
  for (const entry of source) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id : ''
    if (seen.has(id)) continue
    const normalized = normalizeUserComponent(entry)
    if (normalized === null) continue
    seen.add(normalized.id)
    components.push(normalized)
  }
  return components
}

/**
 * Normalize one persisted `update` section against its defaults.
 * @param {unknown} raw - persisted update section.
 * @returns {{autoCheckOnLaunch: boolean, lastCheckAt: string, lastNotifiedKey: string, components: object[]}}
 */
function normalizeUpdate(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const flag = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  const text = value => (typeof value === 'string' ? value : '')
  return {
    autoCheckOnLaunch: flag(source.autoCheckOnLaunch, true),
    lastCheckAt: text(source.lastCheckAt),
    lastNotifiedKey: text(source.lastNotifiedKey),
    components: normalizeComponents(source.components),
  }
}

/** Expand a leading `~/` against the user's home directory. */
function expandHome(dir) {
  if (dir === '~') return os.homedir()
  if (dir.startsWith('~/')) return path.join(os.homedir(), dir.slice(2))
  return dir
}

/**
 * Strip a dependency spec down to a comparable version triple. Supports the
 * spec forms the profile realistically contains (`0.12.1`, `^0.12.1`,
 * `~0.12.1`, `latest`, `link:…`). Returns '' when no version triple exists.
 * @param {string} spec - package.json version spec.
 * @returns {string} numeric version (`0.12.1`) or empty string.
 */
function versionOf(spec) {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(spec ?? ''))
  if (match === null) return ''
  return [match[1], match[2] ?? '0', match[3] ?? '0'].join('.')
}

/**
 * Compare two numeric versions. Prerelease tags sort below their release and
 * omitted segments equal zero, matching the small semver subset the shell
 * consumes. Returns -1 / 0 / 1.
 * @param {string} a - first version.
 * @param {string} b - second version.
 * @returns {number} comparison result.
 */
function compareVersions(a, b) {
  const left = String(a ?? '').trim()
  const right = String(b ?? '').trim()
  const leftParts = left.split('-')
  const rightParts = right.split('-')
  const leftNums = leftParts[0].split('.').map(Number)
  const rightNums = rightParts[0].split('.').map(Number)
  for (let index = 0; index < Math.max(leftNums.length, rightNums.length); index += 1) {
    const l = Number.isFinite(leftNums[index]) ? leftNums[index] : 0
    const r = Number.isFinite(rightNums[index]) ? rightNums[index] : 0
    if (l < r) return -1
    if (l > r) return 1
  }
  if (leftParts.length === 1 && rightParts.length === 1) return 0
  if (leftParts.length === 1) return 1
  if (rightParts.length === 1) return -1
  return leftParts[1] < rightParts[1] ? -1 : leftParts[1] > rightParts[1] ? 1 : 0
}

/** Whether `candidate` is a strictly newer numeric version than `installed`. */
function isNewerVersion(candidate, installed) {
  const c = versionOf(candidate)
  const i = versionOf(installed)
  if (c === '' || i === '') return false
  return compareVersions(c, i) > 0
}

/**
 * Recursively hash every file under a directory into one stable fingerprint.
 * Symlinks are not followed; empty directories contribute nothing.
 * @param {string} dir - directory to hash.
 * @returns {string} hex digest of `relativePath:sha256` rows, or '' when absent.
 */
function hashTreeSync(dir) {
  let root
  try {
    root = fs.statSync(dir)
  } catch {
    return ''
  }
  if (!root.isDirectory()) return ''
  const rows = []
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.DS_Store') continue
      const absolute = path.join(current, entry.name)
      const relative = path.relative(dir, absolute).split(path.sep).join('/')
      if (entry.isDirectory()) {
        walk(absolute)
        continue
      }
      if (!entry.isFile()) continue
      const digest = createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')
      rows.push(`${relative}:${digest}`)
    }
  }
  walk(dir)
  rows.sort()
  return createHash('sha256').update(rows.join('\n')).digest('hex')
}

/** A tiny JSON-safe component view the renderer and menus can read. */
function componentView(def) {
  return {
    id: def.id,
    name: def.name,
    title: def.title,
    kind: def.kind,
    description: def.description,
    enabled: def.enabled !== false,
    restart: def.restart === true,
    builtin: def.builtin === true,
    ...(typeof def.installSpec === 'string' ? { installSpec: def.installSpec } : {}),
    ...(typeof def.packageName === 'string' ? { packageName: def.packageName } : {}),
    ...(typeof def.profile === 'string' ? { profile: def.profile } : {}),
    ...(typeof def.registryUrl === 'string' ? { registryUrl: def.registryUrl } : {}),
    ...(typeof def.repoUrl === 'string' ? { repoUrl: def.repoUrl } : {}),
    ...(typeof def.checkoutDir === 'string' ? { checkoutDir: def.checkoutDir } : {}),
    ...(typeof def.sourceDir === 'string' ? { sourceDir: def.sourceDir } : {}),
    ...(typeof def.presetId === 'string' ? { presetId: def.presetId } : {}),
  }
}

module.exports = {
  DEFAULT_COMPONENTS,
  NPM_REGISTRY,
  compareVersions,
  componentView,
  expandHome,
  hashTreeSync,
  isNewerVersion,
  normalizeComponent,
  normalizeComponents,
  normalizeUpdate,
  normalizeUserComponent,
  packageNameOfSpec,
  pluginSpecKind,
  stripQuotes,
  versionOf,
}
