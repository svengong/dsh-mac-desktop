'use strict'

/**
 * SSH helpers for the remote (VS Code Remote style) connection mode.
 *
 * Host selection reuses the user's `~/.ssh/config`: the shell passes the
 * chosen alias (or a custom `[user@]host[:port]`) to ssh unchanged, so
 * OpenSSH itself applies HostName/User/Port/IdentityFile/ProxyJump and the
 * rest of the config. The shell only adds safety options:
 * `BatchMode=yes` makes password prompts fail fast instead of hanging, and
 * `StrictHostKeyChecking=accept-new` records a new host key on first use
 * while still rejecting a *changed* key. Remote commands execute through the
 * remote login shell so tools installed under user profile managers (brew,
 * nvm, fnm) resolve with the user's normal PATH.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// ── ~/.ssh/config parsing ───────────────────────────────────────────────────

/** Split a config line on whitespace, honoring double quotes. */
function tokenize(line) {
  const tokens = []
  let current = ''
  let inQuote = false
  for (const char of line) {
    if (inQuote) {
      if (char === '"') inQuote = false
      else current += char
    } else if (char === '"') {
      inQuote = true
    } else if (char === ' ' || char === '\t') {
      if (current !== '') {
        tokens.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }
  if (current !== '') tokens.push(current)
  return tokens
}

/** Strip `keyword=value` forms; the first value of a keyword wins, like ssh. */
function valueOf(tokens) {
  return tokens
    .map(token => (token.includes('=') ? token.slice(token.indexOf('=') + 1) : token))
    .join(' ')
    .trim()
}

function resolveInclude(baseDir, pattern) {
  if (!pattern.includes('*') && !pattern.includes('?')) return [path.resolve(baseDir, pattern)]
  try {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
    const regex = new RegExp(`^${escaped}$`)
    return fs.readdirSync(baseDir).filter(entry => regex.test(entry)).map(entry => path.join(baseDir, entry))
  } catch {
    return []
  }
}

/**
 * Parse one ssh config file into host entries. Include directives are
 * followed (bounded depth, cycle-safe). Values obey ssh semantics: the first
 * occurrence of HostName/User/Port for an alias wins.
 */
function parseSshConfigFile(filePath, out, visited, depth) {
  if (depth > 5 || visited.has(filePath)) return
  visited.add(filePath)
  let content
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return
  }
  const baseDir = path.dirname(filePath)
  let current = null
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const tokens = tokenize(line)
    if (tokens.length === 0) continue
    const keyword = tokens[0].toLowerCase()
    const rest = tokens.slice(1)
    if (keyword === 'include' && rest.length > 0) {
      for (const included of resolveInclude(baseDir, rest.join(' '))) {
        parseSshConfigFile(included, out, visited, depth + 1)
      }
      continue
    }
    if (keyword === 'host') {
      current = { aliases: rest, hostname: '', user: '', port: 0, extras: [] }
      out.push(current)
      continue
    }
    if (current === null) continue
    const value = valueOf(rest)
    if (value === '') continue
    if (keyword === 'hostname') {
      if (current.hostname === '') current.hostname = value
    } else if (keyword === 'user') {
      if (current.user === '') current.user = value
    } else if (keyword === 'port') {
      const number = Number(value)
      if (current.port === 0 && Number.isInteger(number) && number > 0 && number <= 65535) current.port = number
    } else if (keyword === 'identityfile' || keyword === 'proxyjump') {
      current.extras.push(`${keyword}: ${value}`)
    }
  }
}

/** Parse the full config (with includes) into host entries. */
function parseSshConfig(configPath) {
  const entries = []
  parseSshConfigFile(configPath, entries, new Set(), 0)
  return entries
}

function defaultSshConfigPath() {
  return path.join(os.homedir(), '.ssh', 'config')
}

/** A literal (non-pattern) Host alias can be a destination; patterns cannot. */
function isLiteralAlias(alias) {
  return !/[*?[\]!]/.test(alias)
}

let sshConfigCache = { mtime: 0, hosts: [] }

/**
 * The selectable hosts from ~/.ssh/config: `{ alias, detail, extras }` per
 * literal alias, first Host block wins. Cached by file mtime.
 */
function listSshHosts(configPath = defaultSshConfigPath()) {
  let mtime = 0
  try {
    mtime = fs.statSync(configPath).mtimeMs
  } catch {
    return []
  }
  if (sshConfigCache.mtime === mtime && sshConfigCache.path === configPath) return sshConfigCache.hosts
  const hosts = []
  const seen = new Set()
  for (const entry of parseSshConfig(configPath)) {
    for (const alias of entry.aliases) {
      if (!isLiteralAlias(alias) || seen.has(alias)) continue
      seen.add(alias)
      const host = entry.hostname !== '' ? entry.hostname : alias
      const detail = `${entry.user !== '' ? `${entry.user}@` : ''}${host}${entry.port !== 0 ? `:${entry.port}` : ''}`
      hosts.push({ alias, detail, extras: entry.extras })
    }
  }
  sshConfigCache = { mtime, path: configPath, hosts }
  return hosts
}

function isSshConfigAlias(host) {
  return listSshHosts().some(entry => entry.alias === host)
}

// ── destination handling ────────────────────────────────────────────────────

/**
 * Parse `[user@]host[:port]` for custom (non-config) destinations. IPv6
 * literals are deliberately unsupported: the shell treats the last colon as a
 * port separator, so a bracketed literal would mis-parse.
 */
function parseTarget(target) {
  if (typeof target !== 'string' || target.trim() === '') return null
  const text = target.trim()
  let user = ''
  let rest = text
  const at = text.lastIndexOf('@')
  if (at !== -1) {
    user = text.slice(0, at)
    rest = text.slice(at + 1)
  }
  let host = rest
  let port = 0
  const colon = rest.lastIndexOf(':')
  if (colon !== -1) {
    const portText = rest.slice(colon + 1)
    if (!/^\d+$/.test(portText)) return null
    host = rest.slice(0, colon)
    port = Number(portText)
  }
  if (host === '') return null
  return { user, host, port }
}

/**
 * Resolve the destination for a given host string. A config alias is passed
 * to ssh unchanged (OpenSSH applies the config); a custom string is split
 * into `-p` and `user@host` only when it carries them.
 */
function sshBase(target) {
  const options = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new']
  let remote = target
  if (!isSshConfigAlias(target)) {
    const parsed = parseTarget(target)
    if (parsed !== null) {
      if (parsed.port !== 0) options.push('-p', String(parsed.port))
      remote = parsed.user !== '' ? `${parsed.user}@${parsed.host}` : parsed.host
    }
  }
  return { options, remote }
}

/**
 * ssh argv fragment that runs one remote command without a TTY. The caller
 * supplies the ssh binary as `cmd`; this returns only options + destination
 * + command (embedding the program name would make ssh treat it as the
 * destination host).
 */
function sshCommandArgs(target, remoteCommand) {
  const { options, remote } = sshBase(target)
  return [...options, remote, remoteCommand]
}

/** ssh argv fragment for a persistent port-forward tunnel (no remote command). */
function tunnelArgs(target, localPort, remotePort) {
  const { options, remote } = sshBase(target)
  return [
    '-N',
    '-L', `${localPort}:127.0.0.1:${remotePort}`,
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    ...options, remote,
  ]
}

/** Human label: config aliases show their resolved `user@host:port`. */
function displayLabel(target) {
  const alias = listSshHosts().find(entry => entry.alias === target)
  if (alias) return `${alias.alias}（${alias.detail}）`
  const parsed = parseTarget(target)
  if (parsed !== null) return parsed.user !== '' ? `${parsed.user}@${parsed.host}` : parsed.host
  return target
}

/** Single-quote a value for embedding inside a remote shell command string. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Render a remote path for a remote shell command: a leading `~/` becomes
 * `"$HOME"/` so the remote shell expands it, and the rest stays single-quoted.
 */
function remotePath(dir) {
  if (dir.startsWith('~/')) return `"$HOME"/${shellQuote(dir.slice(2))}`
  return shellQuote(dir)
}

/**
 * The shell-command prefix that makes remote commands self-contained: the
 * remote `~/.dsh-tools` portable node and pnpm come before anything else on
 * the remote PATH, and the lefthook escape matches the local clean env.
 */
function remoteToolchainPrefix() {
  return 'export DSH_LEFTHOOK_ALLOW_HOOKS_PATH_OVERRIDE=1; export PATH="$HOME"/.dsh-tools/node/bin:"$HOME"/.dsh-tools/node_modules/.bin:"$PATH";'
}

module.exports = {
  parseTarget,
  sshCommandArgs,
  tunnelArgs,
  shellQuote,
  remotePath,
  remoteToolchainPrefix,
  displayLabel,
  parseSshConfig,
  listSshHosts,
  isSshConfigAlias,
  defaultSshConfigPath,
}
