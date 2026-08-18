'use strict'

/**
 * End-to-end SSH verification: ensure the remote repo (clone when missing) →
 * self-contained toolchain bootstrap on the remote → pnpm install → build →
 * tunnel → remote service start → probe through the tunnel.
 *
 * It drives the real ConnectionManager/Updater classes, so this is the exact
 * code path the app's first-run initialization and 「更新并重启」 run.
 *
 *   node scripts/e2e-ssh.js <ssh-host> [remote-dir] [repo-url]
 *
 * Env: E2E_LOCAL_PORT (default 3082), E2E_REMOTE_PORT (default 3080),
 * E2E_KEEP=1 keeps the remote service running after the check.
 */

const { ConnectionManager, probeOnce } = require('../src/connection')
const { Updater } = require('../src/update')
const { remotePath } = require('../src/ssh')
const { versionToken } = require('../src/runtime-store')

async function main() {
  const host = process.argv[2] || process.env.E2E_SSH_HOST || ''
  const remoteDir = process.argv[3] || process.env.E2E_REMOTE_DIR || '~/deepseek-harness'
  const repoUrl = process.argv[4] || process.env.E2E_REPO_URL || 'https://github.com/deepseek-ai/deepseek-harness.git'
  if (host === '') {
    console.error('usage: node scripts/e2e-ssh.js <ssh-host> [remote-dir] [repo-url]')
    process.exit(2)
  }
  const localPort = Number(process.env.E2E_LOCAL_PORT || 3082)
  const remotePort = Number(process.env.E2E_REMOTE_PORT || 3080)
  const settings = {
    mode: 'ssh',
    local: { repoDir: '', repoUrl: '', port: 3080 },
    ssh: { host, remoteRepoUrl: repoUrl, remoteRepoDir: remoteDir, remotePort, localPort },
    toolPaths: { node: '', git: '', pnpm: '', shell: '/bin/zsh' },
  }
  const connection = new ConnectionManager({
    getSettings: () => settings,
    onLog: line => console.log(`[conn] ${line}`),
  })
  const updater = new Updater({
    getSettings: () => settings,
    connection,
    onLine: line => console.log(line),
  })
  // Dirty the remote checkout so the pipeline builds in the source dir (the
  // user-modified-checkout state). A clean remote checkout builds into a
  // versioned runtime instead — a different (staging) path.
  await connection.ensureRemoteRepo(settings)
  const dirtyMark = await connection.remoteRun(
    host,
    `touch ${remotePath(settings.ssh.remoteRepoDir)}/e2e-dirty && cd ${remotePath(settings.ssh.remoteRepoDir)} && git -c user.name=e2e -c user.email=e2e@example.com -c core.hooksPath=/dev/null add e2e-dirty`,
    { timeoutMs: 30_000 },
  )
  if (dirtyMark.code !== 0) {
    console.error(`E2E-SSH FAILED: cannot dirty the remote checkout: ${dirtyMark.lines.join('\n')}`)
    connection.stop()
    process.exit(1)
  }
  const result = await updater.runPipeline({ includePull: true, toleratePullFailure: true })
  if (!result.ok) {
    console.error('E2E-SSH FAILED: pipeline did not complete')
    process.exit(1)
  }
  await connection.connect()
  if (connection.status.state !== 'ready') {
    console.error(`E2E-SSH FAILED: ${connection.status.detail}`)
    connection.stop()
    process.exit(1)
  }
  const probe = await probeOnce(connection.url())
  if (!probe.up || !probe.isDsh) {
    console.error(`E2E-SSH FAILED: probe ${connection.url()} → up=${probe.up} isDsh=${probe.isDsh}`)
    connection.stop()
    process.exit(1)
  }
  console.log(`E2E-SSH OK: ${connection.url()} serves the remote harness UI (${host})`)

  // ── remote resident recovery + auto-upgrade on reconnect ─────────────────
  // 1) Kill the remote service behind the shell's back (crash / remote
  //    reboot). A fresh shell instance must NOT just build a tunnel to the
  //    dead port: the state-matching fast path must liveness-probe and
  //    relaunch the resident service automatically.
  const state1 = await connection.readRemoteState(settings)
  if (state1 === null || !Number.isInteger(state1.pid) || state1.pid <= 0) {
    console.error('E2E-SSH FAILED: no remote state to kill')
    connection.stop()
    process.exit(1)
  }
  await connection.remoteRun(host, `kill -9 ${state1.pid} 2>/dev/null || true`)
  await new Promise(resolve => setTimeout(resolve, 1500))
  connection.stop()
  const second = new ConnectionManager({
    getSettings: () => settings,
    onLog: line => console.log(`[conn2] ${line}`),
  })
  await second.connect()
  if (second.status.state !== 'ready') {
    console.error(`E2E-SSH FAILED: reconnect did not recover: ${second.status.detail}`)
    second.stop()
    process.exit(1)
  }
  const probe2 = await probeOnce(second.url())
  if (!probe2.up || !probe2.isDsh) {
    console.error(`E2E-SSH FAILED: post-recovery probe ${second.url()} → up=${probe2.up} isDsh=${probe2.isDsh}`)
    second.stop()
    process.exit(1)
  }
  console.log('E2E-SSH OK: reconnect auto-relaunched the dead remote resident service')

  // 2) Version change: bump the remote built bin mtime (a rebuilt checkout).
  //    The dirty build fingerprint changes, so the next connect must reap
  //    the OLD resident service and relaunch the new fingerprint. (The
  //    remote dirty token is `stat -f %m` seconds — set the mtime +2s so
  //    the second-granularity stat is guaranteed to differ.)
  const binRemote = `${remotePath(settings.ssh.remoteRepoDir)}/apps/cli/lib/bin.js`
  // GNU stat first: its BSD-style `-f %m` prints a filesystem block to
  // stdout (polluting line 0) before failing, so BSD-first breaks on Linux.
  const statCmd = `stat -c %Y ${binRemote} 2>/dev/null || stat -f %m ${binRemote} 2>/dev/null || echo 0`
  const mtimeBefore = (await second.remoteRun(host, statCmd)).lines[0]
  const bump = await second.remoteRun(
    host,
    `cd ${remotePath(settings.ssh.remoteRepoDir)} && node -e "const fs=require('fs');const t=new Date(Date.now()+2000);fs.utimesSync('apps/cli/lib/bin.js',t,t)"`,
    { timeoutMs: 20_000 },
  )
  if (bump.code !== 0) {
    console.error(`E2E-SSH FAILED: cannot bump remote bin mtime: ${bump.lines.join('\n')}`)
    second.stop()
    process.exit(1)
  
  }
  const mtimeAfter = (await second.remoteRun(host, statCmd)).lines[0]
  if (mtimeBefore === mtimeAfter) {
    console.error('E2E-SSH FAILED: remote bin mtime did not change')
    second.stop()
    process.exit(1)
  }
  // Drop the remote runtime so the source HEAD/mtime is the version source
  // again (the dirty build lives in the source dir, so it stays servable).
  await second.remoteRun(host, 'rm -rf "$HOME"/.dsh/runtime 2>/dev/null || true')
  second.stop()
  const third = new ConnectionManager({
    getSettings: () => settings,
    onLog: line => console.log(`[conn3] ${line}`),
  })
  await third.connect()
  if (third.status.state !== 'ready') {
    console.error(`E2E-SSH FAILED: post-upgrade connect failed: ${third.status.detail}`)
    third.stop()
    process.exit(1)
  }
  const probe3 = await probeOnce(third.url())
  if (!probe3.up || !probe3.isDsh) {
    console.error(`E2E-SSH FAILED: post-upgrade probe ${third.url()} → up=${probe3.up} isDsh=${probe3.isDsh}`)
    third.stop()
    process.exit(1)
  }
  const state3 = await third.readRemoteState(settings)
  const expectedToken = versionToken(`dirty:${mtimeAfter}`)
  if (state3 === null || state3.version !== expectedToken) {
    console.error(`E2E-SSH FAILED: remote resident not upgraded (state ${state3 === null ? 'null' : state3.version}, expected ${expectedToken})`)
    third.stop()
    process.exit(1)
  }
  console.log(`E2E-SSH OK: reconnect auto-upgraded the remote resident service (mtime ${mtimeBefore} → ${mtimeAfter})`)
  if (process.env.E2E_KEEP !== '1') third.stop()
  process.exit(0)
}

main().catch(error => {
  console.error(`E2E-SSH FAILED: ${error.message}`)
  process.exit(1)
})
