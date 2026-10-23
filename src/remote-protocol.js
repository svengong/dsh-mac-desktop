'use strict'

/**
 * Remote protocol: the shell commands this client sends to a machine over ssh,
 * and the parsers that read their output back.
 *
 * Why this is its own module. These are the only definitions that have to stay
 * byte-compatible with the REMOTE side (dsh web, a login shell, ps/lsof on some
 * Linux box) and with the Android client, which reimplements the same protocol
 * in Kotlin. They are pure: no ssh, no state, no process handles. Kept inside
 * connection.js they were buried under 2000 lines of lifecycle code, where a
 * change to one shell string sat next to unrelated session machinery - and the
 * escaping in a quoted command is exactly what is easy to break while editing
 * something else.
 *
 * Everything here is dependency-free on purpose so it can be imported and
 * asserted in isolation.
 */

// One round-trip inventory of every `dsh web` host on a remote machine:
// `pid|files-under-home|port,port`. The port scan and the home-ownership
// check are folded into the same `ps` loop on purpose — each remote command
// costs a full ssh handshake, and a remote connect already spends several.
// No single quotes: `shellQuote` wraps the whole thing in them.
// `node` only: a `bash -c "… bin.js web …"` launcher shares the host's
// command line and often its cwd under the home, and killing it would take
// down a wrapper rather than a host. Real hosts always exec node.
// The scan opens with two capability lines so a sweep can tell "nothing to
// reap" apart from "could not look": `ps` may exist yet be denied (restricted
// shells, hardening), and an empty host list then reads as a clean home while a
// second host quietly keeps the session store and the task-board ledger. That
// failure is silent, so it is reported instead of inferred.
const REMOTE_HOST_SCAN = 'command -v lsof >/dev/null 2>&1 && echo __dsh_lsof_ok || echo __dsh_lsof_missing; if ps ax -o pid=,command= >/dev/null 2>&1; then echo __dsh_ps_ok; ps ax -o pid=,command= 2>/dev/null | grep -E "bin\.js +web" | grep -v grep | grep -E "^[[:space:]]*[0-9]+[[:space:]]+([^[:space:]]*/)?node([0-9.]*)?[[:space:]]" | sed -E "s/^[[:space:]]*([0-9]+).*/\\1/" | while read p; do uses=$(lsof -Fn -p $p 2>/dev/null | grep -c "^n$HOME/.dsh/"); ports=$(lsof -nP -a -p $p -iTCP -sTCP:LISTEN 2>/dev/null | grep -oE "(127\.0\.0\.1|\[::1\]):[0-9]+" | sed -E "s/.*:([0-9]+)$/\\1/" | tr "\\n" "," | sed "s/,$//"); echo "$p|$uses|$ports"; done; else echo __dsh_ps_missing; fi'

/**
 * Resolve the shell `sshd` itself would use for this account, on the remote.
 *
 * The authoritative source is the passwd entry's login shell (`getent`), which
 * is what `sshd` executes for a non-interactive command — falling back to
 * `$SHELL` and then to well-known POSIX shells. Only shells we can safely
 * drive with `-l -c` are accepted.
 *
 * Why this exists: the harness used to hardcode a `zsh → bash → sh` preference
 * and take the first that merely EXISTED. On a box whose real login shell is
 * bash but which happens to have zsh installed, every remote command therefore
 * ran under zsh — and zsh never reads `~/.bashrc`, where PATH is normally set.
 * `node` then resolved to a system v22.11.0 that predates `import.meta.main`,
 * so the dsh CLI's `if (import.meta.main)` gate made it exit 0 with NO output:
 * a silent no-op that reads as "the service flashes and dies".
 *
 * Runs as a SINGLE round-trip (each ssh handshake is expensive): the shell
 * names are tried in one command and the first usable absolute path wins.
 * No single quotes — `shellQuote` wraps the whole command in them.
 */
const REMOTE_LOGIN_SHELL_PROBE = 'c=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7); [ -n "$c" ] || c=${SHELL:-}; for s in "$c" /bin/bash /usr/bin/bash /bin/zsh /usr/bin/zsh /bin/sh; do case "$s" in ""|*/nologin|*/false) continue ;; esac; [ -x "$s" ] || continue; case "${s##*/}" in bash|zsh|sh|dash|ksh|ksh93|mksh|ash) printf "%s\\n" "$s"; exit 0 ;; esac; done; printf "%s\\n" /bin/sh'

/**
 * Pick the login-shell path out of `REMOTE_LOGIN_SHELL_PROBE` output. Pure, so
 * the acceptance rules are testable without an ssh connection: only an
 * absolute path to a shell we can drive with `-l -c` is usable, and anything
 * else falls back to `/bin/sh`.
 * @param {string[]|string} lines
 * @returns {string}
 */
function parseRemoteLoginShell(lines) {
  const list = typeof lines === 'string' ? lines.split('\n') : lines ?? []
  for (const line of list) {
    const value = String(line).trim()
    if (!value.startsWith('/')) continue
    const base = value.slice(value.lastIndexOf('/') + 1)
    if (['bash', 'zsh', 'sh', 'dash', 'ksh', 'ksh93', 'mksh', 'ash'].includes(base)) return value
  }
  return '/bin/sh'
}

/**
 * Parse `REMOTE_HOST_SCAN` output into host records. Pure so the parsing —
 * the easiest part to get wrong — is testable without an ssh connection.
 * @param {string[]} lines
 * @returns {Array<{pid: number, usesHome: boolean, ports: number[]}>}
 */
function parseRemoteHostScan(lines) {
  const hosts = []
  const report = { hosts, psAvailable: null, lsofAvailable: null }
  // Accept a raw string too. `for..of` over a string walks it CHARACTER by
  // character, so a string argument would match nothing and silently yield no
  // hosts — and an empty sweep means "nothing to reap", letting an orphan
  // survive to hold the task-board ledger and crash-loop the next spawn. An
  // empty result is the worst possible answer here, so make it impossible to
  // reach by accident.
  for (const line of typeof lines === 'string' ? lines.split('\n') : lines ?? []) {
    const trimmed = line.trim()
    // Capability markers. A sweep needs to distinguish "no hosts" from "could
    // not look", and only the host can tell us which.
    if (trimmed === '__dsh_ps_ok') { report.psAvailable = true; continue }
    if (trimmed === '__dsh_ps_missing') { report.psAvailable = false; continue }
    if (trimmed === '__dsh_lsof_ok') { report.lsofAvailable = true; continue }
    if (trimmed === '__dsh_lsof_missing') { report.lsofAvailable = false; continue }
    const match = /^(\d+)\|(\d+)\|(.*)$/u.exec(trimmed)
    if (match === null) continue
    const pid = Number(match[1])
    if (!Number.isInteger(pid) || pid <= 0) continue
    hosts.push({
      pid,
      usesHome: Number(match[2]) > 0,
      ports: match[3]
        .split(',')
        .map(value => Number(value))
        .filter(port => Number.isInteger(port) && port > 0),
    })
  }
  return report
}

/**
 * Which ports the remote probe reported as serving the dsh boot page.
 * Input lines look like `44571=1`; anything that is not a positive count
 * (curl failed, connection refused, non-dsh listener) is dropped.
 * @param {string[]} lines
 * @returns {Set<number>}
 */
function parseRemoteProbe(lines) {
  const live = new Set()
  // Same string-safety as `parseRemoteHostScan`: an empty probe means "this
  // port is dead", so a miscalled parse would reap a healthy service.
  for (const line of typeof lines === 'string' ? lines.split('\n') : lines ?? []) {
    const match = /^(\d+)=(\d+)$/u.exec(line.trim())
    if (match !== null && Number(match[2]) > 0) live.add(Number(match[1]))
  }
  return live
}

module.exports = {
  REMOTE_HOST_SCAN,
  REMOTE_LOGIN_SHELL_PROBE,
  parseRemoteHostScan,
  parseRemoteLoginShell,
  parseRemoteProbe,
}
