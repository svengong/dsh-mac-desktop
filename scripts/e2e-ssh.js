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
  if (process.env.E2E_KEEP !== '1') connection.stop()
  process.exit(0)
}

main().catch(error => {
  console.error(`E2E-SSH FAILED: ${error.message}`)
  process.exit(1)
})
