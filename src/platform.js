'use strict'

/**
 * Platform primitives — the ONE place that knows the shell runs on more than
 * one OS.
 *
 * The shell was written against POSIX: process GROUPS are signalled with
 * `process.kill(-pid)`, service discovery shells out to `lsof`/`ps`, the
 * parent watchdog is a `sh` script, the portable node download is a
 * `tar.gz`, and the runtime's `current` pointer is a symlink. Windows has a
 * different primitive for every one of those, and a silent mismatch in any of
 * them leaves an orphaned service or an unstartable runtime. So each one is
 * expressed here exactly once, and every call site goes through it.
 *
 * Windows equivalents used below:
 *
 * | POSIX                      | Windows                                   |
 * |----------------------------|-------------------------------------------|
 * | `kill(-pgid, …)`            | `taskkill /PID … /T /F` (walks the tree)   |
 * | `sh -c` parent watchdog     | `service-guard.js` (node, parent poll)    |
 * | `lsof -iTCP -sTCP:LISTEN`    | `netstat -ano -p TCP` → LISTENING rows     |
 * | `ps ax -o pid=,command=`     | `Get-CimInstance Win32_Process`           |
 * | symlink `current`            | directory junction (`fs.symlinkSync(…,``'junction'`)`) |
 * | node `*.tar.gz`              | node `*.zip` (Expand-Archive)              |
 * | `node`, `pnpm`, `ssh`, `git` | `node.exe`, `pnpm.cmd`, `ssh.exe`, `git.exe` |
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const IS_WINDOWS = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'
const IS_LINUX = process.platform === 'linux'

/** PATH separator and the env key holding it — case-insensitive on Windows. */
const PATH_DELIMITER = IS_WINDOWS ? ';' : ':'
const PATH_KEY = IS_WINDOWS ? 'Path' : 'PATH'

/** The system directories every child gets, independent of the launch PATH. */
const SYSTEM_PATH_DIRS = IS_WINDOWS
  ? [
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH'),
      process.env.SystemRoot || 'C:\\Windows',
      process.env.ProgramFiles || 'C:\\Program Files',
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs'),
      process.env.ProgramData || 'C:\\ProgramData',
    ]
  : ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

/** Join a PATH-like list with the platform separator. */
function joinPath(list) {
  return list.filter(entry => entry !== '' && entry !== undefined && entry !== null).join(PATH_DELIMITER)
}

/** Split a PATH-like string with the platform separator. */
function splitPath(value) {
  return String(value ?? '').split(PATH_DELIMITER).filter(entry => entry !== '')
}

/**
 * Candidate file names for an executable. Windows tools are `node.exe` and
 * `pnpm.cmd`; POSIX tools are bare names. Order matters: the real executable
 * beats a shell shim, so `.`-less names are not tried first on Windows.
 */
function executableNames(name) {
  const base = path.basename(String(name))
  if (!IS_WINDOWS) return [String(name)]
  const ext = path.extname(base).toLowerCase()
  if (ext === '.exe' || ext === '.cmd' || ext === '.bat' || ext === '.ps1') return [String(name)]
  return [`${base}.exe`, `${base}.cmd`, `${base}.bat`, base]
}

/** Whether a path exists and is executable for this OS. */
function isExecutable(filePath) {
  if (typeof filePath !== 'string' || filePath === '') return false
  if (!filePath.includes(path.sep) && !filePath.includes('/')) return false
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return false
    if (IS_WINDOWS) return true
    fs.accessSync(filePath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolve `name` inside `dir` for this OS, or '' when it is not there. */
function findExecutableIn(dir, name) {
  if (typeof dir !== 'string' || dir === '') return ''
  for (const candidate of executableNames(name)) {
    const full = path.join(dir, candidate)
    if (isExecutable(full)) return full
  }
  return ''
}

/** First executable match for `name` across `dirs` (in order). */
function findExecutableInDirs(name, dirs) {
  for (const dir of dirs) {
    const found = findExecutableIn(dir, name)
    if (found !== '') return found
  }
  return ''
}

/** Expand a leading `~` against the user's home directory. */
function expandHome(dir) {
  if (typeof dir !== 'string') return ''
  if (dir === '~') return os.homedir()
  if (dir.startsWith('~/') || (IS_WINDOWS && dir.startsWith('~\\'))) {
    return path.join(os.homedir(), dir.slice(2))
  }
  return dir
}

/**
 * Terminate a process AND its children.
 *
 * POSIX: the caller's children are spawned detached, so the pid is a process
 * GROUP id and `process.kill(-pid)` reaches the whole tree (a bare SIGKILL to
 * the leader leaves pnpm/git grandchildren running).
 *
 * Windows: no negative-pid semantics exist; `taskkill /T /F` walks the child
 * tree instead. Windows has no graceful console signal, so `/F` is always
 * used — a half-graceful kill is worse than a deterministic one.
 *
 * @param {number} pid - process (group leader) id.
 * @param {string} [signal] - POSIX signal; ignored on Windows.
 * @returns {boolean} whether a kill was issued.
 */
function killTree(pid, signal = 'SIGTERM') {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (IS_WINDOWS) return taskkill(pid)
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    // No such group (or not a group leader): fall back to the single pid.
  }
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

/**
 * `taskkill /T /F` one pid and its descendants. Windows only, no-throw.
 *
 * Exit codes matter here, because the boolean is a KILL DECISION the sweep
 * counts (and logs) — measured on Windows 11 ARM64:
 *
 *  - `0`   : terminated (or already terminating) — a real kill.
 *  - `128` : "no process found with the given PID" — the pid is ALREADY GONE,
 *            which is exactly `killTree`'s `false` contract, not a success.
 *            Reporting it as a kill made the sweep count phantom kills.
 *  - other : access denied and the like; also not a kill.
 * @param {number} pid
 * @returns {boolean} whether a process was actually terminated.
 */
function taskkill(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 10_000,
    })
    return result.status === 0
  } catch {
    return false
  }
}

/**
 * Terminate the tree behind a ChildProcess handle. Prefers the tree kill and
 * degrades to `child.kill()` when the pid is already gone.
 */
function killTreeOf(child, signal = 'SIGTERM') {
  if (child === null || child === undefined) return false
  const pid = child.pid
  if (Number.isInteger(pid) && pid > 0 && killTree(pid, signal)) return true
  try {
    child.kill(signal)
    return true
  } catch {
    return false
  }
}

/** Whether a PID is alive (signal-0 style probe; no signalling). */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means "alive but not ours", which still counts as alive.
    return error.code === 'EPERM'
  }
}

/**
 * Options every child spawn shares. `detached` puts the child in its own
 * process group on POSIX (so a group kill reaches grandchildren); on Windows
 * it is OPTIONAL because a detached child of a console-less parent loses its
 * inherited stdout — see `runner.runCommand`. `windowsHide` keeps a console
 * window from flashing for every git/npm call.
 */
function spawnOptions({ detached = true } = {}) {
  if (IS_WINDOWS) return { detached, windowsHide: true }
  return { detached }
}

/**
 * Whether a command must go through the Windows command interpreter.
 *
 * npm and pnpm are `.cmd` batch SHIMS on Windows, not executables, and node
 * cannot exec a batch file directly (`spawn('npm.cmd')` throws EINVAL). They
 * have to be launched as `cmd.exe /d /s /c "…"`.
 * @param {string} cmd
 * @returns {boolean}
 */
function needsShell(cmd) {
  return IS_WINDOWS && /\.(cmd|bat)$/i.test(String(cmd))
}

/**
 * Quote ONE argument for a `cmd.exe /c` command line.
 *
 * This is not POSIX quoting: cmd.exe has its own rules, and the argument is
 * parsed TWICE (once by cmd.exe, once by the batch shim's target program).
 * The safe subset used here:
 *
 *  - wrap in double quotes when the value has whitespace or any cmd
 *    metacharacter (`& | < > ^ ( ) "`), which neutralises all of them at once;
 *  - double an embedded `"` (the batch convention for a literal quote).
 *
 * `windowsVerbatimArguments` is what makes this necessary and sufficient: it
 * hands the string to cmd.exe untouched instead of letting node re-quote.
 * @param {string} value
 * @returns {string}
 */
function cmdQuote(value) {
  const text = String(value)
  if (text === '') return '""'
  // Inside double quotes cmd.exe treats & | < > ( ) as literals, so the quote
  // path needs no caret escaping — only an embedded `"` has to be doubled.
  //
  // %VAR% expansion still happens inside quotes; that is the documented batch
  // behaviour and is deliberately left alone.
  if (/[\s&|<>^()"]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

/**
 * Turn `(cmd, args)` into something `child_process.spawn` can actually run on
 * this platform, for both plain executables and Windows batch shims.
 *
 * Callers do:
 * ```js
 * const invocation = spawnInvocation(cmd, args)
 * spawn(invocation.cmd, invocation.args, { ...spawnOptions(), ...invocation.options })
 * ```
 * @param {string} cmd
 * @param {string[]} [args]
 * @returns {{cmd: string, args: string[], options: object}}
 */
function spawnInvocation(cmd, args = []) {
  if (!needsShell(cmd)) return { cmd, args, options: {} }
  // ComSpec is the interpreter Windows itself would use. Fall back to the
  // canonical absolute location rather than a bare name, so a stripped-down
  // environment still launches an interpreter instead of a PATH lookup.
  const comspec = process.env.ComSpec
    || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
  const line = [cmdQuote(cmd), ...args.map(cmdQuote)].join(' ')
  return {
    cmd: comspec,
    args: ['/d', '/s', '/c', line],
    // The command line is already quoted for cmd.exe; do not let node touch it.
    options: { windowsVerbatimArguments: true },
  }
}

/** Where the ssh client keeps its config, per platform. */
function sshConfigPath() {
  return path.join(os.homedir(), '.ssh', 'config')
}

/**
 * The npm launcher that ships with a node installation.
 * POSIX: `<node dir>/npm`; Windows: `<node dir>/npm.cmd`.
 *
 * Existence, not the executable bit: an npm that EXISTS but lost its mode is a
 * broken install whose real failure ("permission denied") is far more useful
 * to the user than "no npm beside node". Callers surface the path in errors.
 */
function npmFor(nodePath) {
  const dir = path.dirname(String(nodePath ?? ''))
  if (dir === '.' || dir === '') return ''
  return findFileIn(dir, 'npm')
}

/** Resolve `name` inside `dir` as a regular FILE (no executable-bit check). */
function findFileIn(dir, name) {
  if (typeof dir !== 'string' || dir === '') return ''
  for (const candidate of executableNames(name)) {
    const full = path.join(dir, candidate)
    try {
      if (fs.statSync(full).isFile()) return full
    } catch {
      // Try the next name variant.
    }
  }
  return ''
}

/** The node distribution archive for one version + arch. */
function nodeDistArchive(version, arch = process.arch, target = {}) {
  // The archive KIND is a property of the TARGET OS, not of the host running
  // this code: a Windows installer may be produced on a macOS runner, and the
  // smoke test asserts both shapes from either platform.
  const windows = target.windows !== undefined ? target.windows : IS_WINDOWS
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'ia32' ? 'x86' : 'x64'
  if (windows) {
    return { kind: 'zip', url: `https://nodejs.org/dist/v${version}/node-v${version}-win-${cpu}.zip` }
  }
  const platform = target.platform || (IS_MAC ? 'darwin' : 'linux')
  return { kind: 'tar.gz', url: `https://nodejs.org/dist/v${version}/node-v${version}-${platform}-${cpu}.tar.gz` }
}

/**
 * Extract a downloaded node archive into `destDir`, stripping the archive's
 * single top-level `node-v…` directory so `destDir/bin/node` (or
 * `destDir\node.exe`) is the result.
 *
 * POSIX uses `tar --strip-components=1`. Windows ships `tar.exe` (bsdtar)
 * with the OS since 10 1803 and it extracts zip files too, but its `--strip-components`
 * support for zip is unreliable — so the archive is extracted whole and the
 * inner directory is moved up with plain fs calls.
 * @returns {Promise<{code: number, lines: string[]}>} like a runCommand result.
 */
async function extractNodeArchive({ runCommand, archive, destDir, kind, env, timeoutMs = 5 * 60_000 }) {
  if (kind !== 'zip') {
    return runCommand({
      cmd: 'tar',
      args: ['-xzf', archive, '--strip-components=1', '-C', destDir],
      env,
      timeoutMs,
    })
  }
  const staging = `${destDir}.unpack-${process.pid}`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  const unpack = await runCommand({
    cmd: 'tar',
    args: ['-xf', archive, '-C', staging],
    env,
    timeoutMs,
  })
  if (unpack.code !== 0) return unpack
  const entries = fs.readdirSync(staging, { withFileTypes: true }).filter(entry => entry.isDirectory())
  if (entries.length !== 1) {
    return { code: 1, signal: null, timedOut: false, aborted: false, lines: ['解压出的目录结构不符合预期'] }
  }
  const inner = path.join(staging, entries[0].name)
  fs.mkdirSync(destDir, { recursive: true })
  for (const entry of fs.readdirSync(inner)) {
    fs.rmSync(path.join(destDir, entry), { recursive: true, force: true })
    fs.renameSync(path.join(inner, entry), path.join(destDir, entry))
  }
  fs.rmSync(staging, { recursive: true, force: true })
  return { code: 0, signal: null, timedOut: false, aborted: false, lines: [] }
}

/**
 * Point `linkPath` at `targetDir` atomically enough to never leave the device
 * on a half-installed runtime.
 *
 * POSIX: a relative symlink created beside the target and renamed over
 * `current` — one atomic swap.
 *
 * Windows: a symlink needs admin/developer mode, but a directory JUNCTION does
 * not, and its target must be absolute. A junction cannot be renamed over, so
 * the swap is: rename `current` aside, rename the fresh junction in, then drop
 * the old one. A failure after the first step restores the previous pointer.
 *
 * @param {string} linkPath - the `current` path.
 * @param {string} targetDir - the version directory to point at.
 * @param {string} relativeTarget - the link text used on POSIX.
 */
function swapCurrentLink(linkPath, targetDir, relativeTarget) {
  const tmp = `${linkPath}.tmp-${process.pid}`
  const previous = `${linkPath}.old-${process.pid}`
  removeLink(tmp)
  if (!IS_WINDOWS) {
    fs.symlinkSync(relativeTarget, tmp, 'dir')
    fs.renameSync(tmp, linkPath)
    return
  }
  // Junction: no elevation required, and node resolves it like a directory.
  fs.symlinkSync(path.resolve(targetDir), tmp, 'junction')
  removeLink(previous)
  let movedOld = false
  if (fs.existsSync(linkPath)) {
    fs.renameSync(linkPath, previous)
    movedOld = true
  }
  try {
    fs.renameSync(tmp, linkPath)
  } catch (error) {
    if (movedOld && !fs.existsSync(linkPath)) {
      try {
        fs.renameSync(previous, linkPath)
      } catch {
        // The pointer is genuinely gone; the caller reports the failure.
      }
    }
    removeLink(tmp)
    throw error
  }
  removeLink(previous)
}

/** Remove a symlink/junction/directory without following it. */
function removeLink(linkPath) {
  try {
    const stat = fs.lstatSync(linkPath)
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(linkPath)
      return true
    }
    fs.rmSync(linkPath, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/** Human platform name for menus/dialogs/logs. */
function platformName() {
  if (IS_WINDOWS) return 'windows'
  if (IS_MAC) return 'macos'
  return 'linux'
}

module.exports = {
  IS_WINDOWS,
  IS_MAC,
  IS_LINUX,
  PATH_DELIMITER,
  PATH_KEY,
  SYSTEM_PATH_DIRS,
  executableNames,
  expandHome,
  extractNodeArchive,
  findExecutableIn,
  findExecutableInDirs,
  findFileIn,
  isExecutable,
  isPidAlive,
  joinPath,
  killTree,
  killTreeOf,
  nodeDistArchive,
  npmFor,
  platformName,
  removeLink,
  cmdQuote,
  needsShell,
  spawnInvocation,
  spawnOptions,
  splitPath,
  sshConfigPath,
  swapCurrentLink,
  taskkill,
}
