'use strict'

const { compareVersions } = require('./components')

const DEFAULT_NODE_FLOOR = '24.9.0'
const PORTABLE_NODE_BUNDLED = '24.22.3'
const NODE_DIST_INDEX = 'https://nodejs.org/dist/index.json'
const CORE = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)'
const FLOOR_PATTERN = new RegExp(`^(?:(?:>=|\\^)\\s*)?v?(${CORE})$`)
const VERSION_PATTERN = new RegExp(`^v?(${CORE}(?:-[0-9A-Za-z.-]+)?)(?:\\+[0-9A-Za-z.-]+)?$`)

function parseNodeFloor(spec) {
  return FLOOR_PATTERN.exec(String(spec ?? '').trim())?.[1] ?? ''
}

function parseNodeVersion(version) {
  return VERSION_PATTERN.exec(String(version ?? '').trim())?.[1] ?? ''
}

function nodeVersionMeets(version, floor) {
  const actual = parseNodeVersion(version)
  const minimum = parseNodeFloor(floor)
  return actual !== '' && minimum !== '' && compareVersions(actual, minimum) >= 0
}

async function resolvePortableNodeVersion({ floor, fetchJson, indexUrl = NODE_DIST_INDEX, distFile }) {
  const minimum = parseNodeFloor(floor)
  if (minimum === '') throw new Error(`无法解析 Node.js 最低版本：${floor}`)
  let releases = []
  try {
    const index = await fetchJson(indexUrl, 10_000)
    if (Array.isArray(index)) releases = index
  } catch {
    // The tested download is still worth trying when only the index is unavailable.
  }
  const major = minimum.split('.')[0]
  let latestLts = ''
  let hasFloor = false
  for (const release of releases) {
    const version = parseNodeVersion(release?.version)
    if (!version.startsWith(`${major}.`) || version.includes('-') || !nodeVersionMeets(version, minimum)) continue
    if (distFile && (!Array.isArray(release.files) || !release.files.includes(distFile))) continue
    if (version === minimum) hasFloor = true
    if (typeof release.lts === 'string' && release.lts !== '' && compareVersions(version, latestLts) > 0) {
      latestLts = version
    }
  }
  if (latestLts !== '') return latestLts
  if (hasFloor) return minimum
  if (nodeVersionMeets(PORTABLE_NODE_BUNDLED, minimum)) return PORTABLE_NODE_BUNDLED
  throw new Error(`未能找到满足要求的 Node.js 发行版，内置兜底 v${PORTABLE_NODE_BUNDLED} 低于要求。`)
}

function nodeRequirementError({ floor, artifactVersion, currentVersion, targetVersion, detail, remote = false }) {
  const artifact = artifactVersion ? `产物 v${artifactVersion}` : '当前运行时'
  const current = currentVersion ? `v${currentVersion}` : '未检测到可运行版本'
  const target = targetVersion ? `，未能安装 v${targetVersion}` : ''
  const action = remote
    ? '请检查远端网络，或在远端 PATH 中提供兼容的 Node.js。'
    : '请检查网络，或在「设置 → 高级」中手动指定兼容的 Node.js 路径。'
  return `${artifact}要求 Node.js >=${floor}，当前便携版为 ${current}${target}。${detail ? ` ${detail} ` : ' '}${action}`
}

module.exports = {
  DEFAULT_NODE_FLOOR, PORTABLE_NODE_BUNDLED, parseNodeFloor, parseNodeVersion,
  nodeVersionMeets, resolvePortableNodeVersion, nodeRequirementError,
}
