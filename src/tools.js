'use strict'

/**
 * Tool discovery for the local machine — self-contained by design.
 *
 * An app launched from Finder inherits the minimal launchservices PATH, where
 * brew/nvm tools do not live, and a brew node may even violate the repo's
 * engine range (node ^22.19 || >=24). Windows has its own variant of the same
 * problem: a shortcut launch inherits the Explorer PATH, where nvm-windows,
 * fnm, volta and a per-user npm prefix are frequently absent. The shell
 * therefore:
 *
 * - collects node candidates (manual path, PATH, login shell, nvm dirs, common
 *   install dirs per OS) and picks the first one whose real `node --version`
 *   satisfies the engine range, so a stale node never beats a compatible one;
 * - collects pnpm candidates (manual, repo-local `.dsh-tools`, PATH, login
 *   shell, nvm/brew dirs, corepack beside node) and verifies each by actually
 *   running it under the clean child environment;
 * - exports `childEnv()`: a deterministic child environment whose PATH is
 *   node's dir + repo-local tool bins + repo node_modules/.bin + the system
 *   base — never the inherited launch PATH. Shebang scripts like pnpm
 *   therefore always find their node.
 *
 * Platform differences live in `platform.js` (executable names, PATH
 * separator, system dirs); this module only decides WHICH candidates to try.
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  IS_WINDOWS, PATH_KEY, SYSTEM_PATH_DIRS, findExecutableIn, findExecutableInDirs,
  isExecutable, joinPath, spawnInvocation, splitPath,
} = require('./platform')

const COMMON_DIRS = IS_WINDOWS
  ? [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs'),
      process.env.ProgramData ? path.join(process.env.ProgramData, 'chocolatey', 'bin') : '',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs') : '',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Volta', 'bin') : '',
      process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'pnpm') : '',
      process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'scoop', 'shims') : '',
      ...SYSTEM_PATH_DIRS,
    ].filter(Boolean)
  : [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/opt/homebrew/opt/node/bin',
      '/usr/local/opt/node/bin',
    ]

function executableAt(filePath) {
  return isExecutable(filePath) ? filePath : ''
}

/** Node version-manager bin dirs: nvm/nvm-windows, fnm, asdf, nodenv. */
function nvmBinDirs() {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (home === '') return []
  const dirs = []
  if (IS_WINDOWS) {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    // nvm-windows installs each version as `%NVM_HOME%\v22.19.0\node.exe`
    // (the executable sits directly in the version dir, not in `bin`).
    const nvmHome = process.env.NVM_HOME || path.join(appData, 'nvm')
    try {
      if (fs.statSync(nvmHome).isDirectory()) {
        for (const entry of fs.readdirSync(nvmHome).sort().reverse()) {
          const dir = path.join(nvmHome, entry)
          try {
            if (fs.statSync(dir).isDirectory()) dirs.push(dir)
          } catch {
            // Unreadable version dir.
          }
        }
      }
    } catch {
      // No nvm-windows.
    }
    // fnm keeps multiline version dirs in %FNM_DIR% (or %APPDATA%\fnm).
    const fnmDir = process.env.FNM_DIR || path.join(appData, 'fnm')
    try {
      for (const entry of fs.readdirSync(path.join(fnmDir, 'node-versions')).sort().reverse()) {
        dirs.push(path.join(fnmDir, 'node-versions', entry, 'installation'))
      }
    } catch {
      // No fnm.
    }
    dirs.push(path.join(appData, 'npm'))
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    dirs.push(path.join(local, 'Volta', 'bin'))
    dirs.push(path.join(local, 'Programs', 'nodejs'))
    dirs.push(path.join(local, 'pnpm'))
    return dirs
  }
  const base = path.join(home, '.nvm', 'versions', 'node')
  try {
    if (!fs.statSync(base).isDirectory()) return []
    return fs.readdirSync(base).sort().reverse().map(version => path.join(base, version, 'bin'))
  } catch {
    return []
  }
}

/**
 * Directories where pnpm is commonly installed. The shell's clean child PATH
 * intentionally does not inherit the launch PATH, so these are added
 * explicitly to make `pnpm` (and therefore `dsh plugin`) resolvable from
 * GUI-launched children.
 */
function pnpmPathDirs() {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const dirs = []
  const push = dir => {
    if (dir !== '' && dir !== undefined && dir !== null && !dirs.includes(dir)) dirs.push(dir)
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

const findInDirs = (name, dirs) => findExecutableInDirs(name, dirs)

function firstPathLine(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    // Windows absolute paths start with a drive letter (`C:\\…`).
    if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) return trimmed
  }
  return ''
}

/**
 * Resolve one tool on the inherited PATH.
 *
 * POSIX: `command -v`, one answer.
 *
 * Windows: `where`, which for npm-installed tools lists SEVERAL shims for the
 * same command — `pnpm`, `pnpm.cmd`, `pnpm.ps1` — and puts the extension-less
 * one FIRST. That extension-less `pnpm` is a POSIX shell script (npm writes it
 * for Git Bash); node cannot execute it, so taking the first line blindly makes
 * every probe of pnpm report "not resolved" on a machine where
 * `pnpm --version` works fine in a terminal. Reproduced on Windows 11 ARM64:
 * `where pnpm` → `C:\...\pnpm` first, `pnpm --version` → 11.28.8.
 *
 * So on Windows the lines are re-ranked by `executableNames()` preference
 * (.exe → .cmd → .bat → bare) instead of trusting `where`'s order.
 * @param {string} name
 * @returns {string} absolute path, or '' when nothing runnable was found.
 */
function findOnPath(name) {
  if (IS_WINDOWS) {
    const result = spawnSync('where', [name], {
      env: process.env,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    })
    if (result.status !== 0 || !result.stdout) return ''
    return bestWindowsPath(String(result.stdout).split(/\r?\n/))
  }
  const result = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { env: process.env, encoding: 'utf8', timeout: 10_000 })
  if (result.status !== 0 || !result.stdout) return ''
  return firstPathLine(result.stdout)
}

/**
 * Pick the most runnable entry out of `where`-style output.
 *
 * Preference is by extension, then by the order the OS listed them, so a tool
 * that only ships one shim still resolves. Extension-less entries are LAST
 * because on Windows they are usually POSIX shell scripts (npm/pnpm write one
 * for Git Bash) that node cannot exec.
 * @param {string[]} lines
 * @returns {string}
 */
function bestWindowsPath(lines) {
  const candidates = lines
    .map(line => line.trim())
    .filter(line => line !== '' && (/^[A-Za-z]:[\\/]/.test(line) || line.startsWith('\\')))
  if (candidates.length === 0) return ''
  const rank = file => {
    const lower = file.toLowerCase()
    if (lower.endsWith('.exe')) return 0
    if (lower.endsWith('.cmd')) return 1
    if (lower.endsWith('.bat')) return 2
    // No recognised extension: a shell/com script node cannot run directly.
    return 3
  }
  let best = candidates[0]
  for (const candidate of candidates.slice(1)) {
    if (rank(candidate) < rank(best)) best = candidate
  }
  return best
}

function defaultLoginShell() {
  if (IS_WINDOWS) return process.env.ComSpec || 'cmd.exe'
  return '/bin/zsh'
}

/**
 * Resolve one tool through the user's login shell. On Windows a `-l -c`
 * convention does not exist, so PowerShell is asked for its own resolved
 * command path instead: a shortcut launch still gets `%LOCALAPPDATA%`-style
 * per-user installs that Explorer's PATH may omit.
 */
function findViaLoginShell(name, shellPath) {
  if (IS_WINDOWS) return findViaPowerShell(name)
  const shell = shellPath || defaultLoginShell()
  const result = spawnSync(shell, ['-l', '-c', `command -v ${name}`], { env: process.env, encoding: 'utf8', timeout: 15_000 })
  if (result.status !== 0 || !result.stdout) return ''
  return firstPathLine(result.stdout)
}

function findViaPowerShell(name) {
  const script = `$c = Get-Command -Name '${name}' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $c.Source }`
  for (const exe of ['powershell.exe', 'pwsh.exe']) {
    const result = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: process.env,
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    })
    if (result.status !== 0 || !result.stdout) continue
    const found = firstPathLine(result.stdout)
    if (found !== '') return found
  }
  return ''
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
    if (value !== '' && value !== undefined && !candidates.includes(value)) candidates.push(value)
  }
  push(executableAt(toolPaths.node))
  // The repo-local portable node, in the layout each OS installs it into:
  // `node/bin/node` from the POSIX tarball, `node/node.exe` from the Windows
  // zip (its extracted root IS the node dir).
  if (repoDir !== '') push(findExecutableIn(path.join(repoDir, '.dsh-tools', 'node', 'bin'), 'node'))
  if (repoDir !== '') push(findExecutableIn(path.join(repoDir, '.dsh-tools', 'node'), 'node'))
  push(findOnPath('node'))
  push(findViaLoginShell('node', toolPaths.shell))
  for (const dir of nvmBinDirs()) push(findExecutableIn(dir, 'node'))
  for (const dir of COMMON_DIRS) push(findExecutableIn(dir, 'node'))
  return candidates
}

/** Pick the first node candidate whose real version satisfies the engine range. */
function pickNode(settings) {
  const candidates = nodeCandidates(settings)
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
    if (result.status === 0 && engineOk(result.stdout)) return candidate
  }
  return candidates.length > 0 ? candidates[0] : ''
}

function pnpmCandidates(settings, nodePath) {
  const toolPaths = settings.toolPaths ?? {}
  const repoDir = settings.local && typeof settings.local.repoDir === 'string' ? settings.local.repoDir : ''
  const candidates = []
  const push = value => {
    if (value !== '' && value !== undefined && !candidates.includes(value)) candidates.push(value)
  }
  push(executableAt(toolPaths.pnpm))
  if (repoDir !== '') push(findExecutableIn(path.join(repoDir, '.dsh-tools', 'node_modules', '.bin'), 'pnpm'))
  push(findOnPath('pnpm'))
  push(findViaLoginShell('pnpm', toolPaths.shell))
  for (const dir of nvmBinDirs()) push(findExecutableIn(dir, 'pnpm'))
  for (const dir of COMMON_DIRS) push(findExecutableIn(dir, 'pnpm'))
  if (nodePath !== '') push(findExecutableIn(path.dirname(nodePath), 'corepack'))
  return candidates
}

/**
 * The clean environment for all local children: deterministic and independent
 * of the inherited launch PATH. Keeps the inherited environment (HOME, secrets)
 * but replaces the PATH entry with node's dir, the repo's local tool bins, the
 * repo's node_modules/.bin, common pnpm install dirs, and the system base.
 *
 * The PATH key itself is platform-specific: Windows spells it `Path` and is
 * case-insensitive, so writing `PATH` there can leave two competing entries.
 */
function childEnv(settings, nodePath) {
  const repoDir = settings.local && typeof settings.local.repoDir === 'string' ? settings.local.repoDir : ''
  const parts = []
  if (nodePath !== '') parts.push(path.dirname(nodePath))
  if (repoDir !== '') {
    parts.push(path.join(repoDir, '.dsh-tools', 'node', 'bin'))
    parts.push(path.join(repoDir, '.dsh-tools', 'node'))
    parts.push(path.join(repoDir, '.dsh-tools', 'node_modules', '.bin'))
    parts.push(path.join(repoDir, 'node_modules', '.bin'))
  }
  parts.push(...pnpmPathDirs())
  parts.push(...SYSTEM_PATH_DIRS)
  const env = {
    ...process.env,
    // The repo's lefthook postinstall refuses to run when the user's global
    // core.hooksPath points elsewhere. The shell's git operations bypass
    // hooks entirely, so allowing the override keeps installs working without
    // changing the user's git configuration.
    DSH_LEFTHOOK_ALLOW_HOOKS_PATH_OVERRIDE: '1',
    // npm/pnpm shims are .cmd files on Windows; spawning them from node needs
    // a shell, and the shim itself resolves its node through PATH.
    ...(IS_WINDOWS ? { PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD' } : {}),
  }
  env[PATH_KEY] = joinPath(parts)
  if (IS_WINDOWS) {
    // Keep both spellings in sync: node's own resolver and third-party tools
    // read `PATH`, while cmd.exe reads `Path`. Divergence is silent and bad.
    env.PATH = env[PATH_KEY]
  }
  return env
}

/** Resolve the tools the shell needs; a missing tool is an empty string. */
function resolveTools(settings) {
  const toolPaths = settings.toolPaths ?? {}
  const node = pickNode(settings)
  const env = childEnv(settings, node)
  let pnpm = ''
  let pnpmPrefix = []
  for (const candidate of pnpmCandidates(settings, node)) {
    const base = path.basename(candidate).toLowerCase()
    const isCorepack = base === 'corepack' || base === 'corepack.exe' || base === 'corepack.cmd'
    // pnpm on Windows is a .cmd shim, which node cannot exec directly. Route
    // it through cmd.exe with a properly quoted line (`shell: true` would let
    // node re-quote and mangle a "Program Files" path).
    const invocation = spawnInvocation(candidate, isCorepack ? ['pnpm', '--version'] : ['--version'])
    const result = spawnSync(invocation.cmd, invocation.args, {
      env,
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      ...invocation.options,
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
    ssh: resolveTool('ssh', '', toolPaths.shell) || (IS_WINDOWS ? 'ssh.exe' : '/usr/bin/ssh'),
    env,
  }
}

module.exports = {
  resolveTools, childEnv, engineOk, defaultLoginShell, nvmBinDirs, bestWindowsPath,
}
