'use strict'

/**
 * Update-component definitions for the desktop shell.
 *
 * The catalog has ONE built-in component:
 *
 * - `harness` — the deepseek-harness runtime itself
 *   (official npm artifact → atomic switch → restart).
 *
 * Only the built-in Harness runtime is supported.
 */

/** The always-present harness row. */
const HARNESS = Object.freeze({
  id: 'harness',
  name: 'deepseek-harness',
  title: 'DeepSeek Harness',
  kind: 'harness',
  description: 'Harness 本体（官方产物检查与更新）',
  restart: true,
  builtin: true,
})

/** The fixed order for panels, menus, and "update all". */
const DEFAULT_COMPONENTS = Object.freeze([HARNESS])

/**
 * There is no user-selectable channel. The shell always tracks the NEWEST
 * published release across every dist-tag the registry declares — see
 * `resolveChannelVersion` in `artifact.js`. A channel is therefore only ever
 * a report of which tag won, never a persisted user preference.
 *
 * The registry is authoritative for which tags exist. `alpha` was invisible
 * for as long as the shell only ever read `dist-tags.latest`, so a published
 * `0.1.2-alpha.3` never surfaced while `latest` sat at `0.1.1-rc.2`.
 */

const text = value => (typeof value === 'string' ? value.trim() : '')
const flag = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

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
  }
}

/**
 * Normalize the persisted `update.components` list: only the built-in
 * Harness row is kept. User-defined entries are intentionally dropped.
 * @param {unknown} raw - persisted component list.
 * @returns {object[]} normalized component list.
 */
function normalizeComponents(raw) {
  const source = Array.isArray(raw) ? raw : []
  const components = []
  for (const def of DEFAULT_COMPONENTS) {
    const override = source.find(entry => entry !== null && typeof entry === 'object' && entry.id === def.id)
    const normalized = normalizeComponent(def, override)
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
 * Compare two dot-separated prerelease identifiers by semver precedence:
 * numeric identifiers compare numerically and rank BELOW alphanumeric ones,
 * alphanumeric ones compare lexically, and a shorter identifier list sorts
 * first when every shared identifier is equal. Returns -1 / 0 / 1.
 *
 * Numeric comparison is what makes `alpha.10` sort above `alpha.9` — a plain
 * string compare would rank it below, hiding the newest alpha.
 * @param {string} a - first prerelease tail (without the leading `-`).
 * @param {string} b - second prerelease tail.
 * @returns {number} comparison result.
 */
function comparePrerelease(a, b) {
  const left = String(a).split('.')
  const right = String(b).split('.')
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = left[index]
    const r = right[index]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const lNumeric = /^\d+$/.test(l)
    const rNumeric = /^\d+$/.test(r)
    if (lNumeric && rNumeric) {
      if (Number(l) !== Number(r)) return Number(l) < Number(r) ? -1 : 1
      continue
    }
    // A numeric identifier always has LOWER precedence than an alphanumeric one.
    if (lNumeric) return -1
    if (rNumeric) return 1
    if (l < r) return -1
    if (l > r) return 1
  }
  return 0
}

/**
 * Compare two versions. Prerelease tags sort below their release and omitted
 * segments equal zero, matching the small semver subset the shell consumes.
 * Returns -1 / 0 / 1.
 * @param {string} a - first version.
 * @param {string} b - second version.
 * @returns {number} comparison result.
 */
function compareVersions(a, b) {
  const left = String(a ?? '').trim()
  const right = String(b ?? '').trim()
  const leftSplit = left.indexOf('-')
  const rightSplit = right.indexOf('-')
  const leftCore = leftSplit === -1 ? left : left.slice(0, leftSplit)
  const rightCore = rightSplit === -1 ? right : right.slice(0, rightSplit)
  const leftNums = leftCore.split('.').map(Number)
  const rightNums = rightCore.split('.').map(Number)
  for (let index = 0; index < Math.max(leftNums.length, rightNums.length); index += 1) {
    const l = Number.isFinite(leftNums[index]) ? leftNums[index] : 0
    const r = Number.isFinite(rightNums[index]) ? rightNums[index] : 0
    if (l < r) return -1
    if (l > r) return 1
  }
  // A release outranks any of its prereleases.
  if (leftSplit === -1 && rightSplit === -1) return 0
  if (leftSplit === -1) return 1
  if (rightSplit === -1) return -1
  return comparePrerelease(left.slice(leftSplit + 1), right.slice(rightSplit + 1))
}

/**
 * Strip a version token down to a prerelease-preserving comparable form
 * (`v0.1.2-alpha.3` → `0.1.2-alpha.3`, `^0.12.1` → `0.12.1`). Returns '' when
 * the input carries no version at all.
 *
 * The prerelease tail is KEPT on purpose: two alphas of one core version
 * (`0.1.2-alpha.1` → `0.1.2-alpha.3`) differ only there, so dropping it would
 * report the newer alpha as already installed.
 * @param {string} spec - version, spec, or dist-tag.
 * @returns {string} comparable version token or empty string.
 */
function versionToken(spec) {
  const match = /v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(String(spec ?? '').trim())
  if (match === null) return ''
  const core = [match[1], match[2] ?? '0', match[3] ?? '0'].join('.')
  return match[4] === undefined ? core : `${core}-${match[4]}`
}

/** Whether `candidate` is a strictly newer version than `installed`. */
function isNewerVersion(candidate, installed) {
  const c = versionToken(candidate)
  const i = versionToken(installed)
  if (c === '' || i === '') return false
  return compareVersions(c, i) > 0
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
  }
}

module.exports = {
  DEFAULT_COMPONENTS,
  compareVersions,
  componentView,
  isNewerVersion,
  normalizeComponent,
  normalizeComponents,
  normalizeUpdate,
  versionOf,
  versionToken,
}
