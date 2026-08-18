'use strict'

/**
 * End-to-end local verification for the desktop shell:
 *
 *   fresh clone → 确保仓库就绪 → git pull → node/pnpm 检查 → pnpm install
 *   → pnpm run build → 在空闲端口启动 dsh web → HTTP 探测（含 __DSH_BOOT__）
 *   → 停止服务 → 清理。
 *
 * It drives the real ConnectionManager/Updater classes, so this is the exact
 * code path the app's 「更新并重启」/首次初始化 run. Run it from
 * the desktop-shell product directory:
 *
 *   node scripts/e2e-local.js
 *
 * Env overrides: E2E_REPO_URL (default: file:// clone of this checkout),
 * E2E_PORT (default 3199). To verify the Finder-launch environment, run with
 * a minimal PATH:
 *
 *   env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
 *     /absolute/path/to/node scripts/e2e-local.js
 */

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { ConnectionManager, probeOnce } = require('../src/connection')
const { Updater } = require('../src/update')
const { runCommand } = require('../src/runner')

async function main() {
  const repoRoot = path.resolve(__dirname, '..', 'deepseek-harness')
  const repoUrl = process.env.E2E_REPO_URL || `file://${repoRoot}`
  const port = Number(process.env.E2E_PORT || 3199)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-'))
  const dshHome = `${dir}-home`
  const settings = {
    mode: 'local',
    local: { repoDir: dir, repoUrl, dshHome, port },
    ssh: { host: '', remoteRepoUrl: '', remoteRepoDir: '~/deepseek-harness', remotePort: 3080, localPort: 3080 },
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
  // Dirty the source checkout (an uncommitted change) so the pipeline builds
  // in the source dir — the state a user-modified checkout leaves. A clean
  // checkout builds into a versioned staging runtime and has no servable
  // source build, which is a different (covered) path.
  await connection.ensureLocalRepo(settings)
  fs.writeFileSync(path.join(dir, 'e2e-dirty'), 'x')
  const dirtyMark = await runCommand({ cmd: '/usr/bin/git', args: ['-C', dir, 'add', 'e2e-dirty'] })
  if (dirtyMark.code !== 0) {
    console.error(`E2E FAILED: cannot dirty the checkout: ${dirtyMark.lines.join('\n')}`)
    connection.stop()
    process.exit(1)
  }
  const result = await updater.runPipeline({ includePull: true, toleratePullFailure: true })
  if (!result.ok) {
    console.error('E2E FAILED: pipeline did not complete')
    connection.stop()
    process.exit(1)
  }
  const probe = await probeOnce(connection.url())
  if (!probe.up || !probe.isDsh) {
    console.error(`E2E FAILED: probe ${connection.url()} → up=${probe.up} isDsh=${probe.isDsh}`)
    connection.stop()
    process.exit(1)
  }
  console.log(`E2E OK: ${connection.url()} serves the harness UI`)

  // ── resident-program auto-upgrade on reconnect ───────────────────────────
  // Two scenarios, both with zero manual steps:
  //  A) crash recovery: the service is killed behind the shell's back; a
  //     fresh shell instance must restart it automatically.
  //  B) new version: the built bin gets a new mtime (a rebuilt checkout),
  //     so the version fingerprint changes; a fresh shell instance must
  //     REAP the still-running OLD service and serve the NEW fingerprint.
  const { versionToken } = require('../src/runtime-store')
  const stateBefore = connection.readLocalState(settings)
  const binPath = path.join(dir, 'apps', 'cli', 'lib', 'bin.js')
  if (stateBefore === null || !Number.isInteger(stateBefore.pid) || stateBefore.pid <= 0) {
    console.error('E2E FAILED: no local state after pipeline')
    connection.stop()
    process.exit(1)
  }

  // A) crash recovery: kill the resident service, reconnect must relaunch it.
  let sawRestartA = false
  const second = new ConnectionManager({
    getSettings: () => settings,
    onLog: line => {
      console.log(`[conn2] ${line}`)
      if (line.includes('dsh web 已监听端口')) sawRestartA = true
    },
  })
  await new Promise(resolve => setTimeout(resolve, 200))
  try {
    process.kill(stateBefore.pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
  await new Promise(resolve => setTimeout(resolve, 1200))
  await second.connect()
  if (second.status.state !== 'ready') {
    console.error(`E2E FAILED: crash recovery did not become ready: ${second.status.detail}`)
    second.stop()
    connection.stop()
    process.exit(1)
  }
  const probeA = await probeOnce(second.url())
  if (!probeA.up || !probeA.isDsh) {
    console.error(`E2E FAILED: crash recovery probe ${second.url()} → up=${probeA.up} isDsh=${probeA.isDsh}`)
    second.stop()
    connection.stop()
    process.exit(1)
  }
  if (!sawRestartA) {
    console.error('E2E FAILED: crash recovery did not relaunch the resident service')
    second.stop()
    connection.stop()
    process.exit(1)
  }
  console.log('E2E OK: reconnect auto-relaunched the killed resident service')

  // B) new version: bump the built bin mtime (a rebuilt checkout) — the
  //    version fingerprint changes, so the next connect must reap the old
  //    service and serve the new fingerprint.
  const stamp = new Date()
  fs.utimesSync(binPath, stamp, stamp)
  let sawReapB = false
  const third = new ConnectionManager({
    getSettings: () => settings,
    onLog: line => {
      console.log(`[conn3] ${line}`)
      if (line.includes('旧版/残留服务')) sawReapB = true
    },
  })
  await third.connect()
  if (third.status.state !== 'ready') {
    console.error(`E2E FAILED: upgrade connect failed: ${third.status.detail}`)
    third.stop()
    second.stop()
    connection.stop()
    process.exit(1)
  }
  const probeB = await probeOnce(third.url())
  if (!probeB.up || !probeB.isDsh) {
    console.error(`E2E FAILED: upgrade probe ${third.url()} → up=${probeB.up} isDsh=${probeB.isDsh}`)
    third.stop()
    second.stop()
    connection.stop()
    process.exit(1)
  }
  if (!sawReapB) {
    console.error('E2E FAILED: the old resident service was not reaped on version change')
    third.stop()
    second.stop()
    connection.stop()
    process.exit(1)
  }
  const stateAfter = third.readLocalState(settings)
  // mtimeMs may carry sub-millisecond precision; read the actual stat, not
  // the timestamp we wrote, so the expected token matches exactly.
  const expectedToken = versionToken(`dirty:${fs.statSync(binPath).mtimeMs}`)
  if (stateAfter === null || stateAfter.version !== expectedToken) {
    console.error(`E2E FAILED: resident not upgraded (state ${stateAfter === null ? 'null' : stateAfter.version}, expected ${expectedToken})`)
    third.stop()
    second.stop()
    connection.stop()
    process.exit(1)
  }
  console.log('E2E OK: reconnect auto-upgraded the resident service to the new build fingerprint')
  connection.stop()
  second.stop()
  third.stop()
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(dshHome, { recursive: true, force: true })
  process.exit(0)
}

main().catch(error => {
  console.error(`E2E FAILED: ${error.message}`)
  process.exit(1)
})
