'use strict'

/**
 * Detached update worker (Phase 3).
 *
 * Spawned by the shell with `spawnDetached` for a local official-artifact
 * update, this process installs the prebuilt CLI into a versioned runtime
 * dir and atomically switches `current` — WITHOUT a source checkout or a
 * pnpm build — and it SURVIVES shell quit. The shell observes progress by
 * polling `<dshHome>/runtime/update-status.json`; when the shell was gone
 * the whole time, the next launch reads the status file and offers to
 * restart the service onto the new runtime.
 *
 * The worker deliberately does NOT restart the service: the shell does
 * that on observing `done` (or on next connect, whose version-mismatch
 * reap restarts it anyway). Restart-from-worker would need the whole
 * ConnectionManager, defeating the point of a tiny detached helper.
 *
 * Cancellation contract: `<dshHome>/update-cancel.json` is the cancellation
 * token and SIGTERM is its escalation. The worker observes both only between
 * stages — the `npm install` child group is killed mid-flight, and once the
 * atomic switch starts (`phase: 'switching'`) the switch always runs to
 * completion so the device is never left pointing at a half-installed
 * runtime. A cancelled worker writes `phase: 'cancelled'` and exits 0 so the
 * shell (or the next launch) knows the intent file must not be resumed.
 *
 * Usage: node src/update-worker.js <task.json>
 * task.json: { dshHome, repoDir, repoUrl, toolPaths, version, registryUrl }
 */

const fs = require('node:fs')
const path = require('node:path')
const { normalizeSettings } = require('./settings')
const { resolveTools } = require('./tools')
const { installNpmArtifact } = require('./artifact')
const { NPM_PACKAGE } = require('./runtime-layout')
const runtimeStore = require('./runtime-store')

async function main() {
  const taskPath = process.argv[2]
  if (taskPath === undefined || taskPath === '') {
    console.error('usage: update-worker.js <task.json>')
    process.exit(2)
  }
  let task
  try {
    task = JSON.parse(fs.readFileSync(taskPath, 'utf8'))
  } catch (error) {
    console.error(`task 读取失败：${error.message}`)
    process.exit(2)
  }
  const settings = normalizeSettings({
    mode: 'local',
    local: {
      repoDir: task.repoDir ?? '',
      repoUrl: task.repoUrl ?? '',
      dshHome: task.dshHome ?? '~/.dsh-dev',
    },
    toolPaths: task.toolPaths ?? {},
  })
  const version = String(task.version ?? '').trim()
  if (version === '') {
    console.error('task.version 缺失')
    process.exit(2)
  }

  const status = patch => runtimeStore.writeUpdateStatus(settings, { pid: process.pid, ...patch })
  const log = line => {
    try {
      fs.appendFileSync(path.join(runtimeStore.localRuntimeRoot(settings), 'update-worker.log'), `${line}\n`)
    } catch {
      // Log file is best-effort; the status tail carries the same lines.
    }
    status({ logTail: [line] })
  }

  let cancelRequested = false
  // Once the switching critical section starts, never interrupt: an atomic
  // switch must either finish or fail naturally. Before that, an exit leaves
  // the runtime untouched (old version still running) and the intent file
  // behind; the cancelled status tells the shell not to resume it.
  let switching = false
  let finishing = false
  const shouldAbort = () => cancelRequested || runtimeStore.readCancelToken(settings) !== null
  const terminate = () => {
    if (switching || finishing) return
    cancelRequested = true
    try {
      status({ phase: 'cancelled', cancelledAt: new Date().toISOString() })
    } catch {
      // Status file is best-effort.
    }
  }
  process.on('SIGTERM', terminate)
  process.on('SIGINT', terminate)

  try {
    if (shouldAbort()) throw cancelError()
    status({ phase: 'starting', version })
    log(`更新任务开始：${NPM_PACKAGE}@${version}`)
    const tools = resolveTools(settings)
    if (tools.node === '') {
      throw new Error('未找到兼容的 node（需 22.19+ 或 24+），官方产物无法安装。')
    }
    if (shouldAbort()) throw cancelError()
    status({ phase: 'downloading', version })
    // The worker is a separate PROCESS from the shell, so in-process busy
    // gates cannot serialize it against a shell-side update of the same
    // dshHome. It must take the SAME local lock the shell pipeline uses:
    // without it, a worker and another shell instance could install and
    // atomically switch the same `current` concurrently. The lock also makes
    // a worker that runs while the shell's own pipeline waits visible to
    // cancel: shouldAbort aborts the wait before the worker ever acquires.
    const lockName = runtimeStore.buildLockName(settings)
    await runtimeStore.withLocalLock(
      settings,
      lockName,
      async () => {
        const buildDir = runtimeStore.localVersionDir(settings, `npm:${version}`)
        fs.rmSync(buildDir, { recursive: true, force: true })
        fs.mkdirSync(buildDir, { recursive: true })
        let installed
        try {
          installed = await installNpmArtifact({
            nodeBin: tools.node,
            runtimeDir: buildDir,
            spec: `${NPM_PACKAGE}@${version}`,
            env: tools.env,
            onLine: line => log(line),
            shouldAbort,
          })
        } catch (error) {
          // A cancelled install must not leave a half-written version dir that a
          // later rollback could mistake for a real runtime.
          fs.rmSync(buildDir, { recursive: true, force: true })
          throw error
        }
        if (shouldAbort()) {
          fs.rmSync(buildDir, { recursive: true, force: true })
          throw cancelError()
        }
        log(`已安装 ${installed}`)
        // Critical section: from here until `done` is written, SIGTERM is
        // ignored (the switch is one symlink rename + manifest write).
        switching = true
        status({ phase: 'switching', version })
        const activated = runtimeStore.activateLocalRuntime(settings, `npm:${version}`)
        log(`已原子切换到官方产物 ${activated}`)
      },
      { shouldAbort, timeoutMs: 25 * 60_000 },
    )
    finishing = true
    runtimeStore.clearPendingUpdate(settings)
    runtimeStore.clearCancelToken(settings)
    status({ phase: 'done', version, finishedAt: new Date().toISOString() })
    log('完成：下次连接将使用新版本（壳会自动重启服务）。')
    process.exit(0)
  } catch (error) {
    finishing = true
    if (error.code === 'CANCELLED' || shouldAbort()) {
      runtimeStore.clearPendingUpdate(settings)
      runtimeStore.clearCancelToken(settings)
      log('✗ 更新已取消，清理未完成的安装目录。旧版本继续运行。')
      status({ phase: 'cancelled', version, cancelledAt: new Date().toISOString() })
      process.exit(0)
    }
    runtimeStore.clearPendingUpdate(settings)
    log(`✗ ${String(error.message || error)}`)
    status({ phase: 'error', error: String(error.message || error), finishedAt: new Date().toISOString() })
    process.exit(1)
  }
}

function cancelError() {
  const error = new Error('更新已取消：后台更新任务收到取消请求')
  error.code = 'CANCELLED'
  error.name = 'UpdateCancelledError'
  return error
}

main()
