'use strict'

const semver = require('semver')

const DEFAULT_NODE_RANGE = '>=24.9.0'
const PORTABLE_NODE_BUNDLED = '24.22.3'
const NODE_DIST_INDEX = 'https://nodejs.org/dist/index.json'
// Match npm's engines check for a Node executable already on the machine.
const ENGINE_OPTIONS = { includePrerelease: true }

function normalizeNodeRange(spec) {
  const range = typeof spec === 'string' ? spec.trim() : ''
  return range !== '' && semver.validRange(range, ENGINE_OPTIONS) !== null ? range : ''
}

function parseNodeVersion(version) {
  return semver.valid(String(version ?? '').trim()) ?? ''
}

function nodeVersionMeets(version, nodeRange) {
  const actual = parseNodeVersion(version)
  return actual !== '' && nodeRange !== '' && semver.satisfies(actual, nodeRange, ENGINE_OPTIONS)
}

async function resolvePortableNodeVersion({ nodeRange, fetchJson, indexUrl = NODE_DIST_INDEX, distFile }) {
  const range = normalizeNodeRange(nodeRange)
  if (range === '') throw new Error(`无法解析 Node.js 版本要求：${nodeRange}`)
  let releases = []
  try {
    const index = await fetchJson(indexUrl, 10_000)
    if (Array.isArray(index)) releases = index
  } catch {
    // The tested download is still worth trying when only the index is unavailable.
  }
  const compatible = releases
    .filter(release => !distFile || (Array.isArray(release?.files) && release.files.includes(distFile)))
    .map(release => ({ version: parseNodeVersion(release?.version), lts: typeof release?.lts === 'string' && release.lts !== '' }))
    .filter(({ version }) => !version.includes('-') && nodeVersionMeets(version, range))
    .sort((left, right) => semver.rcompare(left.version, right.version))
  // The machine has no usable Node.js, so the portable build is what it runs
  // everything with: take the newest release the artifact accepts rather than
  // the artifact's floor. Without an index (offline) the tested fallback wins.
  const preferred = compatible.find(release => release.lts) ?? compatible[0]
  if (preferred) return preferred.version
  if (nodeVersionMeets(PORTABLE_NODE_BUNDLED, range)) return PORTABLE_NODE_BUNDLED
  throw new Error(`未能找到满足要求的 Node.js 发行版，内置兜底 v${PORTABLE_NODE_BUNDLED} 不符合要求。`)
}

function nodeRequirementError({ nodeRange, artifactVersion, currentVersion, targetVersion, detail, remote = false }) {
  const artifact = artifactVersion ? `产物 v${artifactVersion}` : '当前运行时'
  const current = currentVersion ? `v${currentVersion}` : '未检测到可运行版本'
  const target = targetVersion ? `，未能安装 v${targetVersion}` : ''
  const action = remote
    ? '请检查远端网络，或在远端 PATH 中提供兼容的 Node.js。'
    : '请检查网络，或在「设置 → 高级」中手动指定兼容的 Node.js 路径。'
  return `${artifact}要求 Node.js ${nodeRange}，当前便携版为 ${current}${target}。${detail ? ` ${detail} ` : ' '}${action}`
}

module.exports = {
  DEFAULT_NODE_RANGE, PORTABLE_NODE_BUNDLED, normalizeNodeRange, parseNodeVersion,
  nodeVersionMeets, resolvePortableNodeVersion, nodeRequirementError,
}
