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
}
