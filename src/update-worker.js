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

  try {
    status({ phase: 'starting', version })
    log(`更新任务开始：${NPM_PACKAGE}@${version}`)
    const tools = resolveTools(settings)
    if (tools.node === '') {
      throw new Error('未找到兼容的 node（需 22.19+ 或 24+），官方产物无法安装。')
    }
    status({ phase: 'downloading', version })
    const buildDir = runtimeStore.localVersionDir(settings, `npm:${version}`)
    fs.rmSync(buildDir, { recursive: true, force: true })
    fs.mkdirSync(buildDir, { recursive: true })
    const installed = await installNpmArtifact({
      nodeBin: tools.node,
      runtimeDir: buildDir,
      spec: `${NPM_PACKAGE}@${version}`,
      env: tools.env,
      onLine: log,
    })
    log(`已安装 ${installed}`)
    status({ phase: 'switching', version })
    const activated = runtimeStore.activateLocalRuntime(settings, `npm:${version}`)
    log(`已原子切换到官方产物 ${activated}`)
    runtimeStore.clearPendingUpdate(settings)
    status({ phase: 'done', version, finishedAt: new Date().toISOString() })
    log('完成：下次连接将使用新版本（壳会自动重启服务）。')
    process.exit(0)
  } catch (error) {
    runtimeStore.clearPendingUpdate(settings)
    log(`✗ ${String(error.message || error)}`)
    status({ phase: 'error', error: String(error.message || error), finishedAt: new Date().toISOString() })
    process.exit(1)
  }
}

main()
