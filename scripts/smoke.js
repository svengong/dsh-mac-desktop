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
const { runCommand, spawnService, killActiveChildren, SERVICE_PID_PREFIX } = require('../src/runner')
const { ConnectionManager } = require('../src/connection')
const { findFreePort, releasePort, reservePort } = require('../src/ports')
const runtimeStore = require('../src/runtime-store')
const { WindowManager } = require('../src/window-manager')
const { mergeUpdates } = require('../src/device-merge')
const { resolveTools, engineOk } = require('../src/tools')
const { presentWindow } = require('../src/windows')
const { isExternalUrl, isExternalSubFrameUrl } = require('../src/external-open')

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

  // harness navigation classification: the shell renders only the ROOT of the
  // loopback harness service; public web pages (search citations, web-search
  // results, window.open targets) are external and belong in the OS default
  // browser. So are non-root loopback paths: the harness is a hash-routed SPA
  // served from `/`, and any other path is a file the service does not serve
  // (a 404 blank page), e.g. a clicked workspace .html.
  assert.strictEqual(isExternalUrl('https://example.com/page'), true)
  assert.strictEqual(isExternalUrl('http://example.com'), true)
  assert.strictEqual(isExternalUrl('mailto:a@example.com'), true)
  assert.strictEqual(isExternalUrl('file:///tmp/x.html'), true)
  assert.strictEqual(isExternalUrl('http://192.168.1.10:3080'), true)
  assert.strictEqual(isExternalUrl('http://127.0.0.1:3080/docs/report.html'), true)
  assert.strictEqual(isExternalUrl('http://localhost:3080/docs/report.html'), true)
  assert.strictEqual(isExternalUrl('http://127.0.0.1:3080/artifacts/a.svg'), true)
  assert.strictEqual(isExternalUrl('http://127.0.0.1:3080'), false)
  assert.strictEqual(isExternalUrl('http://localhost:3080'), false)
  assert.strictEqual(isExternalUrl('http://127.0.0.1:3080/'), false)
  assert.strictEqual(isExternalUrl('http://127.0.0.1:3080/?tab=1'), false)
  // Hash routing keeps pathname === '/', so real in-app routes stay internal.
  assert.strictEqual(isExternalUrl('http://127.0.0.1:3080/#/session/abc'), false)
  assert.strictEqual(isExternalUrl('about:blank'), false)
  assert.strictEqual(isExternalUrl('javascript:alert(1)'), false)
  assert.strictEqual(isExternalUrl(''), false)
  assert.strictEqual(isExternalUrl('not a url'), false)

  // Sub-frames belong to the plugin that embedded them, so the shell only
  // expels off-origin content and lets a plugin route its own frame in place.
  // Loopback paths — the sidebar preview's included — are NOT intercepted:
  // hijacking them sent a preview click to the system browser.
  assert.strictEqual(isExternalSubFrameUrl('https://example.com/page'), true)
  assert.strictEqual(isExternalSubFrameUrl('http://192.168.1.10:3080'), true)
  assert.strictEqual(isExternalSubFrameUrl('file:///tmp/x.html'), true)
  assert.strictEqual(isExternalSubFrameUrl('http://127.0.0.1:3080/'), false)
  assert.strictEqual(isExternalSubFrameUrl('http://localhost:3080/preview'), false)
  assert.strictEqual(isExternalSubFrameUrl('http://127.0.0.1:3080/docs/x.html'), false)
  assert.strictEqual(isExternalSubFrameUrl('about:blank'), false)
  assert.strictEqual(isExternalSubFrameUrl(''), false)
  assert.strictEqual(isExternalSubFrameUrl('not a url'), false)

  // `dsh web --no-open` is version-gated: the flag landed at 0.1.1-rc.1 and
  // older artifacts abort the boot on the unknown option, so the shell must
  // pass it only to runtimes that recognize it. An unresolvable version is
  // treated as OLD — guessing new would abort the very boot it is fixing.
  const gated = Object.create(ConnectionManager.prototype)
  assert.strictEqual(gated.supportsNoOpen('0.1.1-rc.2'), true)
  assert.strictEqual(gated.supportsNoOpen('0.1.1-rc.1'), true)
  assert.strictEqual(gated.supportsNoOpen('0.1.1'), true)
  assert.strictEqual(gated.supportsNoOpen('0.2.0'), true)
  assert.strictEqual(gated.supportsNoOpen('0.1.1-rc.0'), false)
  assert.strictEqual(gated.supportsNoOpen('0.1.0-rc.8'), false)
  assert.strictEqual(gated.supportsNoOpen('unknown'), false)
  assert.strictEqual(gated.supportsNoOpen(''), false)
  assert.strictEqual(gated.supportsNoOpen(null), false)
  assert.strictEqual(gated.supportsNoOpen(undefined), false)
  assert.deepStrictEqual(gated.webArgs(0, '0.1.1-rc.2'), ['web', '--port', '0', '--no-open'])
  assert.deepStrictEqual(gated.webArgs(0, '0.1.0-rc.8'), ['web', '--port', '0'])
  assert.deepStrictEqual(gated.webArgs(0, 'unknown'), ['web', '--port', '0'])
  assert.deepStrictEqual(gated.webArgs(3080, '0.1.1-rc.2'), ['web', '--port', '3080', '--no-open'])

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
  // writeRemoteState contract: a successful remote write round-trips the
  // exact state back and returns true; a failed remote command returns
  // false instead of silently leaving a stale state file behind.
  const stateEchoRun = async (_host, command) => {
    if (command.includes('desktop-web.state.json') && command.includes('cat')) {
      return { code: 0, lines: ['{"pid":12345,"port":23456,"version":"npm0.1.1-rc.2"}'] }
    }
    if (command.includes('desktop-web.state.json')) {
      return { code: 0, lines: [] }
    }
    return { code: 0, lines: [] }
  }
  assert.strictEqual(
    await runtimeStore.writeRemoteState(remoteSettings, stateEchoRun, { pid: 12345, port: 23456, version: 'npm0.1.1-rc.2' }),
    true,
  )
  const stateFailRun = async () => ({ code: 1, lines: ['disk full'] })
  assert.strictEqual(
    await runtimeStore.writeRemoteState(remoteSettings, stateFailRun, { pid: 1, port: 2, version: 'v' }),
    false,
  )
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

  // Host inventory: the shell clears every `dsh web` serving its own dsh home
  // before starting a known-good one, so the scan must recognise hosts and
  // their loopback ports, and `processUsesHome` must never claim a host that
  // belongs to somebody else's home. Assertions are shape- and guard-only:
  // whether a host happens to be running depends on the machine.
  const { dshWebProcesses, listeningLoopbackPorts, processUsesHome } = require('../src/connection')
  const bystanderHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bystander-'))
  const scanned = await dshWebProcesses()
  assert.ok(Array.isArray(scanned), 'dshWebProcesses must return an array')
  for (const entry of scanned) {
    assert.ok(Number.isInteger(entry.pid) && entry.pid > 0, 'scanned entry needs a pid')
    assert.ok(entry.bin.includes('bin.js'), 'scanned entry needs the dsh bin')
    const ports = await listeningLoopbackPorts(entry.pid)
    assert.ok(Array.isArray(ports), 'listeningLoopbackPorts must return an array')
    for (const port of ports) {
      assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, `port out of range: ${port}`)
    }
  }
  // The guard that keeps a sweep from killing a bystander's instance: this
  // process holds nothing under a throwaway home, so it must not be claimed.
  assert.strictEqual(
    await processUsesHome(process.pid, bystanderHome),
    false,
    'a host serving a different dsh home must never be swept',
  )
  assert.strictEqual(await processUsesHome(process.pid, ''), true, 'an empty home disables the ownership check')
  fs.rmSync(bystanderHome, { recursive: true, force: true })
  // The same home reached through a symlink must give the same answer: `lsof`
  // reports paths with symlinks resolved (macOS `/tmp` is `/private/tmp`), so
  // if only one side is resolved every host looks like a bystander, the sweep
  // reaps nothing, and an orphan survives to hold the session store — silently.
  const linkTarget = path.join(os.tmpdir(), `dsh-link-target-${process.pid}`)
  const linkPath = path.join(os.tmpdir(), `dsh-link-${process.pid}`)
  fs.mkdirSync(linkTarget, { recursive: true })
  const marker = fs.openSync(path.join(linkTarget, 'marker'), 'w')
  try {
    fs.symlinkSync(linkTarget, linkPath)
    assert.strictEqual(await processUsesHome(process.pid, linkTarget), true, 'a home this process holds a file in is ours')
    assert.strictEqual(
      await processUsesHome(process.pid, linkPath),
      true,
      'the same home reached through a symlink is still ours',
    )
  } finally {
    fs.closeSync(marker)
    fs.rmSync(linkTarget, { recursive: true, force: true })
    try {
      fs.rmSync(linkPath)
    } catch {
      // Already gone.
    }
  }

  // Remote twin of the above: an ssh round-trip costs a full handshake, so a
  // single command returns `pid|files-under-home|port,port` per host and the
  // parsing is a pure function — the part most likely to rot, so it is
  // asserted here with no ssh connection involved.
  const { parseRemoteHostScan, parseRemoteProbe, REMOTE_HOST_SCAN } = require('../src/connection')
  assert.deepStrictEqual(
    parseRemoteHostScan(['3663408|8|35993']),
    [{ pid: 3663408, usesHome: true, ports: [35993] }],
    'a host with files under the home is one we may adopt',
  )
  assert.deepStrictEqual(
    parseRemoteHostScan(['42|0|53100,53101']),
    [{ pid: 42, usesHome: false, ports: [53100, 53101] }],
    'a host outside our dsh home must be marked a bystander',
  )
  assert.deepStrictEqual(
    parseRemoteHostScan(['7|3|']),
    [{ pid: 7, usesHome: true, ports: [] }],
    'a host not listening yet still has to be reaped',
  )
  assert.deepStrictEqual(parseRemoteHostScan(['garbage', '', '|1|80', '0|1|80']), [], 'malformed scan lines are ignored')
  assert.deepStrictEqual(parseRemoteHostScan([]), [], 'an empty scan yields no hosts')
  assert.deepStrictEqual(parseRemoteHostScan(undefined), [], 'a missing scan yields no hosts')
  // A raw string is split into lines. Passing one to a `for..of` over an array
  // would iterate CHARACTER by character and match nothing — and an empty sweep
  // reads as "nothing to reap", leaving an orphan to hold the task-board ledger
  // and crash-loop the next spawn. The failure is silent, so it is asserted.
  assert.deepStrictEqual(
    parseRemoteHostScan('3663408|8|35993\n42|0|53100,53101\n'),
    [{ pid: 3663408, usesHome: true, ports: [35993] }, { pid: 42, usesHome: false, ports: [53100, 53101] }],
    'a raw scan string is split into lines instead of iterated per character',
  )
  assert.deepStrictEqual([...parseRemoteProbe(['35993=1'])], [35993])
  assert.deepStrictEqual([...parseRemoteProbe(['35993=0'])], [], 'a non-dsh listener must not be adopted')
  assert.deepStrictEqual([...parseRemoteProbe(['35993=1', '44571=0', '53100=2'])], [35993, 53100])
  assert.deepStrictEqual([...parseRemoteProbe(['junk', ''])], [])
  assert.deepStrictEqual([...parseRemoteProbe('35993=1\n44571=0\n')], [35993], 'a raw probe string is split into lines too')
  // The scan command itself: `shellQuote` wraps the whole remote command in
  // single quotes, so an unescaped one inside would break it.
  assert.ok(!REMOTE_HOST_SCAN.includes("'"), 'the remote scan must not use single quotes')
  assert.ok(REMOTE_HOST_SCAN.includes('$HOME/.dsh/'), 'the remote scan must confine itself to the remote dsh home')

  // The stray sweep answers exactly one question, and it is the one that rots
  // silently: WHICH hosts to signal. It runs on every HEALTHY connect (the
  // reuse fast path returns before the slow path's full sweep), so a wrong
  // answer means either two hosts left fighting over one session store —
  // measured: they coexist indefinitely — or the service we just validated
  // getting killed. Asserted against stubs: deciding does not need ssh.
  const sweepCases = [
    {
      name: 'a second host sharing our home is killed',
      candidates: [{ pid: 10, usesHome: true, ports: [5110] }, { pid: 20, usesHome: true, ports: [5120] }],
      keepPid: 10,
      expect: [20],
    },
    {
      name: 'the host the state file names is spared',
      candidates: [{ pid: 10, usesHome: true, ports: [5110] }],
      keepPid: 10,
      expect: null,
    },
    {
      name: 'a host serving another dsh home is never touched',
      candidates: [{ pid: 10, usesHome: true, ports: [5110] }, { pid: 30, usesHome: false, ports: [5130] }],
      keepPid: 10,
      expect: null,
    },
    {
      name: 'a home with no spare host yields no round-trip',
      candidates: [],
      keepPid: 10,
      expect: null,
    },
  ]
  for (const sweepCase of sweepCases) {
    let asked = null
    const sweeper = Object.create(ConnectionManager.prototype)
    sweeper.log = () => {}
    sweeper.remoteHostCandidates = async () => sweepCase.candidates
    sweeper.killRemotePids = async (_target, pids) => {
      asked = pids
      return pids
    }
    const killed = await sweeper.reapStrayRemoteHosts({ ssh: { host: 'stub' } }, sweepCase.keepPid)
    assert.deepStrictEqual(asked, sweepCase.expect, sweepCase.name)
    assert.strictEqual(killed, sweepCase.expect === null ? 0 : sweepCase.expect.length, `${sweepCase.name} (count)`)
  }
  // A corrupt state file must not become "kill everything". The arbiter is the
  // recorded pid, so when it is missing or nonsense we cannot tell the hosts
  // apart and must kill none — leaving a stray alive is the survivable error.
  for (const keepPid of [0, -1, null, undefined, '10', 1.5, NaN]) {
    let asked = null
    const sweeper = Object.create(ConnectionManager.prototype)
    sweeper.log = () => {}
    sweeper.remoteHostCandidates = async () => [{ pid: 10, usesHome: true, ports: [5110] }]
    sweeper.killRemotePids = async (_target, pids) => {
      asked = pids
      return pids
    }
    await sweeper.reapStrayRemoteHosts({ ssh: { host: 'stub' } }, keepPid)
    assert.strictEqual(asked, null, `keepPid ${String(keepPid)} must not authorise any kill`)
  }
  // Local twin: sparing a pid can only ever REMOVE a kill, never add one. A
  // home no host serves yields nothing either way.
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-empty-home-${process.pid}-`))
  try {
    const localSweeper = Object.create(ConnectionManager.prototype)
    localSweeper.log = () => {}
    const localSettings = { local: { dshHome: emptyHome } }
    assert.strictEqual(await localSweeper.reapLocalHosts(localSettings), 0, 'a home no host serves yields nothing')
    assert.strictEqual(
      await localSweeper.reapLocalHosts(localSettings, process.pid),
      0,
      'sparing a pid cannot add a kill',
    )
  } finally {
    fs.rmSync(emptyHome, { recursive: true, force: true })
  }

  // ── local watchParent family: guard wrapper + real service, one group ──
  // Regression (local twin of the reapStrayRemoteHosts bug): spawnLocalService
  // launches dsh web through a watchParent guard shell, so the state file used
  // to record the WRAPPER pid while the sweep exempted only that wrapper — the
  // reuse path then KILLED the real service it had just validated ("清理多余
  // dsh web" naming the very port it reused). The fix has three legs, all
  // asserted here against REAL processes: the guard announces the service pid,
  // the sweep exempts the keepPid's whole process GROUP (covers state files in
  // both the old wrapper-pid and new service-pid formats), and wrappers are
  // never host candidates (a full sweep kills exactly the one real host).
  const alive = pid => {
    try { process.kill(pid, 0); return true } catch { return false }
  }
  const familyHome = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-family-home-${process.pid}-`))
  const fakeBin = path.join(familyHome, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  fs.mkdirSync(path.dirname(fakeBin), { recursive: true })
  // The fake host must LOOK like a real one to `processUsesHome`: a real dsh
  // web holds files open under its dsh home (settings, session store), which
  // is what separates hosts sharing one runtime install. cwd alone does not
  // match — the check compares against `home + '/'`, so a cwd that IS the
  // home is not enough. Hold a marker file open under the home.
  fs.writeFileSync(fakeBin, [
    'const fs = require("node:fs")',
    'fs.openSync(__dirname + "/../../../../session-store.marker", "a")',
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n'))
  let familySpawn = null
  try {
    let servicePid = null
    familySpawn = spawnService({
      cmd: process.execPath,
      args: [fakeBin, 'web', '--port', '0'],
      cwd: familyHome,
      onLine: line => {
        if (line.startsWith(SERVICE_PID_PREFIX)) servicePid = Number(line.slice(SERVICE_PID_PREFIX.length))
      },
      watchParent: true,
    })
    const familySweeper = Object.create(ConnectionManager.prototype)
    familySweeper.log = () => {}
    const familySettings = { local: { dshHome: familyHome } }
    const deadline = Date.now() + 10_000
    while (servicePid === null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(Number.isInteger(servicePid) && servicePid > 0, 'guard must announce the real service pid')
    assert.notStrictEqual(servicePid, familySpawn.child.pid, 'announced pid is the SERVICE, not the wrapper')
    assert.ok(alive(servicePid), 'announced service pid is alive')

    assert.strictEqual(
      await familySweeper.reapLocalHosts(familySettings, familySpawn.child.pid),
      0,
      'OLD-format state (wrapper pid) must spare the service — same group',
    )
    assert.ok(alive(servicePid), 'service survives a wrapper-pid keepPid sweep')
    assert.strictEqual(
      await familySweeper.reapLocalHosts(familySettings, servicePid),
      0,
      'NEW-format state (service pid) must spare the service',
    )
    assert.ok(alive(servicePid), 'service survives a service-pid keepPid sweep')

    // Register the close listener BEFORE the kill: the wrapper can exit (and
    // emit its one close event) while the sweep+sleep below runs, and a
    // listener attached after that fires never will.
    const wrapperClosed = new Promise(resolve => {
      familySpawn.child.once('close', () => resolve('closed'))
    })
    assert.strictEqual(
      await familySweeper.reapLocalHosts(familySettings),
      1,
      'full sweep kills exactly the one real host (the wrapper is not a host candidate)',
    )
    await new Promise(resolve => setTimeout(resolve, 2000))
    assert.ok(!alive(servicePid), 'full sweep killed the real service')
    const wrapperEnd = await Promise.race([
      wrapperClosed,
      new Promise(resolve => setTimeout(() => resolve('timeout'), 8000)),
    ])
    assert.strictEqual(wrapperEnd, 'closed', 'wrapper exits once its service is gone')
  } finally {
    if (familySpawn !== null) familySpawn.stop()
    fs.rmSync(familyHome, { recursive: true, force: true })
  }

  // Following a peer shell that is mid-startup: this is what stops two shells
  // from ping-ponging (each sweeping the host the other just spawned). The
  // grace period must follow a host that becomes healthy, and must refuse
  // anything whose recorded version is not ours.
  const peerWait = new ConnectionManager({ getSettings: () => ({}), onLog: () => {} })
  let peerReads = 0
  assert.deepStrictEqual(
    await peerWait.awaitPeerService({
      version: 'v2',
      attempts: 5,
      intervalMs: 1,
      readState: async () => {
        peerReads += 1
        return peerReads < 3 ? { pid: 1, port: 56000, version: 'v2' } : { pid: 2, port: 41451, version: 'v2' }
      },
      probePort: async port => port === 41451,
    }),
    { pid: 2, port: 41451, version: 'v2' },
    'a peer that finishes starting within the grace period is followed',
  )
  assert.strictEqual(peerReads, 3, 'following must stop polling as soon as a healthy peer appears')
  assert.strictEqual(
    await peerWait.awaitPeerService({
      version: 'v2',
      attempts: 3,
      intervalMs: 1,
      readState: async () => ({ pid: 1, port: 41451, version: 'v1' }),
      probePort: async () => true,
    }),
    null,
    'a host recorded against another version must never be followed — it is the old runtime',
  )
  assert.strictEqual(
    await peerWait.awaitPeerService({
      version: 'v2',
      attempts: 3,
      intervalMs: 1,
      readState: async () => { throw new Error('ssh down') },
      probePort: async () => true,
    }),
    null,
    'a failing state read must not break the connect',
  )
  assert.strictEqual(
    await peerWait.awaitPeerService({
      version: 'v2',
      attempts: 3,
      intervalMs: 1,
      readState: async () => null,
      probePort: async () => true,
    }),
    null,
    'no peer at all falls through to a clean restart',
  )
  // Regression for "readState(...).catch is not a function": the LOCAL caller
  // passes runtimeStore.readLocalState, a plain sync fs.readFileSync wrapper
  // whose return is a state object or null — NOT a Promise. Every awaitPeerService
  // assertion above uses an async mock, which is exactly how this shipped.
  let syncPeerReads = 0
  assert.deepStrictEqual(
    await peerWait.awaitPeerService({
      version: 'v2',
      attempts: 3,
      intervalMs: 1,
      readState: () => {
        syncPeerReads += 1
        return syncPeerReads < 2 ? null : { pid: 9, port: 41452, version: 'v2' }
      },
      probePort: async port => port === 41452,
    }),
    { pid: 9, port: 41452, version: 'v2' },
    'a SYNC readState (local state file) is followed just the same',
  )
  assert.strictEqual(
    await peerWait.awaitPeerService({
      version: 'v2',
      attempts: 2,
      intervalMs: 1,
      readState: () => null,
      probePort: async () => true,
    }),
    null,
    'a SYNC readState with no state falls through without throwing',
  )
  assert.strictEqual(
    await peerWait.awaitPeerService({
      version: 'v2',
      attempts: 2,
      intervalMs: 1,
      readState: () => { throw new Error('sync read blew up') },
      probePort: async () => true,
    }),
    null,
    'a SYNC readState that throws must not break the connect either',
  )

  // Local `--port 0`: the shell adopts the OS-chosen port from stdout.
  // This needs a BUILT local checkout (deepseek-harness/); on CI the
  // checkout is absent (it is gitignored), so skip instead of failing —
  // live service launching is covered by scripts/e2e-local.js.
  const repoDir = path.resolve(__dirname, '..', 'deepseek-harness')
  const portZeroHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-port-zero-'))
  const portZeroSettings = { mode: 'local', local: { repoDir, repoUrl: '', dshHome: portZeroHome, port: 3080 }, ssh: {} }
  const portZeroLogs = []
  if (require('../src/runtime-layout').runtimeLayout(repoDir) !== null) {
    const portZeroConnection = new ConnectionManager({
      getSettings: () => portZeroSettings,
      onLog: line => portZeroLogs.push(line),
    })
    const portZeroTools = resolveTools({
      local: { repoDir, repoUrl: '' },
      toolPaths: { node: '', git: '', pnpm: '', shell: '/bin/zsh' },
    })
    portZeroConnection.resolvedTools = () => portZeroTools
    let spawnError = null
    try {
      await portZeroConnection.spawnLocalService(portZeroSettings, 0, 'smoke-port-zero')
    } catch (error) {
      spawnError = error
    }
    if (spawnError === null) {
      assert.ok(portZeroConnection.localPort > 0, 'expected an OS-chosen local port')
    } else {
      // A dsh home created seconds ago has no plugins installed, so `dsh web`
      // dies inside the loader. That is a gap in the test fixture, not a shell
      // regression — but any OTHER failure must still fail the suite.
      const pluginsMissing = portZeroLogs.some(
        line => line.includes('ERR_MODULE_NOT_FOUND') || line.includes('Cannot find package'),
      )
      if (!pluginsMissing) throw spawnError
      console.log('SKIP: --port 0 live-service check (fixture dsh home has no plugins installed)')
    }
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
  // cancellation token round-trip
  assert.strictEqual(runtimeStore.readCancelToken(homeSettings), null)
  assert.strictEqual(runtimeStore.writeCancelToken(homeSettings, { reason: '用户取消了更新' }), true)
  assert.ok(runtimeStore.readCancelToken(homeSettings) !== null)
  runtimeStore.clearCancelToken(homeSettings)
  assert.strictEqual(runtimeStore.readCancelToken(homeSettings), null)
  // `shouldAbort` cancels a lock wait BEFORE the lock is acquired.
  let abortLockRuns = 0
  await assert.rejects(
    runtimeStore.withLocalLock(homeSettings, 'smoke-abort-lock', async () => { abortLockRuns += 1 }, { shouldAbort: () => true }),
    error => error.code === 'CANCELLED',
  )
  assert.strictEqual(abortLockRuns, 0)
  // TOCTOU regression: after the cancel helper eagerly releases the lock and
  // a NEW owner (another process — the exact race locks exist to prevent)
  // has acquired it, the old owner's guard finally must NOT delete the new
  // owner's lock. Recreate the interleaving: acquire → release eagerly →
  // a foreign-pid owner takes the lock → first holder's task returns and its
  // finally runs → the foreign lock survives.
  let releaseDuringTask = false
  await runtimeStore.withLocalLock(homeSettings, 'smoke-toctou', async () => {
    releaseDuringTask = true
    runtimeStore.releaseLocalLockIfOwned(homeSettings, 'smoke-toctou', process.pid)
    // Simulate the next owner from another shell/worker process taking the
    // lock while this task is still unwinding.
    const lockDir = path.join(runtimeStore.expandHome(homeSettings.local.dshHome), 'locks', 'smoke-toctou')
    fs.mkdirSync(lockDir)
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 424242, createdAt: new Date().toISOString() }))
  })
  assert.strictEqual(releaseDuringTask, true)
  {
    const lockDir = path.join(runtimeStore.expandHome(homeSettings.local.dshHome), 'locks', 'smoke-toctou')
    assert.ok(fs.existsSync(lockDir), 'the foreign owner lock must survive the old owner finally')
    fs.rmSync(lockDir, { recursive: true, force: true })
  }
  fs.rmSync(layoutDir, { recursive: true, force: true })

  // cooperative cancellation: `runCommand`'s shouldAbort kills the group and
  // resolves with `aborted: true` instead of hanging for the full timeout.
  let abortAt = 0
  const abortable = await runCommand({
    cmd: '/bin/sleep',
    args: ['30'],
    shouldAbort: () => (abortAt += 1) > 2,
  })
  assert.strictEqual(abortable.aborted, true)
  assert.ok(abortable.signal !== null || abortable.code !== null, 'aborted child must have exited')

  // Updater cancel contract: requestCancel flips the intent immediately and
  // awaitCancelled settles once the pipeline is done; a cancelled pipeline
  // reports { ok:false, cancelled:true } and never touches the runtime.
  const { Updater } = require('../src/update')
  const cancelHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cancel-'))
  const cancelCalls = []
  const cancelUpdater = new Updater({
    getSettings: () => ({ mode: 'local', local: { repoDir: '', repoUrl: '', dshHome: cancelHome }, ssh: {} }),
    connection: {
      owner: () => 'smoke-cancel-owner',
      resolvedTools: () => resolveTools({ local: { repoDir: '', repoUrl: '' }, toolPaths: { node: '', git: '', pnpm: '', shell: '/bin/zsh' } }),
      remoteRun: async () => ({ code: 0, lines: [] }),
      restartService: async () => { cancelCalls.push('restart') },
    },
    onLine: () => {},
    onBusyChange: () => {},
  })
  // The artifact pipeline's first step is the registry query; short-circuit
  // it so the smoke never touches the network.
  cancelUpdater.queryArtifact = async () => ({ ok: false, version: '', reason: 'offline smoke' })
  const cancelPipeline = cancelUpdater.runPipeline()
  assert.strictEqual(cancelUpdater.busy, true)
  cancelUpdater.requestCancel('用户取消了更新')
  assert.strictEqual(cancelUpdater.isCancelling(), true)
  const cancelOutcome = await cancelPipeline
  assert.strictEqual(cancelOutcome.ok, false)
  assert.strictEqual(cancelOutcome.cancelled, true)
  assert.strictEqual(cancelUpdater.busy, false)
  assert.strictEqual(cancelUpdater.isCancelling(), false)
  assert.deepStrictEqual(cancelCalls, [], 'a cancelled pipeline must never restart the service')
  fs.rmSync(cancelHome, { recursive: true, force: true })

  // artifact preference: SSH-remote with the official repo URL prefers the
  // prebuilt npm artifact too (no remote compilation); forks stay source.
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
