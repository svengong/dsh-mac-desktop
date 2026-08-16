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
const {
  compareVersions, hashTreeSync, isNewerVersion, versionOf,
} = require('../src/components')
const { UpdateManager, workspacePatchScript } = require('../src/update-manager')
const { parseTarget, shellQuote, remotePath, tunnelArgs, parseSshConfig, listSshHosts } = require('../src/ssh')
const { runCommand } = require('../src/runner')
const { ConnectionManager } = require('../src/connection')
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
  assert.ok(defaultLocal.local.repoDir.endsWith(`desktop-shell${path.sep}deepseek-harness`), defaultLocal.local.repoDir)
  const migrated = normalizeSettings({ mode: 'ssh', ssh: { target: 'legacy-host' } })
  assert.strictEqual(migrated.ssh.host, 'legacy-host')
  assert.strictEqual(migrated.activeDeviceId, 'ssh:legacy-host')

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

  // update section normalization: the harness row always exists, legacy
  // override-only built-in entries without a kind are dropped, full
  // user-defined plugin/preset entries are preserved, and defaults stay sane.
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
  assert.strictEqual(withUpdates.update.components.length, 4)
  assert.strictEqual(withUpdates.update.components[0].enabled, false)
  assert.strictEqual(withUpdates.update.components[1].id, 'anchored-standard')
  assert.strictEqual(withUpdates.update.components[1].repoUrl, 'https://example.com/preset.git')
  assert.strictEqual(withUpdates.update.components[1].enabled, false)
  assert.strictEqual(withUpdates.update.components[2].id, 'custom-npm')
  assert.strictEqual(withUpdates.update.components[2].packageName, 'dsh-custom')
  assert.strictEqual(withUpdates.update.components[3].id, 'custom-preset')
  assert.strictEqual(withUpdates.update.components[3].checkoutDir, '~/OpenSoft/custom-preset')
  assert.strictEqual(withUpdates.update.components[3].title, 'custom')
  assert.ok(withUpdates.update.components.some(item => item.id === 'better-sidebar') === false)
  assert.ok(withUpdates.update.components.some(item => item.id === 'unknown') === false)
  assert.ok(withUpdates.update.components.some(item => item.id === 'bad-script') === false)

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

  // local repo readiness: an existing git repo passes; a missing dir without
  // a repo URL fails with the guidance message.
  const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-git-repo-'))
  const gitInit = await runCommand({ cmd: '/usr/bin/git', args: ['init', '-q'], cwd: gitDir })
  assert.strictEqual(gitInit.code, 0)
  const settings = { mode: 'local', local: { repoDir: gitDir, repoUrl: '', port: 3080 }, ssh: {} }
  const connection = new ConnectionManager({ getSettings: () => settings })
  assert.strictEqual((await connection.ensureLocalRepo(settings)).code, 0)
  const missingDir = path.join(gitDir, 'not-there')
  const missingSettings = { mode: 'local', local: { repoDir: missingDir, repoUrl: '', port: 3080 }, ssh: {} }
  const missingConnection = new ConnectionManager({ getSettings: () => missingSettings })
  let thrown = ''
  try {
    await missingConnection.ensureLocalRepo(missingSettings)
  } catch (error) {
    thrown = String(error.message)
  }
  assert.ok(thrown.includes('仓库地址'), `expected repo-url guidance, got: ${thrown}`)
  fs.rmSync(gitDir, { recursive: true, force: true })

  // tools: engine filter + a pnpm that actually runs under the clean env
  assert.strictEqual(engineOk('v23.11.0'), false)
  assert.strictEqual(engineOk('v22.19.0'), true)
  assert.strictEqual(engineOk('v24.16.0'), true)
  const tools = resolveTools({ local: { repoDir: '', repoUrl: '' }, toolPaths: { node: '', git: '', pnpm: '', shell: '/bin/zsh' } })
  assert.ok(tools.node !== '', 'node not resolved')
  assert.ok(tools.pnpm !== '', 'pnpm not resolved')
  const pnpmRun = await runCommand({ cmd: tools.pnpm, args: [...tools.pnpmPrefix, '--version'], env: tools.env })
  assert.strictEqual(pnpmRun.code, 0, `pnpm not runnable under clean env: ${pnpmRun.lines.join('\n')}`)

  // preset fingerprinting: same content hashes equal; one byte differs
  const treeA = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tree-a-'))
  const treeB = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tree-b-'))
  fs.writeFileSync(path.join(treeA, 'preset.yml'), 'name: a\n')
  fs.writeFileSync(path.join(treeB, 'preset.yml'), 'name: a\n')
  assert.strictEqual(hashTreeSync(treeA), hashTreeSync(treeB))
  fs.writeFileSync(path.join(treeB, 'preset.yml'), 'name: b\n')
  assert.notStrictEqual(hashTreeSync(treeA), hashTreeSync(treeB))
  fs.rmSync(treeA, { recursive: true, force: true })
  fs.rmSync(treeB, { recursive: true, force: true })

  // better-sidebar workspace patch: creates the official allowBuilds +
  // minimumReleaseAgeExclude entries and is idempotent.
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-'))
  const workspaceFile = path.join(profileDir, 'pnpm-workspace.yaml')
  fs.writeFileSync(workspaceFile, 'packages:\n  - .\n')
  const patchNode = (await resolveTools({ local: { repoDir: '', repoUrl: '' }, toolPaths: { node: '', git: '', pnpm: '', shell: '/bin/zsh' } })).node
  let patch = await runCommand({ cmd: patchNode, args: ['-e', workspacePatchScript(), workspaceFile] })
  assert.strictEqual(patch.code, 0, `workspace patch failed: ${patch.lines.join('\n')}`)
  assert.strictEqual(patch.lines[0], 'updated')
  const patched = fs.readFileSync(workspaceFile, 'utf8')
  assert.ok(patched.includes('allowBuilds:') && patched.includes('node-pty: true'))
  assert.ok(patched.includes('minimumReleaseAgeExclude:') && patched.includes('- dsh-better-sidebar'))
  patch = await runCommand({ cmd: patchNode, args: ['-e', workspacePatchScript(), workspaceFile] })
  assert.strictEqual(patch.lines[0], 'unchanged')
  fs.rmSync(profileDir, { recursive: true, force: true })

  // update manager snapshot: harness row first, valid persisted components
  // follow (full built-in-style entries included), kind-less entries are
  // dropped, no network calls.
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
  assert.strictEqual(snapshot.components.length, 3)
  assert.strictEqual(snapshot.components[0].id, 'harness')
  assert.strictEqual(snapshot.components[1].id, 'better-sidebar')
  assert.strictEqual(snapshot.components[1].packageName, 'dsh-better-sidebar')
  assert.strictEqual(snapshot.components[2].id, 'custom-npm')
  assert.strictEqual(snapshot.components[2].packageName, 'dsh-custom')
  assert.ok(snapshot.components.some(row => row.id === 'anchored-standard') === false)
  assert.strictEqual(snapshot.autoCheckOnLaunch, true)

  // preset checkout dirs are mode-specific: ssh mode maps an accidental
  // local-home absolute path back to `~/...` and keeps `~/` remote paths.
  const sshManager = new UpdateManager({
    getSettings: () => normalizeSettings({ mode: 'ssh', ssh: { host: 'dev' } }),
    saveUpdate: () => {},
    connection: { resolvedTools: () => resolveTools({ local: { repoDir: '', repoUrl: '' }, toolPaths: { node: '', git: '', pnpm: '', shell: '/bin/zsh' } }) },
    harnessUpdater: { check: async () => ({ gitRepo: false, branch: '', upstream: '', ahead: 0, behind: 0, dirty: false, summary: 'not a repo' }) },
    onLog: () => {},
    onState: () => {},
  })
  const legacyCheckout = `${os.homedir()}${path.sep}OpenSoft${path.sep}dsh-anchored-standard`
  assert.strictEqual(sshManager.presetCheckoutDir({ id: 'anchored-standard', checkoutDir: legacyCheckout }), '~/OpenSoft/dsh-anchored-standard')
  assert.strictEqual(sshManager.presetCheckoutDir({ id: 'anchored-standard', checkoutDir: '' }), '~/OpenSoft/anchored-standard')
  assert.strictEqual(sshManager.presetCheckoutDir({ id: 'anchored-standard', checkoutDir: '~/OpenSoft/anchored-standard' }), '~/OpenSoft/anchored-standard')
  assert.strictEqual(sshManager.presetCheckoutDir({ id: 'anchored-standard', checkoutDir: '/home/sven/src' }), '/home/sven/src')

  // ssh preset comparison must wrap each raw remote path exactly once; the
  // previous double-wrap made diff look for a literal `"$HOME"` path and exit 2.
  const diffCalls = []
  const fakeRemote = {
    resolvedTools: () => resolveTools({ local: { repoDir: '', repoUrl: '' }, toolPaths: { node: '', git: '', pnpm: '', shell: '/bin/zsh' } }),
    async remoteRun(host, command) {
      diffCalls.push(command)
      if (command.includes('--is-inside-work-tree')) return { code: 0, lines: ['true'] }
      if (command.includes('fetch') && command.includes('--quiet')) return { code: 0, lines: [] }
      if (command.includes('--abbrev-ref') && command.includes('HEAD')) return { code: 0, lines: ['main'] }
      if (command.includes('--symbolic-full-name')) return { code: 0, lines: ['origin/main'] }
      if (command.includes('--porcelain')) return { code: 0, lines: [] }
      if (command.includes('--left-right')) return { code: 0, lines: ['0\t0'] }
      if (command.includes('diff -qr')) return { code: 0, lines: ['0'] }
      throw new Error(`unexpected remote command: ${command}`)
    },
  }
  const presetCheckManager = new UpdateManager({
    getSettings: () => normalizeSettings({
      mode: 'ssh',
      ssh: { host: 'dev' },
      update: { components: [
        { id: 'remote-preset', kind: 'git-preset', repoUrl: 'https://example.com/preset.git', checkoutDir: '~/OpenSoft/preset', sourceDir: 'preset', presetId: 'preset-id' },
      ] },
    }),
    saveUpdate: () => {},
    connection: fakeRemote,
    harnessUpdater: { check: async () => ({ gitRepo: false, branch: '', upstream: '', ahead: 0, behind: 0, dirty: false, summary: 'not a repo' }) },
    onLog: () => {},
    onState: () => {},
  })
  await presetCheckManager.checkPresetComponent(presetCheckManager.component('remote-preset'))
  const diffCommand = diffCalls.find(command => command.includes('diff -qr'))
  assert.ok(diffCommand !== undefined, 'diff command missing')
  assert.ok(diffCommand.includes(`diff -qr "$HOME"/'OpenSoft/preset/preset' "$HOME"/'.dsh/.agent-presets/preset-id'`), diffCommand)
  assert.ok(diffCommand.includes(`'\"$HOME\"'`) === false, `double-wrapped diff target: ${diffCommand}`)

  // port fallback: a busy port yields the next free one
  const blocker = net.createServer()
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve))
  const busyPort = blocker.address().port
  const fallbackConnection = new ConnectionManager({
    getSettings: () => ({ mode: 'local', local: { port: busyPort, repoDir: '', repoUrl: '' }, ssh: {} }),
  })
  const freePort = await fallbackConnection.findFreePort(busyPort)
  assert.ok(freePort > busyPort, `expected a port above ${busyPort}, got ${freePort}`)
  blocker.close()

  console.log('smoke: all checks passed')
}

main().catch(error => {
  console.error(`smoke failed: ${error.message}`)
  process.exit(1)
})
