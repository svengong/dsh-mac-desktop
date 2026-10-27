'use strict'

/**
 * Process discovery — the OS-specific half of the shell's "find the dsh web
 * host that is already running" logic.
 *
 * The shell needs four questions answered about processes it did not spawn:
 *
 *  1. which pid is LISTENING on a loopback port?
 *  2. which loopback ports does a given pid listen on?
 *  3. which pids have files open under a dsh home? (two hosts over one home
 *     are illegal — they fight over the session store)
 *  4. every `node … bin.js web` process, with its bin path.
 *
 * POSIX answers all four with `lsof`/`ps`. Windows has neither, so the
 * equivalents are `netstat -ano -p TCP` (owner pid per LISTENING row) and
 * `Get-CimInstance Win32_Process` (pid + command line). The open-file
 * question has NO cheap Windows equivalent; it degrades to "unknown", and
 * every caller treats unknown as "do not kill" — the same direction the
 * POSIX code errs toward.
 */

const fs = require('node:fs')
const path = require('node:path')
const { runCommand } = require('./runner')
const { IS_WINDOWS } = require('./platform')

const PS_TIMEOUT_MS = 15_000

/** Quote a value for a single-quoted PowerShell string literal. */
function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

/**
 * Run one PowerShell snippet and return its stdout lines.
 *
 * `-NoProfile` matters: a profile could redefine `Write-Output` or emit its
 * own banner lines, and every parse below assumes exactly one record per
 * line. `-NonInteractive` keeps a prompt from hanging the call forever.
 * @returns {Promise<string[]>} output lines (empty when PowerShell is absent).
 */
async function powershell(script, { timeoutMs = PS_TIMEOUT_MS } = {}) {
  for (const exe of ['powershell.exe', 'pwsh.exe']) {
    try {
      const result = await runCommand({
        cmd: exe,
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        timeoutMs,
      })
      if (result.code === 0) return result.lines
    } catch {
      // Try the next PowerShell flavour (only PowerShell 7 may be installed).
    }
  }
  return []
}

/**
 * Loopback LISTENING pids from `netstat -ano -p TCP`.
 *
 * Rows look like (whitespace-separated, protocol-prefixed):
 *   `  TCP    127.0.0.1:3080     0.0.0.0:0      LISTENING     12345`
 * Only rows a loopback client can reach count, which includes a wildcard
 * bind: `dsh web` may listen on `0.0.0.0` while the shell still talks to it
 * on 127.0.0.1. A specific LAN address does NOT count — that listener is not
 * evidence about the loopback endpoint the shell probes.
 * @returns {Array<{address: string, port: number, pid: number}>}
 */
function parseNetstatListeners(lines) {
  const listeners = []
  for (const raw of Array.isArray(lines) ? lines : String(lines ?? '').split(/\r?\n/)) {
    const line = String(raw).trim()
    if (line === '' || !/^TCP/i.test(line)) continue
    const parts = line.split(/\s+/)
    if (parts.length < 5) continue
    // `TCP  <local>  <foreign>  LISTENING  <pid>`
    const local = parts[1]
    const state = parts[3].toUpperCase()
    const pid = Number(parts[4])
    if (state !== 'LISTENING') continue
    if (!Number.isInteger(pid) || pid <= 0) continue
    const match = /^(\[[^\]]*\]|[^:]*):(\d{1,5})$/.exec(local)
    if (match === null) continue
    const address = match[1].replace(/^\[|\]$/g, '')
    const port = Number(match[2])
    if (!Number.isInteger(port) || port <= 0) continue
    if (!isLoopbackAddress(address)) continue
    listeners.push({ address, port, pid })
  }
  return listeners
}

/** Whether an address is one of the loopback spellings either OS reports. */
function isLoopbackAddress(address) {
  const value = String(address).trim().toLowerCase()
  return value === '127.0.0.1' || value === '::1' || value === 'localhost'
    || value.startsWith('127.') || value === '0.0.0.0' || value === '::'
}

/**
 * Parse `wmic`-style / CIM process records for `dsh web` hosts.
 *
 * Input is one record per line as `pid<TAB>commandLine`: CIM objects print
 * their properties as a table whose only stable part is the numeric pid
 * column, so the command line is emitted LAST and taken verbatim.
 * @returns {Array<{pid: number, command: string}>}
 */
function parseWindowsProcessList(lines) {
  const records = []
  for (const raw of Array.isArray(lines) ? lines : String(lines ?? '').split(/\r?\n/)) {
    const line = String(raw).replace(/\s+$/, '')
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    if (!Number.isInteger(pid) || pid <= 0) continue
    records.push({ pid, command: match[2].trim() })
  }
  return records
}

/**
 * Every long-lived `dsh web` host process on this machine, with the runtime
 * bin it boots.
 *
 * Needed because the harness can end up running WITHOUT the shell having
 * spawned it (a self-restarting plugin relaunches the host detached). The
 * service is healthy and answering; the shell simply has no idea where it
 * went, and the state file keeps pointing at a process that exited.
 *
 * `node` only: a `sh -c "… bin.js web …"` wrapper shares the host's command
 * line and killing it would take down the wrapper, not the host. Real hosts
 * always exec node.
 * @returns {Promise<Array<{pid: number, bin: string}>>}
 */
async function dshWebProcesses() {
  if (IS_WINDOWS) return windowsDshWebProcesses()
  const lines = await posixProcessLines()
  if (lines === null) return []
  const found = []
  for (const line of lines) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
    const command = match[2]
    // `node <bin> web …` — matches both the npm artifact and the repo layout.
    // The command must START with the node binary: launcher shells that merely
    // quote the same argv in their `-c` string are wrappers, not hosts.
    if (!/^(\S*\/)?node(\d+(\.\d+)*)?\s/u.test(command)) continue
    const binMatch = /(\S*(?:@deepseek-ai[\\/]dsh|apps[\\/]cli)[\\/]lib[\\/]bin\.js)\s+web\b/u.exec(command)
    if (binMatch === null) continue
    found.push({ pid, bin: binMatch[1] })
  }
  return found
}

/**
 * `pid command-line` for every process, from whichever POSIX lister works.
 *
 * Normally `ps ax -o pid=,command=`. But `ps` is not always available to the
 * calling process — a hardened sandbox, a container without /proc, macOS
 * without the entitlements another user's processes need. `ps` failing used to
 * mean "the sweep found nothing", which is safe but leaves a stranded host
 * holding the session store (the task-board ledger is only released when the
 * owning pid dies, so the next spawn crash-loops).
 *
 * `pgrep -fl` is the fallback: same `pid commandline` shape, and it reaches
 * other processes through a different kernel interface (`sysctl` on macOS),
 * so one being denied does not imply the other is. Verified on a host where
 * `ps` is refused and `pgrep -fl` still lists every process.
 * @returns {Promise<string[]|null>} lines, or null when NO lister works.
 */
async function posixProcessLines() {
  const ps = await runCommand({
    cmd: 'ps',
    args: ['ax', '-o', 'pid=,command='],
    timeoutMs: 5000,
  }).catch(() => null)
  if (ps !== null && ps.code === 0 && ps.lines.length > 0) return ps.lines
  for (const bin of ['pgrep', '/usr/bin/pgrep', '/bin/pgrep']) {
    const result = await runCommand({
      cmd: bin,
      // -f matches the full command line, -l prints it beside the pid. No
      // pattern argument: we want every process, and the caller filters.
      args: ['-fl', '.'],
      timeoutMs: 8000,
    }).catch(() => null)
    if (result !== null && result.code === 0 && result.lines.length > 0) return result.lines
  }
  return null
}

/** The Windows twin: CIM gives pid + full command line for every process. */
async function windowsDshWebProcesses() {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue';",
    'Get-CimInstance Win32_Process |',
    'ForEach-Object { if ($_.CommandLine) { "$($_.ProcessId)`t$($_.CommandLine)" } }',
  ].join(' ')
  const lines = await powershell(script)
  const found = []
  for (const record of parseWindowsProcessList(lines)) {
    if (record.pid === process.pid) continue
    const bin = windowsHostBin(record.command)
    if (bin === '') continue
    found.push({ pid: record.pid, bin })
  }
  return found
}

/**
 * The runtime bin a Windows command line boots as a `dsh web` host, or ''.
 *
 * Two traps, both found on real Windows 11 ARM64:
 *
 *  1. The node binary is `node.exe`, not `node`. A pattern that only accepts a
 *     bare `node` (as the POSIX twin legitimately does) matches nothing and
 *     the sweep silently finds zero hosts.
 *  2. `node.exe` may be a QUOTED absolute path, and the guard process's own
 *     command line CONTAINS the service command line as its trailing
 *     arguments (`node service-guard.js <parent> node <bin> web`). A greedy
 *     "everything before bin.js" capture therefore yields the guard's whole
 *     argv as the bin path. So the bin is matched as the LAST path-like token
 *     before `web`, and a process whose command line starts with
 *     `service-guard.js` is rejected outright — it is the guard, which holds
 *     no files under the home and is never a kill candidate.
 * @param {string} command
 * @returns {string} the bin path, or '' when this is not a host.
 */
function windowsHostBin(command) {
  const text = String(command).trim()
  // The guard wraps the real host: never treat it as one.
  if (/service-guard\.js/iu.test(text)) return ''
  // Split the command line into argv-style tokens. A Windows command line has
  // no reliable general tokenizer (that is what CommandLineToArgvW is for),
  // but the shapes here are simple: a quoted path, or a bare path with no
  // spaces. `"..."` keeps its inner spaces; everything else splits on spaces.
  const tokens = []
  for (const match of text.matchAll(/"([^"]*)"|(\S+)/gu)) {
    tokens.push(match[1] !== undefined ? match[1] : match[2])
  }
  if (tokens.length < 2) return ''
  // argv[0] must be the node binary — some path ending in node.exe or node.
  // The basename is taken by hand: this function inspects WINDOWS command
  // lines even when it runs on a POSIX host (the smoke suite does exactly
  // that), and `path.basename` only understands THIS platform's separator.
  const exe = tokens[0].split(/[\\/]/u).pop().toLowerCase()
  if (exe !== 'node' && exe !== 'node.exe') return ''
  // argv[1] is the runtime bin; argv[2] must be the `web` subcommand.
  // Restricting to argv[1] is what keeps a guard wrapper (whose argv is
  // `service-guard.js <parent> node <bin> web`) from being read as a host, on
  // top of the explicit guard check above.
  const bin = tokens[1]
  if (!/(?:@deepseek-ai[\\/]dsh|apps[\\/]cli)[\\/]lib[\\/]bin\.js$/u.test(bin)) return ''
  if (tokens[2] !== 'web') return ''
  return bin
}

/**
 * Process-GROUP membership without `ps`.
 *
 * The shell's keepPid logic exempts a whole GROUP (the service guard plus the
 * service it backgrounds), so a sweep "protecting" the guard never kills the
 * service it just validated. `ps -o pgid=` is the direct answer, but `ps` can
 * be denied outright — and then the group check silently degrades to
 * "group unknown", which is exactly the case that kills a healthy service.
 *
 * `pgrep -g <pgid>` asks the same question a different way and, on macOS,
 * through a different kernel interface. Verified on a host where `ps` is
 * refused: it returns every member of the group.
 * @param {number} pgid
 * @returns {Promise<number[]>} member pids, empty when the group is unknown.
 */
async function processGroupMembers(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) return []
  for (const bin of ['pgrep', '/usr/bin/pgrep', '/bin/pgrep']) {
    const result = await runCommand({
      cmd: bin,
      args: ['-g', String(pgid)],
      timeoutMs: 5000,
    }).catch(() => null)
    // pgrep exits 1 when nothing matches — that is an empty group, not an error.
    if (result === null) continue
    if (result.code !== 0 && result.lines.length === 0) continue
    return result.lines
      .map(line => Number(String(line).trim()))
      .filter(pid => Number.isInteger(pid) && pid > 0)
  }
  return []
}

/**
 * Direct children of one pid (`pgrep -P`), empty when none or unavailable.
 * @param {number} pid
 * @returns {Promise<number[]>}
 */
async function processChildren(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return []
  for (const bin of ['pgrep', '/usr/bin/pgrep', '/bin/pgrep']) {
    const result = await runCommand({
      cmd: bin,
      args: ['-P', String(pid)],
      timeoutMs: 5000,
    }).catch(() => null)
    if (result === null) continue
    // pgrep exits 1 for "no match", which is an empty child list, not an error.
    if (result.code !== 0 && result.lines.length === 0) continue
    return result.lines
      .map(line => Number(String(line).trim()))
      .filter(child => Number.isInteger(child) && child > 0)
  }
  return []
}

/**
 * Every pid that must be SPARED when `keepPid` is the service we validated.
 *
 * A local `dsh web` is a FAMILY of two processes: the service guard (a
 * detached node process that polls its parent) and the real service it
 * backgrounds. The state file may record EITHER:
 *
 *  - the guard's pid (older builds) — then the service is its CHILD, and the
 *    two share the guard's process group;
 *  - the service's pid (current builds) — then the recorded pid is the service
 *    itself, and its group id belongs to the guard, not to it.
 *
 * Asking for "the group of keepPid" therefore only answers half the question,
 * and on a host where `ps` is denied it answered NEITHER — the sweep then
 * killed the very service it had just validated (reproduced: keeping the guard
 * pid reaped 1 instead of 0). Walking out in both directions covers both
 * layouts with tools that need no `ps`:
 *
 *  - `pgrep -g keepPid`: group members, when keepPid is the leader (guard).
 *  - `pgrep -P keepPid`: children, when keepPid is the guard.
 *
 * The guard is never a kill candidate anyway (it runs `service-guard.js`, not
 * `bin.js web`), so over-including it is harmless; under-including the service
 * is not.
 * @param {number} keepPid
 * @returns {Promise<Set<number>>} pids to spare.
 */
async function serviceFamily(keepPid) {
  const family = new Set()
  if (!Number.isInteger(keepPid) || keepPid <= 0) return family
  family.add(keepPid)
  if (IS_WINDOWS) {
    // Windows has no process groups and no pgrep, so the family is the
    // parent/child pair WMI knows: the guard is the PARENT of the service it
    // backgrounds. Both directions are walked because the state file may
    // record either pid (see the doc block above) — asking only "children of
    // keepPid" misses the case where keepPid IS the service, and asking only
    // "parent of keepPid" misses the case where keepPid is the guard.
    for (const relative of await windowsRelatives(keepPid)) family.add(relative)
    return family
  }
  for (const member of await processGroupMembers(keepPid)) family.add(member)
  for (const child of await processChildren(keepPid)) family.add(child)
  return family
}

/**
 * Parent and children of one pid, from WMI (`Get-CimInstance Win32_Process`).
 *
 * One WMI round-trip covers both directions. Each powershell spawn costs
 * ~300ms, and this runs on the connect path, so the two questions are asked
 * together rather than as two calls.
 * @param {number} pid
 * @returns {Promise<number[]>} related pids (parent + direct children).
 */
async function windowsRelatives(pid) {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue';",
    `$me = ${pid};`,
    '$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId;',
    '$parent = ($all | Where-Object { $_.ProcessId -eq $me }).ParentProcessId;',
    'if ($parent) { $parent };',
    '$all | Where-Object { $_.ParentProcessId -eq $me } | ForEach-Object { $_.ProcessId }',
  ].join(' ')
  const lines = await powershell(script)
  return lines
    .map(line => Number(String(line).trim()))
    .filter(value => Number.isInteger(value) && value > 0 && value !== pid)
}

/** Loopback TCP ports one process is listening on. */
async function listeningLoopbackPorts(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return []
  if (IS_WINDOWS) {
    const result = await runCommand({
      cmd: 'netstat',
      args: ['-ano', '-p', 'TCP'],
      timeoutMs: 5000,
    }).catch(() => null)
    if (result === null || result.code !== 0) return []
    const ports = []
    for (const entry of parseNetstatListeners(result.lines)) {
      if (entry.pid === pid && !ports.includes(entry.port)) ports.push(entry.port)
    }
    return ports
  }
  const result = await runCommand({
    cmd: 'lsof',
    args: ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'],
    timeoutMs: 5000,
  }).catch(() => null)
  if (result === null || result.code !== 0) return []
  const ports = []
  for (const line of result.lines) {
    const match = /(?:127\.0\.0\.1|\[::1\]|localhost):(\d{1,5})\s+\(LISTEN\)/u.exec(line)
    if (match === null) continue
    const port = Number(match[1])
    if (Number.isInteger(port) && port > 0) ports.push(port)
  }
  return ports
}

/**
 * Resolve the real pid LISTENING on a loopback port.
 *
 * POSIX tries `lsof`; Windows reads `netstat -ano` and takes the owner pid.
 * Returns 0 when nothing answers or the tool is unavailable.
 */
async function findListeningPid(port) {
  if (!Number.isInteger(port) || port <= 0) return 0
  if (IS_WINDOWS) {
    const result = await runCommand({
      cmd: 'netstat',
      args: ['-ano', '-p', 'TCP'],
      timeoutMs: 5000,
    }).catch(() => null)
    if (result === null || result.code !== 0) return 0
    const match = parseNetstatListeners(result.lines).find(entry => entry.port === port)
    return match === undefined ? 0 : match.pid
  }
  for (const bin of ['/usr/sbin/lsof', '/usr/bin/lsof', 'lsof']) {
    try {
      const result = await runCommand({
        cmd: bin,
        args: ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'],
        timeoutMs: 5000,
      })
      if (result.code !== 0) continue
      const pid = Number((result.lines[0] || '').trim())
      if (Number.isInteger(pid) && pid > 0) return pid
    } catch {
      // Try the next candidate.
    }
  }
  return 0
}

/**
 * Whether a process has files open under `dshHome` — its settings or
 * credentials. This is what tells two `dsh web` hosts that share one
 * installed runtime apart: the shell must only ever adopt the instance
 * serving ITS dsh home, never a bystander started from another one.
 *
 * The caller uses this in a KILL decision (`reapLocalHosts`: "this host is
 * mine, so it is safe to signal"), so "cannot tell" must answer FALSE. Getting
 * that backwards would make the sweep kill a bystander's healthy harness.
 *
 * Each OS uses the best identity it has:
 *
 *  - POSIX: open files under the home (`lsof -Fn -p`), which is exactly what a
 *    live dsh web holds (settings, session store).
 *  - Windows: the process's own COMMAND LINE (`Get-CimInstance`), because the
 *    shell always starts a local host from an absolute bin path under
 *    `<dshHome>/runtime/…`. Windows has no cheap open-file-per-pid query
 *    (handle.exe is a Sysinternals download; a WMI handle sweep is far too
 *    slow to run on every connect), but the command line is free and enough
 *    to tell one dsh home from another.
 *
 * An unreadable answer (tool missing, permission denied, empty output) is
 * FALSE on both paths.
 * @returns {Promise<boolean>}
 */
async function processUsesHome(pid, dshHome) {
  if (dshHome === null || dshHome === undefined || dshHome === '') return true
  let home = dshHome
  try {
    home = fs.realpathSync(dshHome)
  } catch {
    // Unresolvable (missing or unreadable): match on the path we were given
    // rather than giving up — this check only ever errs toward NOT killing.
  }
  if (IS_WINDOWS) return windowsProcessUsesHome(pid, home)
  const result = await runCommand({
    cmd: 'lsof',
    args: ['-Fn', '-p', String(pid)],
    timeoutMs: 5000,
  }).catch(() => null)
  if (result === null || result.code !== 0) return false
  // `lsof` reports paths with symlinks resolved — on macOS `/tmp` comes back
  // as `/private/tmp`, which is why `home` above is resolved first.
  const prefix = home.endsWith('/') ? home : home + '/'
  // `-Fn` prints one field per line, `n` being the file name.
  return result.lines.some(line => line.startsWith('n') && line.slice(1).startsWith(prefix))
}

/**
 * Windows twin of the `lsof` open-file check.
 *
 * Windows offers TWO usable identities, and this checks both because each one
 * alone is wrong in a different situation:
 *
 *  1. The command line. A local `dsh web` normally boots from an absolute bin
 *     path under `<dshHome>/runtime/…`, so the home appears in argv.
 *  2. The working directory. When the host was started from a checkout the
 *     argv may name the REPO rather than the home, but the shell always spawns
 *     it with `cwd` set to the home (see `spawnLocalService`). Reading `cwd`
 *     needs the PEB, which plain WMI cannot give, so it is written as a PATH
 *     BOUNDARY matched against the command line's quoted arguments instead.
 *
 * Both comparisons are boundary-aware: a bare `includes()` would treat
 * `C:\dsh` as matching `C:\dsh-dev\…`, i.e. adopt a bystander's instance — the
 * one mistake this function exists to prevent. Everything unreadable answers
 * FALSE (never kill what we cannot identify).
 * @param {number} pid
 * @param {string} home - the resolved dsh home.
 * @returns {Promise<boolean>}
 */
async function windowsProcessUsesHome(pid, home) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue';",
    `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
  ].join(' ')
  const lines = await powershell(script)
  const command = lines.join(' ').trim()
  if (command === '') return false
  return commandMentionsPath(command, home)
}

/**
 * Whether a command line refers to `target` as a whole path, not as a prefix
 * of a longer name.
 *
 * `C:\Users\u\.dsh` must match `"C:\Users\u\.dsh\runtime\x\bin.js"` but NOT
 * `"C:\Users\u\.dsh-dev\runtime\x\bin.js"`. Separators are normalised and the
 * comparison is case-insensitive (Windows paths are).
 * @param {string} command
 * @param {string} target
 * @returns {boolean}
 */
function commandMentionsPath(command, target) {
  const norm = value => String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const haystack = norm(command)
  const needle = norm(target)
  if (needle === '') return false
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return false
    // The character after the match must END the path segment: a quote, a
    // separator, whitespace, or end of string.
    const after = haystack.slice(at + needle.length, at + needle.length + 1)
    if (after === '' || after === '"' || after === '/' || after === ' ' || after === '\\t') return true
    from = at + 1
  }
}

module.exports = {
  PS_TIMEOUT_MS,
  dshWebProcesses,
  findListeningPid,
  isLoopbackAddress,
  listeningLoopbackPorts,
  parseNetstatListeners,
  parseWindowsProcessList,
  posixProcessLines,
  processChildren,
  processGroupMembers,
  serviceFamily,
  windowsRelatives,
  powershell,
  commandMentionsPath,
  processUsesHome,
  windowsHostBin,
  psQuote,
  windowsProcessUsesHome,
}