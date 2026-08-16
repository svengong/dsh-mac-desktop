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

async function main() {
  const repoRoot = path.resolve(__dirname, '..', 'deepseek-harness')
  const repoUrl = process.env.E2E_REPO_URL || `file://${repoRoot}`
  const port = Number(process.env.E2E_PORT || 3199)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-'))
  const settings = {
    mode: 'local',
    local: { repoDir: dir, repoUrl, port },
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
  connection.stop()
  fs.rmSync(dir, { recursive: true, force: true })
  process.exit(0)
}

main().catch(error => {
  console.error(`E2E FAILED: ${error.message}`)
  process.exit(1)
})
