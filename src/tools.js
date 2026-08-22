'use strict'

/**
 * Tool discovery for the local machine — self-contained by design.
 *
 * An app launched from Finder inherits the minimal launchservices PATH, where
 * brew/nvm tools do not live, and a brew node may even violate the repo's
 * engine range (node ^22.19 || >=24). The shell therefore:
 *
 * - collects node candidates (manual path, PATH, login shell, nvm dirs, common
 *   brew dirs) and picks the first one whose real `node --version` satisfies
 *   the engine range, so a stale brew node never beats a compatible nvm node;
 * - collects pnpm candidates (manual, repo-local `.dsh-tools`, PATH, login
 *   shell, nvm/brew dirs, corepack beside node) and verifies each by actually
 *   running it under the clean child environment;
 * - exports `childEnv()`: a deterministic child environment whose PATH is
 *   node's dir + repo-local tool bins + repo node_modules/.bin + the system
 *   base — never the launchservices PATH. Shebang scripts like pnpm therefore
 *   always find their node.
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const BASE_SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

const COMMON_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/opt/homebrew/opt/node/bin',
  '/usr/local/opt/node/bin',
]

function executableAt(filePath) {
  if (typeof filePath !== 'string' || filePath === '' || !filePath.includes('/')) return ''
  try {
    fs.accessSync(filePath, fs.constants.X_OK)
    return filePath
  } catch {
    return ''
  }
}

function nvmBinDirs() {
  const home = process.env.HOME
  if (!home) return []
  const base = `${home}/.nvm/versions/node`
  try {
    if (!fs.statSync(base).isDirectory()) return []
    return fs.readdirSync(base).sort().reverse().map(version => `${base}/${version}/bin`)
  } catch {
    return []
  }
}

/**
 * Directories where pnpm is commonly installed. The shell's clean child PATH
 * intentionally does not inherit the launchservices PATH, so these are added
 * explicitly to make `pnpm` (and therefore `dsh plugin`) resolvable from
 * GUI-launched children.
 */
function pnpmPathDirs() {
  const home = process.env.HOME || ''
  const dirs = []
  const push = dir => {
    if (dir !== '' && !dirs.includes(dir)) dirs.push(dir)
  }
  if (process.env.PNPM_HOME) push(process.env.PNPM_HOME)
  if (home !== '') {
    push(path.join(home, '.local', 'share', 'pnpm'))
    push(path.join(home, '.local', 'bin'))
    push(path.join(home, '.npm-global', 'bin'))
    push(path.join(home, '.npm-packages', 'bin'))
    push(path.join(home, '.volta', 'bin'))
    push(path.join(home, '.asdf', 'shims'))
    push(path.join(home, '.nodenv', 'shims'))
    push(path.join(home, 'bin'))
  }
  if (process.env.APPDATA) push(path.join(process.env.APPDATA, 'npm'))
  if (process.env.LOCALAPPDATA) push(path.join(process.env.LOCALAPPDATA, 'pnpm'))
  for (const dir of COMMON_DIRS) push(dir)
  for (const dir of nvmBinDirs()) push(dir)
  return dirs
}

function findInDirs(name, dirs) {
  for (const dir of dirs) {
    const found = executableAt(`${dir}/${name}`)
    if (found !== '') return found
  }
  return ''
}

function firstPathLine(text) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('/')) return trimmed
  }
  return ''
}

function findOnPath(name) {
  const result = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { env: process.env, encoding: 'utf8', timeout: 10_000 })
  if (result.status !== 0 || !result.stdout) return ''
  return firstPathLine(result.stdout)
}

function findViaLoginShell(name, shellPath) {
  const shell = shellPath || '/bin/zsh'
  const result = spawnSync(shell, ['-l', '-c', `command -v ${name}`], { env: process.env, encoding: 'utf8', timeout: 15_000 })
  if (result.status !== 0 || !result.stdout) return ''
  return firstPathLine(result.stdout)
}

function resolveTool(name, manualPath, shellPath) {
  const manual = executableAt(manualPath)
  if (manual !== '') return manual
  const onPath = findOnPath(name)
  if (onPath !== '') return onPath
  const viaShell = findViaLoginShell(name, shellPath)
  if (viaShell !== '') return viaShell
  return findInDirs(name, COMMON_DIRS)
}

/** The repo's engine range: node ^22.19.0 || >=24. */
function engineOk(versionText) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(versionText).trim())
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major >= 24 || (major === 22 && minor >= 19)
}

function nodeCandidates(settings) {
  const toolPaths = settings.toolPaths ?? {}
  const repoDir = settings.local && typeof settings.local.repoDir === 'string' ? settings.local.repoDir : ''
  const candidates = []
  const push = value => {
    if (value !== '' && !candidates.includes(value)) candidates.push(value)
  }
  push(executableAt(toolPaths.node))
  if (repoDir !== '') push(executableAt(path.join(repoDir, '.dsh-tools', 'node', 'bin', 'node')))
  push(findOnPath('node'))
  push(findViaLoginShell('node', toolPaths.shell))
  for (const dir of nvmBinDirs()) push(executableAt(`${dir}/node`))
  for (const dir of COMMON_DIRS) push(executableAt(`${dir}/node`))
  return candidates
}

/** Pick the first node candidate whose real version satisfies the engine range. */
function pickNode(settings) {
  const candidates = nodeCandidates(settings)
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 10_000 })
    if (result.status === 0 && engineOk(result.stdout)) return candidate
  }
  return candidates.length > 0 ? candidates[0] : ''
}

function pnpmCandidates(settings, nodePath) {
  const toolPaths = settings.toolPaths ?? {}
  const repoDir = settings.local && typeof settings.local.repoDir === 'string' ? settings.local.repoDir : ''
  const candidates = []
  const push = value => {
    if (value !== '' && !candidates.includes(value)) candidates.push(value)
  }
  push(executableAt(toolPaths.pnpm))
  if (repoDir !== '') push(executableAt(path.join(repoDir, '.dsh-tools', 'node_modules', '.bin', 'pnpm')))
  push(findOnPath('pnpm'))
  push(findViaLoginShell('pnpm', toolPaths.shell))
  for (const dir of nvmBinDirs()) push(executableAt(`${dir}/pnpm`))
  for (const dir of COMMON_DIRS) push(executableAt(`${dir}/pnpm`))
  if (nodePath !== '') push(executableAt(path.join(path.dirname(nodePath), 'corepack')))
  return candidates
}

/**
 * The clean environment for all local children: deterministic and independent
 * of the launchservices PATH. Keeps the inherited environment (HOME, secrets)
 * but replaces PATH with node's dir, the repo's local tool bins, the repo's
 * node_modules/.bin, common pnpm install dirs, and the system base.
 */
function childEnv(settings, nodePath) {
  const repoDir = settings.local && typeof settings.local.repoDir === 'string' ? settings.local.repoDir : ''
  const parts = []
  if (nodePath !== '') parts.push(path.dirname(nodePath))
  if (repoDir !== '') {
    parts.push(path.join(repoDir, '.dsh-tools', 'node', 'bin'))
    parts.push(path.join(repoDir, '.dsh-tools', 'node_modules', '.bin'))
    parts.push(path.join(repoDir, 'node_modules', '.bin'))
  }
  parts.push(...pnpmPathDirs())
  parts.push(BASE_SYSTEM_PATH)
  return {
    ...process.env,
    PATH: parts.join(':'),
    // The repo's lefthook postinstall refuses to run when the user's global
    // core.hooksPath points elsewhere. The shell's git operations bypass
    // hooks entirely, so allowing the override keeps installs working without
    // changing the user's git configuration.
    DSH_LEFTHOOK_ALLOW_HOOKS_PATH_OVERRIDE: '1',
  }
}

/** Resolve the tools the shell needs; a missing tool is an empty string. */
function resolveTools(settings) {
  const toolPaths = settings.toolPaths ?? {}
  const node = pickNode(settings)
  const env = childEnv(settings, node)
  let pnpm = ''
  let pnpmPrefix = []
  for (const candidate of pnpmCandidates(settings, node)) {
    const isCorepack = candidate.endsWith('/corepack')
    const result = spawnSync(candidate, isCorepack ? ['pnpm', '--version'] : ['--version'], {
      env,
      encoding: 'utf8',
      timeout: 15_000,
    })
    if (result.status === 0) {
      pnpm = candidate
      if (isCorepack) pnpmPrefix = ['pnpm']
      break
    }
  }
  return {
    node,
    git: resolveTool('git', toolPaths.git, toolPaths.shell),
    pnpm,
    pnpmPrefix,
    ssh: resolveTool('ssh', '', toolPaths.shell) || '/usr/bin/ssh',
    env,
  }
}

module.exports = { resolveTools, childEnv, engineOk }
