'use strict'

/**
 * Plain-node smoke test for the Electron-free modules. Run from anywhere:
 *   node scripts/smoke.js
 * Electron-only surfaces (windows, tray, menu) are covered by the in-app
 * DSH_DESKTOP_SMOKE=1 mode.
 */

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const net = require('node:net')
const path = require('node:path')
const { normalizeSettings } = require('../src/settings')
const { terminalLabel, terminalPrefix } = require('../src/labels')
const {
  compareVersions, isNewerVersion, versionOf,
} = require('../src/components')
const { UpdateManager } = require('../src/update-manager')
const { parseTarget, shellQuote, remotePath, tunnelArgs, parseSshConfig, listSshHosts } = require('../src/ssh')
const { runCommand, spawnService, killActiveChildren } = require('../src/runner')
const { ConnectionManager } = require('../src/connection')
const { findFreePort, releasePort, reservePort } = require('../src/ports')
const runtimeStore = require('../src/runtime-store')
const { WindowManager } = require('../src/window-manager')
const { mergeUpdates } = require('../src/device-merge')
const { resolveTools, engineOk } = require('../src/tools')
const { presentWindow } = require('../src/windows')

async function main() {
  // settings: flat active-device view plus the per-device map. A legacy
  // single-device document migrates into the map under its canonical key.
  let s = normalizeSettings({ mode: 'ssh', ssh: { host: ' u@h:2222 ', localPort: 'bad' } })
  assert.strictEqual(s.mode, 'ssh')
  assert.strictEqual(s.ssh.host, 'u@h:2222')
  assert.strictEqual(s.ssh.localPort, 3080)
  assert.strictEqual(s.activeDeviceId, 'ssh:u@h:2222')
  assert.ok(s.devices['ssh:u@h:2222'] !== undefined)
  assert.strictEqual(s.devices['ssh:u@h:2222'].update.components.length, 1)
  assert.strictEqual(normalizeSettings({ mode: 'bogus' }).mode, 'local')
  assert.strictEqual(normalizeSettings(null).local.port, 3080)
  const defaultLocal = normalizeSettings(null)
  assert.strictEqual(defaultLocal.local.repoDir, path.resolve(__dirname, '..', 'deepseek-harness'))
  assert.strictEqual(terminalLabel(defaultLocal), '本地')
  assert.strictEqual(terminalPrefix(defaultLocal), 'DSH-[本地]')
  assert.strictEqual(terminalLabel({ mode: 'ssh', ssh: { host: 'ubuntu' } }), 'ubuntu')
  assert.strictEqual(terminalLabel({ mode: 'ssh', ssh: { host: 'dev@10.0.0.8:22' } }), '10.0.0.8')
  const migrated = normalizeSettings({ mode: 'ssh', ssh: { target: 'legacy-host' } })
  assert.strictEqual(migrated.ssh.host, 'legacy-host')
  assert.strictEqual(migrated.activeDeviceId, 'ssh:legacy-host')

  // machine identity: a device carrying a machineId keys under machine:<id>;
  // without one it falls back to the ssh alias until the first connect.
  const machineId = '11111111-2222-3333-4444-555555555555'
  const identified = normalizeSettings({ mode: 'ssh', ssh: { host: 'home4' }, machineId })
  assert.strictEqual(identified.activeDeviceId, `machine:${machineId}`)
  assert.strictEqual(identified.devices[`machine:${machineId}`].machineId, machineId)
  const unidentified = normalizeSettings({ mode: 'ssh', ssh: { host: 'ubuntu' } })
  assert.strictEqual(unidentified.activeDeviceId, 'ssh:ubuntu')

  // A second device gets its own update section; switching active devices
  // restores each one's settings independently.
  const multi = normalizeSettings({
    activeDeviceId: 'ssh:second',
    devices: {
      'ssh:first': { mode: 'ssh', ssh: { host: 'first' }, update: { lastCheckAt: 'first-check' } },
      'ssh:second': { mode: 'ssh', ssh: { host: 'second' } },
    },
  })
  assert.strictEqual(multi.mode, 'ssh')
  assert.strictEqual(multi.ssh.host, 'second')
  assert.strictEqual(multi.update.lastCheckAt, '')
  assert.strictEqual(multi.devices['ssh:first'].update.lastCheckAt, 'first-check')

  // update section normalization: only the built-in Harness row remains;
  // legacy plugin/preset/user components are dropped.
  const withUpdates = normalizeSettings({
    mode: 'local',
    update: {
      autoCheckOnLaunch: false,
      components: [
        { id: 'harness', enabled: false },
        { id: 'better-sidebar', registryUrl: ' https://registry.npmmirror.com ', bogus: true },
        { id: 'anchored-standard', kind: 'git-preset', repoUrl: 'https://example.com/preset.git', sourceDir: 'preset', enabled: false },
        { id: 'custom-npm', kind: 'npm', title: 'Custom Npm', packageName: 'dsh-custom', profile: 'web', enabled: true },
        { id: 'custom-preset', kind: 'git-preset', repoUrl: 'https://example.com/custom.git', sourceDir: 'preset' },
        { id: 'unknown', repoUrl: 'https://evil.example' },
        { id: 'bad-script', kind: 'script', command: 'rm -rf /' },
      ],
    },
  })
  assert.strictEqual(withUpdates.update.autoCheckOnLaunch, false)
  assert.strictEqual(withUpdates.update.components.length, 1)
  assert.strictEqual(withUpdates.update.components[0].id, 'harness')
  assert.strictEqual(withUpdates.update.components[0].enabled, false)
  assert.strictEqual(normalizeSettings({ local: { port: 0 } }).local.port, 3080)

  // version comparison subset used by the update manager
  assert.strictEqual(versionOf('^0.12.1'), '0.12.1')
  assert.strictEqual(versionOf('latest'), '')
  assert.strictEqual(compareVersions('0.13.0', '0.12.1'), 1)
  assert.strictEqual(compareVersions('0.12.1-beta', '0.12.1'), -1)
  assert.strictEqual(isNewerVersion('v1.2.3', '1.2.2'), true)
  assert.strictEqual(isNewerVersion('1.2.2', '1.2.2'), false)
  assert.strictEqual(isNewerVersion('latest', '1.2.2'), false)

  // ssh
  assert.deepStrictEqual(parseTarget('u@h:2222'), { user: 'u', host: 'h', port: 2222 })
  assert.deepStrictEqual(parseTarget('h'), { user: '', host: 'h', port: 0 })
  assert.strictEqual(parseTarget(''), null)
  assert.strictEqual(parseTarget('h:xx'), null)
  assert.strictEqual(shellQuote("a'b"), `'a'\\''b'`)
  assert.strictEqual(remotePath('~/x'), '"$HOME"/\'x\'')
  const tunnel = tunnelArgs('u@h:22', 3080, 3081)
  assert.ok(tunnel.includes('-N'))
  assert.ok(tunnel.includes('3080:127.0.0.1:3081'))
  assert.ok(tunnel.includes('BatchMode=yes'))

  // ssh config parsing
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ssh-config-'))
  const config = path.join(dir, 'config')
  fs.writeFileSync(config, [
    '# comment',
    'Host dev prod-a',
    '  HostName 10.0.0.8',
    '  User sven',
    '  Port 2222',
    '  ProxyJump jump',
    '',
    'Host *.wild',
    '  HostName example.com',
    'Include extra.conf',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(dir, 'extra.conf'), 'Host extra\n  HostName 192.168.1.2\n')
  const entries = parseSshConfig(config)
  assert.strictEqual(entries.length, 3)
  const hosts = listSshHosts(config)
  const dev = hosts.find(host => host.alias === 'dev')
  assert.ok(dev, 'dev alias missing')
  assert.strictEqual(dev.detail, 'sven@10.0.0.8:2222')
  assert.deepStrictEqual(dev.extras, ['proxyjump: jump'])
  assert.ok(!hosts.some(host => host.alias.includes('*')), 'wildcard alias leaked')
  assert.ok(hosts.some(host => host.alias === 'prod-a'), 'second alias missing')
  const extra = hosts.find(host => host.alias === 'extra')
  assert.ok(extra, 'Include not followed')
  assert.strictEqual(extra.detail, '192.168.1.2')
  fs.rmSync(dir, { recursive: true, force: true })

  // runner
  const echo = await runCommand({ cmd: '/bin/echo', args: ['dsh-smoke'] })
  assert.strictEqual(echo.code, 0)
  assert.deepStrictEqual(echo.lines, ['dsh-smoke'])
  const failing = await runCommand({ cmd: '/bin/sh', args: ['-c', 'echo out; echo err >&2; exit 3'] })
  assert.strictEqual(failing.code, 3)
  assert.deepStrictEqual(failing.lines, ['out', 'err'])
  const noNewline = await runCommand({ cmd: '/bin/sh', args: ['-c', 'printf no-newline'] })
  assert.deepStrictEqual(noNewline.lines, ['no-newline'])

  // remoteRun payload extraction: a newline-less command output that fuses
  // with the END marker (e.g. `printf ... > file` + `cat file`) must still
  // yield the clean payload.
  const { extractPayload } = (() => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'connection.js'), 'utf8')
    const fn = src.match(/function extractPayload\(lines, beginMarker, endMarker\) \{[\s\S]*?^\}/m)[0]
    return { extractPayload: new Function(`${fn}\nreturn extractPayload`)() }
  })()
  const B = '__B__'
  const E = '__E__'
  assert.deepStrictEqual(extractPayload(['banner', B, '{"a":1}', E, 'tail'], B, E), ['{"a":1}'])
  assert.deepStrictEqual(extractPayload([B, '{"a":1}' + E], B, E), ['{"a":1}'])
  assert.deepStrictEqual(extractPayload([B + 'json' + E], B, E), ['json'])
  assert.deepStrictEqual(extractPayload(['a', 'b'], B, E), ['a', 'b'])

  // runner process registry: killActiveChildren must terminate every tracked
  // child (in-flight build, service, tunnel) so app quit never orphans one.
  const sleeper = spawnService({ cmd: '/bin/sleep', args: ['30'] })
  await new Promise(resolve => sleeper.child.once('spawn', resolve))
  killActiveChildren()
  const sleeperEnd = await new Promise(resolve => sleeper.child.once('close', (code, signal) => resolve({ code, signal })))
  assert.ok(sleeperEnd.code !== null || sleeperEnd.signal !== null, 'registry kill must terminate the child')

  // window presentation: dock activation must recover hidden and minimized
  // windows, not only recreate an absent one. A minimized window keeps the
  // native deminiaturize animation: no `show()` call, and focus is deferred
  // until the `restore` event.
  assert.strictEqual(presentWindow(null), null)
  assert.strictEqual(presentWindow({ isDestroyed: () => true }), null)
  const calls = []
  let restoreListener = null
  const minimized = {
    isDestroyed: () => false,
    isMinimized: () => true,
    once: (event, handler) => {
      calls.push(`once:${event}`)
      restoreListener = handler
    },
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  }
  assert.strictEqual(presentWindow(minimized), minimized)
  assert.deepStrictEqual(calls, ['once:restore', 'restore'])
  calls.length = 0
  restoreListener()
  assert.deepStrictEqual(calls, ['focus'])
  calls.length = 0
  const hidden = {
    isDestroyed: () => false,
    isMinimized: () => false,
    once: () => calls.push('once'),
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  }
  assert.strictEqual(presentWindow(hidden), hidden)
  assert.deepStrictEqual(calls, ['show', 'focus'])

  // tools: engine filter + a pnpm that actually runs under the clean env
  assert.strictEqual(engineOk('v23.11.0'), false)
  assert.strictEqual(engineOk('v22.19.0'), true)
  assert.strictEqual(engineOk('v24.16.0'), true)
  const tools = resolveTools({ local: { repoDir: '', repoUrl: '' }, toolPaths: { node: '', git: '', pnpm: '', shell: '/bin/zsh' } })
  assert.ok(tools.node !== '', 'node not resolved')
  assert.ok(tools.pnpm !== '', 'pnpm not resolved')
  const pnpmRun = await runCommand({ cmd: tools.pnpm, args: [...tools.pnpmPrefix, '--version'], env: tools.env })
  assert.strictEqual(pnpmRun.code, 0, `pnpm not runnable under clean env: ${pnpmRun.lines.join('\n')}`)

  // update manager snapshot: only the built-in Harness row is present,
  // no network calls.
  const manager = new UpdateManager({
    getSettings: () => normalizeSettings({
      update: {
        autoCheckOnLaunch: true,
        components: [
          { id: 'anchored-standard', enabled: false },
          { id: 'better-sidebar', kind: 'npm', packageName: 'dsh-better-sidebar', profile: 'web' },
          { id: 'custom-npm', kind: 'npm', packageName: 'dsh-custom', profile: 'web' },
        ],
      },
    }),
    saveUpdate: () => {},
    connection: { resolvedTools: () => resolveTools({ local: { repoDir: '', repoUrl: '' }, toolPaths: { node: '', git: '', pnpm: '', shell: '/bin/zsh' } }) },
    harnessUpdater: { check: async () => ({ gitRepo: false, branch: '', upstream: '', ahead: 0, behind: 0, dirty: false, summary: 'not a repo' }) },
    onLog: () => {},
    onState: () => {},
  })
  const snapshot = manager.snapshot()
  assert.strictEqual(snapshot.components.length, 1)
  assert.strictEqual(snapshot.components[0].id, 'harness')
  assert.ok(snapshot.components.some(row => row.id === 'anchored-standard') === false)
  assert.ok(snapshot.components.some(row => row.id === 'better-sidebar') === false)
  assert.ok(snapshot.components.some(row => row.id === 'custom-npm') === false)
  assert.strictEqual(snapshot.autoCheckOnLaunch, true)

  // runtime store: parse the CLI's OS-chosen port announcement and round-trip
  // local state. Remote state/locks stay smoke-free here because they need ssh.
  const announced = runtimeStore.parseDshWebUrl('dsh web: http://127.0.0.1:62513')
  assert.deepStrictEqual(announced, { url: 'http://127.0.0.1:62513', port: 62513, host: '127.0.0.1' })
  assert.strictEqual(runtimeStore.parseDshWebUrl('noise'), null)
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-store-'))
  const runtimeSettings = { mode: 'local', local: { repoDir: '', repoUrl: '', dshHome: runtimeHome, port: 3080 }, ssh: {} }
  assert.strictEqual(runtimeStore.writeLocalState(runtimeSettings, { pid: 1, port: 2, version: 'abc' }), true)
  assert.strictEqual(runtimeStore.readLocalState(runtimeSettings).port, 2)
  let locked = 0
  await runtimeStore.withLocalLock(runtimeSettings, 'smoke-lock', async () => {
    locked += 1
    await new Promise(resolve => setTimeout(resolve, 10))
  })
  assert.strictEqual(locked, 1)
  // Versioned runtime switch: activate v1, then build v2, then roll back.
  const v1 = runtimeStore.localVersionDir(runtimeSettings, 'v1')
  fs.mkdirSync(path.join(v1, 'apps/cli/lib'), { recursive: true })
  fs.writeFileSync(path.join(v1, 'apps/cli/lib/bin.js'), 'v1')
  runtimeStore.activateLocalRuntime(runtimeSettings, 'v1')
  assert.strictEqual(runtimeStore.readLocalRootManifest(runtimeSettings).current, 'v1')
  const v2 = runtimeStore.localVersionDir(runtimeSettings, 'v2')
  fs.mkdirSync(path.join(v2, 'apps/cli/lib'), { recursive: true })
  fs.writeFileSync(path.join(v2, 'apps/cli/lib/bin.js'), 'v2')
  runtimeStore.activateLocalRuntime(runtimeSettings, 'v2')
  assert.strictEqual(runtimeStore.readLocalRootManifest(runtimeSettings).previous, 'v1')
  assert.strictEqual(runtimeStore.rollbackLocalRuntime(runtimeSettings), 'v1')
  assert.strictEqual(runtimeStore.readLocalRootManifest(runtimeSettings).current, 'v1')
  assert.ok((runtimeStore.localActiveRuntimeDir(runtimeSettings) ?? '').endsWith(path.join('runtime', 'v1')))
  // Remote runtime activation/rollback protocol, mocked without ssh.
  let remoteManifest = { current: null, previous: null }
  const remoteRun = async (_host, command) => {
    if (command.includes('/manifest.json')) {
      return { code: 0, lines: remoteManifest.current === null ? ['__none__'] : [JSON.stringify(remoteManifest)] }
    }
    if (command.includes('test -f ')) return { code: 0, lines: ['ok'] }
    if (command.includes('find ')) return { code: 0, lines: [] }
    if (command.includes('rm -rf ')) return { code: 0, lines: [] }
    const activate = /ln -sfn (\S+) current/.exec(command)
    if (activate !== null) {
      remoteManifest = { current: activate[1], previous: remoteManifest.current }
      return { code: 0, lines: [] }
    }
    throw new Error(`unexpected remote runtime command: ${command}`)
  }
  const remoteSettings = { mode: 'ssh', ssh: { host: 'dev' } }
  await runtimeStore.activateRemoteRuntime(remoteSettings, remoteRun, 'v1')
  assert.strictEqual(remoteManifest.current, 'v1')
  await runtimeStore.activateRemoteRuntime(remoteSettings, remoteRun, 'v2')
  assert.strictEqual(remoteManifest.previous, 'v1')
  assert.strictEqual(await runtimeStore.rollbackRemoteRuntime(remoteSettings, remoteRun), 'v1')
  assert.strictEqual(remoteManifest.current, 'v1')
  runtimeStore.removeLocalState(runtimeSettings)

  // window manager: last-active device and bounds survive a reload.
  const windowStateFile = path.join(runtimeHome, 'window-state.json')
  const wm = new WindowManager(windowStateFile)
  const fakeWin = { isDestroyed: () => false, getBounds: () => ({ x: 12, y: 24, width: 1100, height: 720 }) }
  wm.markActive({ id: 7, deviceKey: 'ssh:dev', window: fakeWin, activeView: 'updates' })
  wm.save()
  const restoredWm = new WindowManager(windowStateFile)
  assert.strictEqual(restoredWm.lastActiveDeviceKey(), 'ssh:dev')
  assert.strictEqual(restoredWm.lastActiveWorkspaceId, 7)
  assert.strictEqual(restoredWm.boundsFor('ssh:dev').width, 1100)
  const fakeWorkspace = { id: 7, deviceKey: 'ssh:dev', window: fakeWin, activeView: 'updates' }
  assert.strictEqual(restoredWm.lastActiveWorkspace(new Map([[7, fakeWorkspace]])), fakeWorkspace)

  // Local `--port 0`: the shell adopts the OS-chosen port from stdout.
  // This needs a BUILT local checkout (deepseek-harness/); on CI the
  // checkout is absent (it is gitignored), so skip instead of failing —
  // live service launching is covered by scripts/e2e-local.js.
  const repoDir = path.resolve(__dirname, '..', 'deepseek-harness')
  const portZeroHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-port-zero-'))
  const portZeroSettings = { mode: 'local', local: { repoDir, repoUrl: '', dshHome: portZeroHome, port: 3080 }, ssh: {} }
  if (require('../src/runtime-layout').runtimeLayout(repoDir) !== null) {
    const portZeroConnection = new ConnectionManager({ getSettings: () => portZeroSettings, onLog: () => {} })
    const portZeroTools = resolveTools({
      local: { repoDir, repoUrl: '' },
      toolPaths: { node: '', git: '', pnpm: '', shell: '/bin/zsh' },
    })
    portZeroConnection.resolvedTools = () => portZeroTools
    await portZeroConnection.spawnLocalService(portZeroSettings, 0, 'smoke-port-zero')
    assert.ok(portZeroConnection.localPort > 0, 'expected an OS-chosen local port')
    portZeroConnection.stopOwnedChildren()
  } else {
    console.log('SKIP: --port 0 live-service check (no built deepseek-harness checkout)')
  }
  await new Promise(resolve => setTimeout(resolve, 200))
  fs.rmSync(portZeroHome, { recursive: true, force: true })
  fs.rmSync(runtimeHome, { recursive: true, force: true })

  // port fallback + in-process reservations: a busy port yields the next free
  // one, and a reserved free port is skipped by the shell's own allocator so
  // two sessions cannot race onto the same fallback port.
  const blocker = net.createServer()
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve))
  const busyPort = blocker.address().port
  const fallbackConnection = new ConnectionManager({
    getSettings: () => ({ mode: 'local', local: { port: busyPort, repoDir: '', repoUrl: '' }, ssh: {} }),
  })
  const freePort = await fallbackConnection.acquireLocalPort(busyPort)
  assert.ok(freePort > busyPort, `expected a port above ${busyPort}, got ${freePort}`)
  assert.strictEqual(await findFreePort(freePort), freePort + 1)
  fallbackConnection.releaseReservedLocalPort()
  blocker.close()
  const reserved = freePort + 1
  assert.strictEqual(reservePort(reserved), true)
  assert.notStrictEqual(await findFreePort(reserved), reserved)
  assert.strictEqual(releasePort(reserved), true)

  // runtime layouts: repo and npm shapes resolve their own bins; a dir with
  // neither is not built. npmArtifactVersion reads the installed manifest.
  const { runtimeLayout, runtimeBin, runtimeIsBuilt, npmArtifactVersion } = require('../src/runtime-layout')
  const layoutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-layout-'))
  fs.mkdirSync(path.join(layoutDir, 'apps', 'cli', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(layoutDir, 'apps', 'cli', 'lib', 'bin.js'), '#!/usr/bin/env node\n')
  assert.strictEqual(runtimeLayout(layoutDir).kind, 'repo')
  assert.strictEqual(runtimeIsBuilt(layoutDir), true)
  assert.ok(runtimeBin(layoutDir).endsWith(path.join('apps', 'cli', 'lib', 'bin.js')))
  const emptyDir = path.join(layoutDir, 'empty')
  fs.mkdirSync(emptyDir)
  assert.strictEqual(runtimeLayout(emptyDir), null)
  assert.strictEqual(runtimeIsBuilt(emptyDir), false)
  const npmDir = path.join(layoutDir, 'npm')
  fs.mkdirSync(path.join(npmDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(npmDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '#!/usr/bin/env node\n')
  fs.writeFileSync(path.join(npmDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.7' }))
  assert.strictEqual(runtimeLayout(npmDir).kind, 'npm')
  assert.strictEqual(npmArtifactVersion(npmDir), 'npm:0.1.0-rc.7')
  assert.strictEqual(npmArtifactVersion(emptyDir), '')

  // update intent + worker status round-trip (Phase 1/3 state files)
  const homeDir = path.join(layoutDir, 'home')
  const homeSettings = { mode: 'local', local: { repoDir: '', repoUrl: '', dshHome: homeDir }, ssh: {} }
  assert.strictEqual(runtimeStore.readPendingUpdate(homeSettings), null)
  runtimeStore.writePendingUpdate(homeSettings, { intent: 'artifact', version: '0.1.0-rc.7' })
  const pending = runtimeStore.readPendingUpdate(homeSettings)
  assert.strictEqual(pending.intent, 'artifact')
  assert.strictEqual(pending.version, '0.1.0-rc.7')
  runtimeStore.writeUpdateStatus(homeSettings, { phase: 'downloading', version: '0.1.0-rc.7', logTail: ['line one'] })
  runtimeStore.writeUpdateStatus(homeSettings, { phase: 'installing', logTail: ['line two'] })
  const status = runtimeStore.readUpdateStatus(homeSettings)
  assert.strictEqual(status.phase, 'installing')
  assert.deepStrictEqual(status.logTail, ['line one', 'line two'])
  assert.ok(status.updatedAt !== undefined)
  runtimeStore.clearUpdateStatus(homeSettings)
  assert.strictEqual(runtimeStore.readUpdateStatus(homeSettings), null)
  runtimeStore.clearPendingUpdate(homeSettings)
  assert.strictEqual(runtimeStore.readPendingUpdate(homeSettings), null)
  fs.rmSync(layoutDir, { recursive: true, force: true })
  // artifact preference: SSH-remote with the official repo URL prefers the
  // prebuilt npm artifact too (no remote compilation); forks stay source.
  const { Updater } = require('../src/update')
  const prefUpdater = new Updater({ getSettings: () => ({}), connection: null })
  assert.strictEqual(prefUpdater.preferArtifact({ mode: 'ssh', ssh: { remoteRepoUrl: '' } }), true)
  assert.strictEqual(prefUpdater.preferArtifact({ mode: 'ssh', ssh: { remoteRepoUrl: 'https://github.com/deepseek-ai/deepseek-harness.git' } }), true)
  assert.strictEqual(prefUpdater.preferArtifact({ mode: 'ssh', ssh: { remoteRepoUrl: 'https://github.com/someone/harness-fork.git' } }), false)
  assert.strictEqual(prefUpdater.preferArtifact({ mode: 'local', local: { repoUrl: '' } }), true)
  assert.strictEqual(prefUpdater.preferArtifact({ mode: 'local', local: { repoUrl: 'https://github.com/someone/harness-fork.git' } }), false)
  assert.strictEqual(prefUpdater.preferArtifact({ mode: 'ssh', ssh: { remoteRepoUrl: '' } }), true)

  // device-merge: machine-id drift must not lose the Harness component.
  const harnessDef = { id: 'harness', kind: 'harness' }
  const m1 = mergeUpdates({ components: [harnessDef] }, { components: [harnessDef], lastCheckAt: '2026-08-18T00:00:00Z' })
  assert.strictEqual(m1.components.length, 1)
  assert.strictEqual(m1.components[0].id, 'harness')
  assert.strictEqual(m1.lastCheckAt, '2026-08-18T00:00:00Z')

  console.log('smoke: all checks passed')
}

main().catch(error => {
  console.error(`smoke failed: ${error.message}`)
  process.exit(1)
})
