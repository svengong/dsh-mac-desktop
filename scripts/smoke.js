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
const http = require('node:http')
const path = require('node:path')
const { normalizeSettings, defaultDshHome, DEV_DEFAULT_DSH_HOME, PACKAGED_DEFAULT_DSH_HOME } = require('../src/settings')
const { terminalLabel, terminalPrefix } = require('../src/labels')
const {
  compareVersions, isNewerVersion, versionOf, versionToken,
} = require('../src/components')
const { resolveChannelVersion, notargetPackage } = require('../src/artifact')
const { UpdateManager } = require('../src/update-manager')
const { parseTarget, shellQuote, remotePath, tunnelArgs, parseSshConfig, listSshHosts } = require('../src/ssh')
const { runCommand, spawnService, killActiveChildren, SERVICE_PID_PREFIX } = require('../src/runner')
const { ConnectionManager, rehostUrl, probeOnce } = require('../src/connection')
const { processUsesHome } = require('../src/process-scan')
const { findFreePort, releasePort, reservePort } = require('../src/ports')
const runtimeStore = require('../src/runtime-store')
const { WindowManager } = require('../src/window-manager')
const { mergeUpdates } = require('../src/device-merge')
const { resolveTools, engineOk } = require('../src/tools')
const { presentWindow, focusViewInKeyWindow } = require('../src/windows')
const { isExternalUrl, isExternalSubFrameUrl } = require('../src/external-open')
const { BOOT_FAILURE_PROBE, shouldReloadAfterBootFailure } = require('../src/boot-watch')
const {
  IS_WINDOWS, cmdQuote, expandHome, extractNodeArchive, isPidAlive, killTree,
  nodeDistArchive, spawnInvocation, swapCurrentLink, executableNames, npmFor, sshConfigPath,
} = require('../src/platform')
const {
  parseNetstatListeners, parseWindowsProcessList, isLoopbackAddress, psQuote,
  windowsProcessUsesHome, posixProcessLines, dshWebProcesses,
  processChildren, processGroupMembers, serviceFamily, commandMentionsPath,
  windowsHostBin,
} = require('../src/process-scan')

/**
 * A portable "sleep" for tests. `/bin/sleep` and `/bin/echo` do not exist on
 * Windows, so every child-process test uses THIS process's own node with a
 * tiny inline script — one code path, both platforms.
 * @param {string} body - JS source for the child.
 * @param {string[]} [args]
 */
function nodeChild(body, args = []) {
  return { cmd: process.execPath, args: ['-e', body, ...args] }
}

/** `echo` equivalent that works everywhere. */
function echoCommand(text) {
  return { cmd: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1] + "\\n")', text] }
}

/** `sleep <seconds>` equivalent that works everywhere. */
function sleepCommand(seconds) {
  return nodeChild(`setTimeout(() => {}, ${Number(seconds) * 1000})`)
}

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
  // Data-home default is build-kind specific: an installed app must land on
  // the official `~/.dsh`; only development runs stay on `~/.dsh-dev`.
  assert.strictEqual(PACKAGED_DEFAULT_DSH_HOME, '~/.dsh')
  assert.strictEqual(DEV_DEFAULT_DSH_HOME, '~/.dsh-dev')
  assert.strictEqual(defaultDshHome(true), '~/.dsh')
  assert.strictEqual(defaultDshHome(false), '~/.dsh-dev')
  // This suite runs under plain node, i.e. the development default.
  assert.strictEqual(defaultLocal.local.dshHome, '~/.dsh-dev')
  assert.strictEqual(normalizeSettings({ local: { dshHome: '~/custom' } }).local.dshHome, '~/custom')
  assert.strictEqual(terminalLabel(defaultLocal), '本地')
  assert.strictEqual(terminalPrefix(defaultLocal), 'DSH-[本地]')
  assert.strictEqual(terminalLabel({ mode: 'ssh', ssh: { host: 'ubuntu' } }), 'ubuntu')
  assert.strictEqual(terminalLabel({ mode: 'ssh', ssh: { host: 'dev@10.0.0.8:22' } }), '10.0.0.8')
  const migrated = normalizeSettings({ mode: 'ssh', ssh: { target: 'legacy-host' } })
  assert.strictEqual(migrated.ssh.host, 'legacy-host')
  assert.strictEqual(migrated.activeDeviceId, 'ssh:legacy-host')

  // The release surface is deliberately narrow: macOS arm64 only, Windows
  // NSIS setup for x64 + arm64, Android arm64. Asserting it here keeps a
  // future edit from quietly re-adding a target nobody downloads (or, worse,
  // dropping one that is published).
  {
    const pkg = require('../package.json')
    const winTargets = pkg.build.win.target
    assert.deepStrictEqual(
      winTargets, [{ target: 'nsis', arch: ['x64', 'arm64'] }],
      'Windows must ship NSIS setup only, for x64 and arm64',
    )
    const macTargets = pkg.build.mac.target
    const macNames = macTargets.map(t => (typeof t === 'string' ? t : t.target)).sort()
    assert.deepStrictEqual(macNames, ['dmg'], 'macOS ships the dmg installer only')
    for (const t of macTargets) {
      if (typeof t === 'object' && t.arch !== undefined) {
        assert.deepStrictEqual(t.arch, ['arm64'], `macOS ${t.target} must be arm64 only`)
      }
    }
    // No zip on any platform: one installable artifact per arch.
    assert.deepStrictEqual(
      winTargets.filter(t => /zip|portable/i.test(t.target)), [],
      'Windows must not ship a zip or portable build',
    )
    assert.strictEqual(pkg.build.linux, undefined, 'Linux is no longer published')
    assert.strictEqual(pkg.build.appImage, undefined, 'Linux is no longer published')
    assert.strictEqual(pkg.build.deb, undefined, 'Linux is no longer published')
    for (const script of ['dist:linux', 'dist:linux:x64', 'dist:linux:arm64', 'dist:publish:linux']) {
      assert.strictEqual(pkg.scripts[script], undefined, `${script} must be gone with Linux`)
    }
  }

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

  // prerelease ordering: the whole point of the alpha channel. A plain
  // string compare ranks alpha.3 BELOW rc.2 and alpha.10 below alpha.9,
  // which is what hid published alphas from the check.
  assert.strictEqual(compareVersions('0.1.2-alpha.1', '0.1.1-rc.2'), 1)
  assert.strictEqual(compareVersions('0.1.2', '0.1.2-alpha.3'), 1)
  assert.strictEqual(compareVersions('0.1.2-alpha.10', '0.1.2-alpha.9'), 1)
  assert.strictEqual(compareVersions('0.1.2-alpha.2', '0.1.2-alpha.10'), -1)
  assert.strictEqual(compareVersions('0.1.2-alpha', '0.1.2-alpha.1'), -1)
  assert.strictEqual(compareVersions('0.1.2-beta', '0.1.2-alpha'), 1)
  assert.strictEqual(compareVersions('0.1.2-alpha.1', '0.1.2-alpha.1'), 0)
  assert.strictEqual(compareVersions('v0.1.2-alpha.3', '0.1.2-alpha.3'), 0)
  // The prerelease tail must survive normalization: two alphas of one core
  // version differ ONLY there.
  assert.strictEqual(versionToken('v0.1.2-alpha.3'), '0.1.2-alpha.3')
  assert.strictEqual(versionToken('^0.12.1'), '0.12.1')
  assert.strictEqual(versionToken('latest'), '')
  assert.strictEqual(isNewerVersion('0.1.2-alpha.3', '0.1.2-alpha.2'), true)
  assert.strictEqual(isNewerVersion('0.1.2-alpha.3', '0.1.2-alpha.3'), false)
  assert.strictEqual(isNewerVersion('0.1.1-rc.2', '0.1.2-alpha.3'), false)

  // There is no user-selectable channel: the update section must not carry
  // one, and the shell always tracks the NEWEST release across all tags.
  assert.strictEqual(normalizeSettings({ update: { channel: 'alpha' } }).update.channel, undefined)
  assert.strictEqual(normalizeSettings(null).update.channel, undefined)

  // newest-tag resolution: the registry publishes alpha AHEAD of latest, and
  // the newest real release must win regardless of which tag carries it.
  const tags = { latest: '0.1.1-rc.2', next: '0.1.1-rc.2', alpha: '0.1.2-alpha.3' }
  const newest = resolveChannelVersion(tags)
  assert.strictEqual(newest.version, '0.1.2-alpha.3')
  assert.strictEqual(newest.channel, 'alpha')
  assert.ok(newest.note.includes('alpha'))
  // Only a stable tag: it wins, and reads as an ordinary version (no note).
  const stable = resolveChannelVersion({ latest: '0.2.0' })
  assert.strictEqual(stable.version, '0.2.0')
  assert.strictEqual(stable.channel, 'latest')
  assert.strictEqual(stable.note, '')
  // The highest tag wins even when it is not `latest` and not `alpha`.
  const beta = resolveChannelVersion({ latest: '0.1.0', beta: '0.3.0' })
  assert.strictEqual(beta.version, '0.3.0')
  assert.strictEqual(beta.channel, 'beta')
  // Stable outranking a pre-release keeps the stable one.
  const ahead = resolveChannelVersion({ latest: '0.2.0', alpha: '0.1.2-alpha.3' })
  assert.strictEqual(ahead.version, '0.2.0')
  assert.strictEqual(ahead.channel, 'latest')
  assert.strictEqual(ahead.note, '')
  // Untracked tags (canary/dev) are ignored, never followed.
  const untracked = resolveChannelVersion({ latest: '0.1.0', canary: '9.9.9' })
  assert.strictEqual(untracked.version, '0.1.0')
  assert.strictEqual(untracked.channel, 'latest')
  // No tracked tag at all is the one hard failure.
  assert.strictEqual(resolveChannelVersion({}).ok, false)
  assert.strictEqual(resolveChannelVersion({ canary: '9.9.9' }).ok, false)

  // An npm ETARGET names the package whose version the registry failed to
  // report; the retry purges exactly that package's cached packument.
  assert.strictEqual(
    notargetPackage('npm error notarget No matching version found for @deepseek-ai/dsh-base@^0.1.2-alpha.4.'),
    '@deepseek-ai/dsh-base',
  )
  assert.strictEqual(
    notargetPackage('No matching version found for @deepseek-ai/dsh-session-persistence-jsonl@^0.1.2-alpha.4'),
    '@deepseek-ai/dsh-session-persistence-jsonl',
  )
  assert.strictEqual(notargetPackage('npm error notarget No matching version found for left-pad@1.2.3'), 'left-pad')
  assert.strictEqual(notargetPackage('npm error code ECONNRESET'), '')
  assert.strictEqual(notargetPackage(''), '')

  // A `dsh web` token URL survives being re-hosted onto another loopback
  // port — that is what lets an ssh device use the remote token on the local
  // end of its tunnel.
  assert.strictEqual(
    rehostUrl('http://127.0.0.1:3080/?token=abc-123', 45711),
    'http://127.0.0.1:45711/?token=abc-123',
  )
  // A remote host announcing itself on a non-loopback name still lands on
  // loopback, since the browser only ever reaches the forwarded port.
  assert.strictEqual(rehostUrl('http://localhost:3080/?token=z', 45711), 'http://127.0.0.1:45711/?token=z')
  assert.strictEqual(rehostUrl('', 45711), '')
  assert.strictEqual(rehostUrl('not a url', 45711), '')
  assert.strictEqual(rehostUrl('http://127.0.0.1:3080/?token=z', 0), '')

  // url() hands out the launch-token URL only while it belongs to the service
  // actually serving: a restart moves the service to a new OS-chosen port, and
  // a dead service's token must never be presented to whatever owns that port
  // now.
  const shellFor = mode => new ConnectionManager({
    getSettings: () => (mode === 'ssh'
      ? normalizeSettings({ mode: 'ssh', ssh: { host: 'h', localPort: 3080 } })
      : normalizeSettings({ mode: 'local', local: { port: 3080 } })),
  })
  const localShell = shellFor('local')
  localShell.localPort = null
  assert.strictEqual(localShell.url(), 'http://127.0.0.1:3080')
  localShell.localPort = 5000
  assert.strictEqual(localShell.url(), 'http://127.0.0.1:5000')
  localShell.localWebUrl = 'http://127.0.0.1:5000/?token=abc'
  assert.strictEqual(localShell.url(), 'http://127.0.0.1:5000/?token=abc')
  localShell.localPort = 5100
  assert.strictEqual(localShell.url(), 'http://127.0.0.1:5100')

  const sshShell = shellFor('ssh')
  sshShell.localPort = 6000
  sshShell.remoteWebUrl = 'http://127.0.0.1:6000/?token=remote-xyz'
  assert.strictEqual(sshShell.url(), 'http://127.0.0.1:6000/?token=remote-xyz')
  sshShell.localPort = 6100
  assert.strictEqual(sshShell.url(), 'http://127.0.0.1:6100')

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
  const echo = await runCommand(echoCommand('dsh-smoke'))
  assert.strictEqual(echo.code, 0)
  assert.deepStrictEqual(echo.lines, ['dsh-smoke'])
  const failing = await runCommand(nodeChild('process.stdout.write("out\\n");process.stderr.write("err\\n");process.exit(3)'))
  assert.strictEqual(failing.code, 3)
  assert.deepStrictEqual(failing.lines, ['out', 'err'])
  const noNewline = await runCommand(nodeChild('process.stdout.write("no-newline")'))
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

  // probeOnce against a token-gated harness (the 0.1.2-alpha shape): a bare
  // request is 401'd with the auth notice, and the token URL 303s to `/`
  // while minting a session cookie. Both must read as dsh — treating either
  // as "not dsh" is what made the reuse path reject a healthy service and
  // respawn on every connect.
  const authServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.searchParams.has('token')) {
      res.writeHead(303, { location: '/', 'set-cookie': 'dsh_session=abc; Path=/' })
      res.end()
      return
    }
    if (String(req.headers.cookie ?? '').includes('dsh_session=abc')) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>__DSH_BOOT__</html>')
      return
    }
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n')
  })
  await new Promise(resolve => authServer.listen(0, '127.0.0.1', resolve))
  const authBase = `http://127.0.0.1:${authServer.address().port}`
  const bareProbe = await probeOnce(authBase)
  assert.strictEqual(bareProbe.up, true)
  assert.strictEqual(bareProbe.isDsh, true, 'an unauthenticated harness is still a harness')
  // needsAuth is what lets a caller tell "up but unusable" from "up and
  // serving": only the token-less probe may report it.
  assert.strictEqual(bareProbe.needsAuth, true, 'a token-less probe must report that auth is required')
  const tokenProbe = await probeOnce(`${authBase}/?token=xyz`)
  assert.strictEqual(tokenProbe.up, true)
  assert.strictEqual(tokenProbe.isDsh, true, 'the token redirect must be followed with its cookie')
  assert.strictEqual(tokenProbe.needsAuth, false, 'a probe that got in must not report needsAuth')
  authServer.close()

  // A foreign service on the port is still NOT dsh — the relaxation above
  // must stay specific to the harness auth notice.
  const foreignServer = http.createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('Unauthorized')
  })
  await new Promise(resolve => foreignServer.listen(0, '127.0.0.1', resolve))
  const foreignProbe = await probeOnce(`http://127.0.0.1:${foreignServer.address().port}`)
  assert.strictEqual(foreignProbe.up, true)
  assert.strictEqual(foreignProbe.isDsh, false, 'a generic 401 must not count as dsh')
  assert.strictEqual(foreignProbe.needsAuth, false, 'a generic 401 must not claim to be a harness auth gate')
  foreignServer.close()

  // The remote liveness probe, executed for real. `remoteProbePort` runs ON the
  // remote host, so its command is reproduced here and run through the local
  // shell against the same token-gated shape the 0.2.1 harness serves. The old
  // command (`curl -s ... | grep -c "__DSH_BOOT__"`) counted ZERO against a
  // healthy service in BOTH shapes — a bare probe answers 401 with the auth
  // notice, and a token URL answers 303 with an EMPTY body because curl does
  // not follow redirects by default. Every connect therefore declared a live
  // service dead, reaped it and respawned: the "restart flashes and nothing
  // happens" symptom. This asserts the fixed command, including that it does
  // not depend on word-splitting (it runs under zsh on many hosts).
  {
    const authForProbe = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.searchParams.has('token')) {
        res.writeHead(303, { location: './', 'set-cookie': 'dsh_session=p; Path=/' })
        res.end()
        return
      }
      if (String(req.headers.cookie ?? '').includes('dsh_session=p')) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html>__DSH_BOOT__</html>')
        return
      }
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('dsh web authentication required; reopen the URL printed by dsh web.\n')
    })
    await new Promise(resolve => authForProbe.listen(0, '127.0.0.1', resolve))
    const probePort = authForProbe.address().port
    // Reproduce the exact remote command builder.
    //
    // The probe body is a POSIX SHELL command that runs on the REMOTE host, so
    // it cannot simply be executed here on Windows (there is no /bin/sh, and
    // `cmd.exe /c exit 1` would make this assertion pass vacuously by never
    // touching the stub). Instead the command is run through a real POSIX shell
    // when one exists, and otherwise its ONE effect — fetching the probe URL
    // and testing the body — is reproduced in-process. What is under test is
    // the classification (LIVE vs not) and the command's shape, not the shell.
    let captured = ''
    const prober = Object.create(ConnectionManager.prototype)
    prober.remoteRun = async (_target, inner) => {
      captured = inner
      if (!IS_WINDOWS) {
        const run = await runCommand({ cmd: '/bin/sh', args: ['-c', inner], timeoutMs: 10_000 })
        return { ...run, lines: run.lines }
      }
      // Windows: interpret the probe the way the remote shell would.
      const urlMatch = /curl -sL --max-time \d+ (http:\/\/[^\s)]+)/u.exec(inner)
      if (urlMatch === null) return { code: 1, lines: ['unrecognised probe'] }
      const probe = await probeOnce(urlMatch[1])
      // The remote command echoes 1 ONLY when the body carries the boot marker
      // or the auth notice — i.e. `isDsh`, not merely "something answered".
      // Using `up` here would adopt any unrelated web server, which is the
      // exact failure the next assertion guards against.
      return { code: 0, lines: [probe.isDsh === true ? '1' : '0'] }
    }
    assert.strictEqual(await prober.remoteProbePort({ ssh: { host: 'stub' } }, probePort), true,
      'a token-gated harness must read as LIVE (bare and token shapes alike)')
    assert.ok(/curl -sL\b/u.test(captured), 'the probe must follow the token redirect (curl -L)')
    assert.ok(/authentication required/u.test(captured), 'the 401 auth notice must count as live too')
    assert.ok(!captured.includes("'"), 'the probe command must not use single quotes')
    authForProbe.close()

    // A dead port and a foreign listener still read as not-dsh, so the fix
    // cannot resurrect the "reap a healthy service" failure in reverse.
    assert.strictEqual(await prober.remoteProbePort({ ssh: { host: 'stub' } }, 1), false, 'a dead port is not live')
    const foreignForProbe = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>hello</html>')
    })
    await new Promise(resolve => foreignForProbe.listen(0, '127.0.0.1', resolve))
    assert.strictEqual(
      await prober.remoteProbePort({ ssh: { host: 'stub' } }, foreignForProbe.address().port),
      false,
      'an unrelated web server must not be adopted as dsh',
    )
    foreignForProbe.close()
  }

  // The remote update flow's visible failure: restarting the service mints a
  // NEW launch token, so the one the previous service printed is dead — and
  // the ready status is what every window navigates to. This server accepts
  // only the token it minted, the way the real 0.2.1 harness does (303 to its
  // own token, 401 with the auth notice to anything else).
  const liveToken = 'fresh-token'
  const restartServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.searchParams.get('token') === liveToken) {
      res.writeHead(303, { location: '/', 'set-cookie': 'dsh_session=live; Path=/' })
      res.end()
      return
    }
    if (String(req.headers.cookie ?? '').includes('dsh_session=live')) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>__DSH_BOOT__</html>')
      return
    }
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n')
  })
  await new Promise(resolve => restartServer.listen(0, '127.0.0.1', resolve))
  const forwardPort = restartServer.address().port
  const restartShell = shellFor('ssh')
  // The forward the restart rebuilds, and the service it replaces: the
  // pre-restart URL carries a token the PREVIOUS harness minted.
  restartShell.localPort = forwardPort
  restartShell.remotePort = 41888
  restartShell.remoteWebUrl = `http://127.0.0.1:${forwardPort}/?token=dead-token`
  restartShell.restartRemoteService = async () => {
    restartShell.remotePort = 36067
    restartShell.remoteAnnouncedUrl = `http://127.0.0.1:36067/?token=${liveToken}`
  }
  restartShell.startTunnelOnFreePort = async () => { restartShell.localPort = forwardPort }
  const restartStatuses = []
  restartShell.on('status', status => restartStatuses.push(status))
  await restartShell.restartService()
  restartShell.stopHealthMonitor()
  const readyAfterRestart = restartStatuses.filter(status => status.state === 'ready').pop()
  assert.ok(readyAfterRestart !== undefined, 'a service restart must report ready')
  assert.strictEqual(
    readyAfterRestart.url,
    `http://127.0.0.1:${forwardPort}/?token=${liveToken}`,
    'a restart must re-host the token the NEW service announced, never the replaced one',
  )
  // The assertion that actually protects the window: the URL handed out has to
  // authenticate. One carrying the replaced service's token lands on the 401
  // notice instead — the exact page this test exists to keep off the screen.
  const postRestartProbe = await probeOnce(readyAfterRestart.url)
  assert.strictEqual(postRestartProbe.isDsh, true, 'the post-restart URL must reach the harness')
  assert.strictEqual(postRestartProbe.needsAuth, false, 'the post-restart URL must authenticate, not show the 401 notice')
  // …and the replaced service's token really is refused here, so the assertion
  // above cannot pass by accident.
  const deadTokenProbe = await probeOnce(`http://127.0.0.1:${forwardPort}/?token=dead-token`)
  assert.strictEqual(deadTokenProbe.needsAuth, true, 'a token the live service did not mint must be rejected')
  restartServer.close()

  // runner process registry: killActiveChildren must terminate every tracked
  // child (in-flight build, service, tunnel) so app quit never orphans one.
  const sleeper = spawnService(sleepCommand(30))
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

  // View focus must never activate a window. Measured on Electron 35: focusing
  // a WebContentsView's webContents ACTIVATES its owner window, even when that
  // window is in the background — so an unguarded call in a session-wide
  // broadcast (every window of one terminal) made two windows trade front-most
  // status, which on two displays reads as the window and the menu bar
  // flickering between screens. focusViewInKeyWindow must only ever hand
  // focus to the view of the window that is ALREADY key.
  const focusCalls = []
  const fakeWindow = focused => ({
    isFocused: () => focused,
    isDestroyed: () => false,
  })
  const fakeContents = () => ({
    focus: () => focusCalls.push('focus'),
    isDestroyed: () => false,
  })
  assert.strictEqual(focusViewInKeyWindow(fakeWindow(false), fakeContents()), false)
  assert.deepStrictEqual(focusCalls, [], 'a background window must never be activated')
  assert.strictEqual(focusViewInKeyWindow(fakeWindow(true), fakeContents()), true)
  assert.deepStrictEqual(focusCalls, ['focus'], 'the key window still gets its view focused')
  focusCalls.length = 0
  assert.strictEqual(focusViewInKeyWindow(null, fakeContents()), false)
  assert.strictEqual(focusViewInKeyWindow(fakeWindow(true), null), false)
  assert.strictEqual(focusViewInKeyWindow({ isFocused: () => true, isDestroyed: () => true }, fakeContents()), false)
  assert.strictEqual(
    focusViewInKeyWindow(fakeWindow(true), { focus: () => focusCalls.push('focus'), isDestroyed: () => true }),
    false,
  )
  assert.deepStrictEqual(focusCalls, [], 'destroyed surfaces are never focused')

  // The directory chooser must be a WINDOW SHEET, every time.
  //
  // Reported symptom on macOS 26.6: opening a workspace popped the Finder-style
  // folder panel, but the panel refused the first click — the user had to click
  // the DSH window before the dialog could be operated. Cause: the harness's
  // native picker row had no desktop bridge, so the `dsh web` Host process ran
  // its own osascript NSOpenPanel from a throwaway Accessory app that is not
  // frontmost, leaving that panel non-key. The shell now answers the bridge
  // itself with showOpenDialog(parented to the asking window). These assertions
  // pin the parts that are invisible at the call site.
  {
    const { pickedPath, pickDirectory, DIRECTORY_PROPERTIES } = require('../src/picker')
    const owner = { isDestroyed: () => false }
    const shown = []
    const fakeDialog = {
      showOpenDialog: async (...args) => {
        shown.push(args)
        return { canceled: false, filePaths: ['/Users/x/workspace'] }
      },
    }
    assert.deepStrictEqual(
      await pickDirectory(owner, fakeDialog),
      '/Users/x/workspace',
      'a picked directory resolves to its absolute path',
    )
    assert.strictEqual(shown[0].length, 2, 'the owner window must be passed: that is what makes it a key sheet')
    assert.strictEqual(shown[0][0], owner, 'the sheet parent is the window the user clicked in')
    assert.deepStrictEqual(shown[0][1].properties, [...DIRECTORY_PROPERTIES])
    assert.ok(DIRECTORY_PROPERTIES.includes('openDirectory'), 'directories, not files')
    assert.ok(DIRECTORY_PROPERTIES.includes('createDirectory'), 'a new workspace folder is not an error path')

    // Cancel must stay cancel even though a cancelled macOS panel still reports
    // the highlighted directory in filePaths.
    assert.strictEqual(pickedPath({ canceled: true, filePaths: ['/Users/x/highlighted'] }), null,
      'a cancelled panel must never yield its highlighted path')
    assert.strictEqual(pickedPath({ canceled: false, filePaths: [] }), null)
    assert.strictEqual(pickedPath({ canceled: false }), null)
    assert.strictEqual(pickedPath(null), null)
    assert.strictEqual(pickedPath(undefined), null)
    assert.strictEqual(pickedPath({ canceled: false, filePaths: [''] }), null)

    // A destroyed window (closed mid-pick) still gets a chooser, app-modal.
    const orphanShown = []
    const orphanDialog = { showOpenDialog: async (...args) => {
      orphanShown.push(args)
      return { canceled: true, filePaths: [] }
    } }
    assert.strictEqual(await pickDirectory({ isDestroyed: () => true }, orphanDialog), null)
    assert.strictEqual(orphanShown[0].length, 1, 'no dead parent: fall back to an app-modal chooser, never no dialog')
    assert.strictEqual(await pickDirectory(null, orphanDialog), null)

    // The harness view must actually carry the bridge preload, and the preload
    // must define the exact global the harness client row probes for. A silent
    // regression here restores the swallowed-first-click bug with no error.
    //
    // The block is delimited by the NEXT top-level statement, not by a fixed
    // character count: Windows checkouts may carry CRLF, and a byte budget
    // would then slice mid-expression and fail for a reason unrelated to the
    // bug (this test runs on windows-latest in CI).
    const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8')
    const harnessViewAt = mainSource.indexOf('const harnessView = new WebContentsView(')
    assert.ok(harnessViewAt !== -1, 'the harness view construction must exist')
    const blockEnd = mainSource.indexOf('win.contentView.addChildView(harnessView)', harnessViewAt)
    assert.ok(blockEnd > harnessViewAt, 'the harness view block must end at its addChildView call')
    const harnessViewBlock = mainSource.slice(harnessViewAt, blockEnd)
    assert.ok(harnessViewBlock.includes('preload: HARNESS_PRELOAD'),
      'the harness view must load the desktop bridge preload')
    const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'harness-preload.js'), 'utf8')
    assert.ok(preloadSource.includes("exposeInMainWorld('__DSH_DIRECTORY_PICKER__'"),
      "the bridge must expose the harness's own global name")
    assert.ok(preloadSource.includes("ipcRenderer.invoke('picker:directory')"),
      'the bridge must reach the shell handler that opens the parented sheet')
    assert.ok(mainSource.includes("ipcMain.handle('picker:directory'"),
      'the bridge channel must have a main-process handler')
  }

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

  // A loaded page is not a booted harness: the frontend can fail to activate
  // its plugin graph and leave a "Failed to load plugins" card on screen with
  // no further DOM event to follow. The shell reloads the service URL when
  // that card is there — but only for the URL it is actually showing, and only
  // a bounded number of times, so a genuinely broken profile cannot reload
  // forever.
  const bootOk = { probeSeq: 1, currentSeq: 1, probedUrl: 'http://127.0.0.1:3080/', loadedUrl: 'http://127.0.0.1:3080/', reloads: 0, limit: 2 }
  assert.strictEqual(shouldReloadAfterBootFailure(bootOk), true)
  // A superseded probe describes a page that is no longer on screen.
  assert.strictEqual(shouldReloadAfterBootFailure({ ...bootOk, currentSeq: 2 }), false)
  // The view moved on (a restarted service picking a new port).
  assert.strictEqual(shouldReloadAfterBootFailure({ ...bootOk, loadedUrl: 'http://127.0.0.1:3081/' }), false)
  // No committed URL: nothing has booted yet.
  assert.strictEqual(shouldReloadAfterBootFailure({ ...bootOk, probedUrl: '', loadedUrl: '' }), false)
  // The cap: a failure that already spent its attempts is not retried again.
  assert.strictEqual(shouldReloadAfterBootFailure({ ...bootOk, reloads: 1 }), true)
  assert.strictEqual(shouldReloadAfterBootFailure({ ...bootOk, reloads: 2 }), false)
  assert.strictEqual(shouldReloadAfterBootFailure({ ...bootOk, limit: 0 }), false)
  // The probe must match the failure card's own text, not the overlay itself:
  // the overlay is mounted during a SUCCESSFUL boot too, so its presence alone
  // would reload healthy pages.
  assert.ok(BOOT_FAILURE_PROBE.includes('data-dsh-boot'))
  assert.ok(BOOT_FAILURE_PROBE.includes('Failed to load plugins'))

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
  const tools = resolveTools({ local: { repoDir: '', repoUrl: '' }, toolPaths: { node: '', git: '', pnpm: '', shell: require('../src/tools').defaultLoginShell() } })
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
    connection: { resolvedTools: () => resolveTools({ local: { repoDir: '', repoUrl: '' }, toolPaths: { node: '', git: '', pnpm: '', shell: require('../src/tools').defaultLoginShell() } }) },
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
  //
  // The echo below reproduces what the remote `printf` would have produced
  // rather than returning a canned string, because the field this contract
  // now has to get right IS the announced URL: it carries the launch token a
  // later shell needs to adopt the service, and it is the one field that
  // travels through a double-quoted shell argument.
  let lastStateJson = ''
  const stateEchoRun = async (_host, command) => {
    if (!command.includes('desktop-web.state.json')) return { code: 0, lines: [] }
    if (!command.includes('printf')) return { code: 0, lines: [] }
    const match = /printf '([^']*)'\s+([\s\S]*?)\s+>/.exec(command)
    if (match === null) return { code: 0, lines: [] }
    const values = [...match[2].matchAll(/"([^"]*)"/g)].map(entry => entry[1])
    lastStateJson = match[1].replace(/\\n$/, '').replace(/%s/g, () => values.shift() ?? '')
    return { code: 0, lines: [lastStateJson] }
  }
  assert.strictEqual(
    await runtimeStore.writeRemoteState(remoteSettings, stateEchoRun, {
      pid: 12345,
      port: 23456,
      version: 'npm0.1.1-rc.2',
      url: 'http://127.0.0.1:36067/?token=abc-123',
    }),
    true,
  )
  // The token URL must survive the trip into the state file verbatim: it is
  // what lets the next shell reuse this service instead of restarting it.
  assert.strictEqual(JSON.parse(lastStateJson).url, 'http://127.0.0.1:36067/?token=abc-123')
  // …and nothing that could end the shell argument or start an expansion may
  // reach it: the URL is interpolated into the remote command unquoted.
  assert.strictEqual(
    await runtimeStore.writeRemoteState(remoteSettings, stateEchoRun, {
      pid: 12345,
      port: 23456,
      version: 'npm0.1.1-rc.2',
      url: 'http://127.0.0.1:1/?token=x"; touch /tmp/pwned; echo "`id`$HOME',
    }),
    true,
  )
  const sanitizedUrl = JSON.parse(lastStateJson).url
  // The URL lands inside a double-quoted printf argument, so exactly the
  // characters that would end that argument (`"` and `\`), expand inside it
  // (`$` and a backtick), or break the JSON literal around it (whitespace and
  // control characters) have to be gone. `;` and `&` are literal inside double
  // quotes, so the alphabet stays faithful to URLs that contain them.
  assert.ok(
    !/["`$\\\s\u0000-\u001f]/.test(sanitizedUrl),
    `the written URL must be shell- and JSON-inert: ${sanitizedUrl}`,
  )
  assert.ok(sanitizedUrl.startsWith('http://127.0.0.1:1/?token=x'), 'the token itself must survive the sanitizer')
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
  const { dshWebProcesses, listeningLoopbackPorts, processUsesHome } = require('../src/process-scan')
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
  //
  // The two OSes answer the question from DIFFERENT evidence, so the
  // assertions differ too:
  //
  //  - POSIX reads open files (`lsof`), so merely HOLDING a file in the home
  //    is enough, and a symlinked path must resolve to the same answer.
  //  - Windows reads the process COMMAND LINE (there is no cheap open-file
  //    query). A test process that merely wrote a file there is therefore
  //    NOT identifiable as "using" the home — and that is the correct,
  //    fail-closed answer: the sweep must never adopt a process it cannot
  //    tie to its own home. What Windows CAN prove is the argv test, which is
  //    asserted directly below.
  const linkTarget = path.join(os.tmpdir(), `dsh-link-target-${process.pid}`)
  const linkPath = path.join(os.tmpdir(), `dsh-link-${process.pid}`)
  fs.mkdirSync(linkTarget, { recursive: true })
  const marker = fs.openSync(path.join(linkTarget, 'marker'), 'w')
  try {
    if (IS_WINDOWS) {
      // This process's argv does not mention the home, so it is a bystander
      // as far as the Windows check is concerned.
      assert.strictEqual(
        await processUsesHome(process.pid, linkTarget),
        false,
        'on Windows a process whose argv does not name the home is not adopted',
      )
      // The argv matcher itself is what decides adoption; assert its edges.
      assert.strictEqual(
        commandMentionsPath(`node "${path.join(linkTarget, 'runtime', 'x', 'bin.js')}" web`, linkTarget),
        true,
        'a runtime path under the home is ours',
      )
      assert.strictEqual(
        commandMentionsPath(`node "${linkTarget}-decoy\\x\\bin.js" web`, linkTarget),
        false,
        'a sibling directory sharing the home as a prefix is NOT ours',
      )
    } else {
      assert.strictEqual(await processUsesHome(process.pid, linkTarget), true, 'a home this process holds a file in is ours')
      fs.symlinkSync(linkTarget, linkPath)
      assert.strictEqual(
        await processUsesHome(process.pid, linkPath),
        true,
        'the same home reached through a symlink is still ours',
      )
    }
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
  const { parseRemoteHostScan, parseRemoteProbe, REMOTE_HOST_SCAN } = require('../src/remote-protocol')
  // The remote protocol is its own module and must stay dependency-free: it is
  // the one file that has to stay byte-compatible with the remote side and with
  // the Android client, so it must not grow a dependency on ssh, sessions or
  // process handles. Asserted structurally rather than by convention.
  {
    const protocolSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'remote-protocol.js'), 'utf8')
    const requires = [...protocolSource.matchAll(/require\(['"]([^'"]+)['"]\)/gu)].map(m => m[1])
    assert.deepStrictEqual(requires, [], 'the remote protocol must not require anything')
    assert.ok(!/require\('\.\/(ssh|runner|tools|process-scan|runtime-store)'\)/u.test(protocolSource), 'the remote protocol must not reach into lifecycle modules')
  }
  // The scan now also reports whether it could LOOK. `parseRemoteHostScan`
  // returns { hosts, psAvailable, lsofAvailable } so a caller can tell "nothing
  // to reap" from "could not scan" - the second used to be indistinguishable
  // and read as a clean home while a second host kept the session store.
  const hostOnly = lines => parseRemoteHostScan(lines).hosts
  assert.deepStrictEqual(
    hostOnly(['3663408|8|35993']),
    [{ pid: 3663408, usesHome: true, ports: [35993] }],
    'a host with files under the home is one we may adopt',
  )
  assert.deepStrictEqual(
    hostOnly(['42|0|53100,53101']),
    [{ pid: 42, usesHome: false, ports: [53100, 53101] }],
    'a host outside our dsh home must be marked a bystander',
  )
  assert.deepStrictEqual(
    hostOnly(['7|3|']),
    [{ pid: 7, usesHome: true, ports: [] }],
    'a host not listening yet still has to be reaped',
  )
  assert.deepStrictEqual(hostOnly(['garbage', '', '|1|80', '0|1|80']), [], 'malformed scan lines are ignored')
  assert.deepStrictEqual(hostOnly([]), [], 'an empty scan yields no hosts')
  assert.deepStrictEqual(hostOnly(undefined), [], 'a missing scan yields no hosts')
  // Capability markers must be consumed, not mistaken for host rows.
  assert.deepStrictEqual(
    parseRemoteHostScan(['__dsh_lsof_ok', '__dsh_ps_ok', '3663408|8|35993']),
    { hosts: [{ pid: 3663408, usesHome: true, ports: [35993] }], psAvailable: true, lsofAvailable: true },
    'capability markers set the report flags and never become hosts',
  )
  assert.deepStrictEqual(
    parseRemoteHostScan(['__dsh_lsof_ok', '__dsh_ps_missing']),
    { hosts: [], psAvailable: false, lsofAvailable: true },
    'a host that denies ps reports psAvailable=false instead of a clean home',
  )
  assert.deepStrictEqual(
    parseRemoteHostScan(['__dsh_lsof_missing', '__dsh_ps_ok']),
    { hosts: [], psAvailable: true, lsofAvailable: false },
    'a host without lsof cannot attribute hosts to a home',
  )
  // A raw string is split into lines. Passing one to a `for..of` over an array
  // would iterate CHARACTER by character and match nothing - and an empty sweep
  // reads as "nothing to reap", leaving an orphan to hold the task-board ledger
  // and crash-loop the next spawn. The failure is silent, so it is asserted.
  assert.deepStrictEqual(
    hostOnly('3663408|8|35993\n42|0|53100,53101\n'),
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
  assert.ok(REMOTE_HOST_SCAN.includes('__dsh_ps_ok') && REMOTE_HOST_SCAN.includes('__dsh_ps_missing'), 'the scan reports whether ps could run')
  assert.ok(REMOTE_HOST_SCAN.includes('__dsh_lsof_ok') && REMOTE_HOST_SCAN.includes('__dsh_lsof_missing'), 'the scan reports whether lsof exists')
  assert.ok(REMOTE_HOST_SCAN.includes('; fi'), 'the ps guard must be a closed if-block')

  // The login shell must be the account's REAL one (what sshd runs), not the
  // most capable shell that merely exists. The old probe walked `zsh, bash,
  // sh` and took the first hit, so a bash-login box that had zsh installed ran
  // every remote command under zsh — which never reads ~/.bashrc. PATH then
  // lost the portable node, `node` fell through to a pre-24.2 build where
  // `import.meta.main` is undefined, and the dsh CLI became a silent no-op
  // (rc=0, no output): "闪一下就没".
  {
    const { parseRemoteLoginShell, REMOTE_LOGIN_SHELL_PROBE } = require('../src/remote-protocol')
    // The authoritative answer wins even when zsh exists.
    assert.strictEqual(parseRemoteLoginShell(['/bin/bash']), '/bin/bash', 'the real login shell must win over zsh')
    assert.strictEqual(parseRemoteLoginShell('/bin/bash\n'), '/bin/bash', 'a raw string is accepted too')
    assert.strictEqual(parseRemoteLoginShell(['', '  ', '/bin/zsh']), '/bin/zsh', 'blank lines are skipped')
    // Unusable answers never become the shell: nologin/false and relative or
    // non-shell paths fall back to the POSIX baseline.
    for (const bad of [['/usr/sbin/nologin'], ['/bin/false'], ['bash'], ['/usr/bin/python3'], [], [''], ['garbage']]) {
      assert.strictEqual(parseRemoteLoginShell(bad), '/bin/sh', `${JSON.stringify(bad)} must fall back to /bin/sh`)
    }
    assert.strictEqual(parseRemoteLoginShell(undefined), '/bin/sh', 'a missing probe result falls back')
    // `shellQuote` wraps the whole remote command in single quotes, so an
    // unescaped one inside the probe would break the ssh invocation.
    assert.ok(!REMOTE_LOGIN_SHELL_PROBE.includes("'"), 'the login-shell probe must not use single quotes')
    assert.ok(/getent passwd/u.test(REMOTE_LOGIN_SHELL_PROBE), 'the probe must consult the passwd entry sshd uses')
  }
  // Executed for real: the probe must resolve THIS machine's login shell. On
  // macOS there is no `getent`, so this also covers the $SHELL fallback.
  //
  // Windows has no /bin/sh and no `getent`, so there is nothing to execute:
  // the probe runs on the REMOTE host (always POSIX in this shell's SSH mode),
  // and the local run only ever proved the parser against a real account. The
  // parser itself is asserted above, platform-independently.
  if (!IS_WINDOWS) {
    const { parseRemoteLoginShell, REMOTE_LOGIN_SHELL_PROBE } = require('../src/remote-protocol')
    const probed = await runCommand({ cmd: '/bin/sh', args: ['-c', REMOTE_LOGIN_SHELL_PROBE], timeoutMs: 15_000 })
    assert.strictEqual(probed.code, 0, 'the login-shell probe must succeed')
    const resolved = parseRemoteLoginShell(probed.lines)
    assert.ok(resolved.startsWith('/'), `the probe must resolve an absolute shell path, got ${resolved}`)
    assert.ok(fs.existsSync(resolved), `the resolved shell ${resolved} must exist`)
    // Only an ENV-provided $SHELL is a fair comparison: `getent` does not exist
    // on macOS, so the probe legitimately falls back to /bin/bash when $SHELL
    // is unset (as it can be on a CI runner).
    const envShell = process.env.SHELL ?? ''
    if (envShell.startsWith('/')) {
      assert.strictEqual(resolved, envShell, 'the probe must agree with the account login shell')
    }
  }

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
    // A report, not a bare array: the sweep needs to know whether the scan
    // could look at all. These stubs represent a host where it could.
    sweeper.remoteHostCandidates = async () => ({
      hosts: sweepCase.candidates, psAvailable: true, lsofAvailable: true,
    })
    sweeper.killRemotePids = async (_target, pids) => {
      asked = pids
      return pids
    }
    const killed = await sweeper.reapStrayRemoteHosts({ ssh: { host: 'stub' } }, sweepCase.keepPid)
    assert.deepStrictEqual(asked, sweepCase.expect, sweepCase.name)
    assert.strictEqual(killed, sweepCase.expect === null ? 0 : sweepCase.expect.length, `${sweepCase.name} (count)`)
  }
  // A scan that cannot LOOK must never be reported as a clean home. This is
  // the failure that made two hosts sharing a session store invisible: the
  // sweep said "nothing to reap" while `ps` was denied on the host.
  for (const broken of [
    { name: 'ps denied', report: { hosts: [], psAvailable: false, lsofAvailable: true }, expectNote: /ps 不可用/ },
    { name: 'lsof missing', report: { hosts: [], psAvailable: true, lsofAvailable: false }, expectNote: /lsof 不可用/ },
  ]) {
    let asked = null
    const notes = []
    const sweeper = Object.create(ConnectionManager.prototype)
    sweeper.log = line => notes.push(String(line))
    sweeper.remoteHostCandidates = async () => broken.report
    sweeper.killRemotePids = async (_target, pids) => {
      asked = pids
      return pids
    }
    const killed = await sweeper.reapStrayRemoteHosts({ ssh: { host: 'stub' } }, 10)
    assert.strictEqual(asked, null, `${broken.name}: an unusable scan must not authorise a kill`)
    assert.strictEqual(killed, 0, `${broken.name}: nothing was killed`)
    assert.ok(
      notes.some(line => broken.expectNote.test(line)),
      `${broken.name}: the skip must be reported, not silent (got ${JSON.stringify(notes)})`,
    )
  }
  // A visible stray that survives the kill must still be reported, so a wedged
  // sweep is not mistaken for a clean home.
  {
    const notes = []
    const sweeper = Object.create(ConnectionManager.prototype)
    sweeper.log = line => notes.push(String(line))
    sweeper.remoteHostCandidates = async () => ({
      hosts: [{ pid: 10, usesHome: true, ports: [5110] }, { pid: 20, usesHome: true, ports: [5120] }],
      psAvailable: true, lsofAvailable: true,
    })
    sweeper.killRemotePids = async () => []
    await sweeper.reapStrayRemoteHosts({ ssh: { host: 'stub' } }, 10)
    assert.ok(notes.some(line => /未能清理/.test(line)), 'a stray that survived must be reported')
  }
  // A corrupt state file must not become "kill everything". The arbiter is the
  // recorded pid, so when it is missing or nonsense we cannot tell the hosts
  // apart and must kill none — leaving a stray alive is the survivable error.
  for (const keepPid of [0, -1, null, undefined, '10', 1.5, NaN]) {
    let asked = null
    const sweeper = Object.create(ConnectionManager.prototype)
    sweeper.log = () => {}
    sweeper.remoteHostCandidates = async () => ({
      hosts: [{ pid: 10, usesHome: true, ports: [5110] }], psAvailable: true, lsofAvailable: true,
    })
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

  // The kill command itself is the silent-failure surface: the remote commands
  // run through the remote LOGIN shell, and `remoteLoginShell` probes zsh
  // FIRST. zsh does NOT word-split an unquoted variable, so the old
  // `for p in $alive` iterated ONCE with the whole list as one argument —
  // `kill " 10 20"` failed with rc=1 and every sweep no-opped while still
  // reporting success. That is the leaked-orphan bug: the log said "cleaned up
  // pids 1,2,3" while all of them kept running.
  {
    let captured = ''
    const killer = Object.create(ConnectionManager.prototype)
    killer.log = () => {}
    killer.remoteRun = async (_target, inner) => {
      captured = inner
      return { code: 0, lines: ['ALIVE 10 20'], signal: null }
    }
    const killed = await killer.killRemotePids('stub', [10, 20])
    assert.deepStrictEqual(killed, [10, 20], 'both live pids are reported')
    // Iterating the LITERAL list splits in every shell; only membership is
    // tested against the accumulated `$alive`.
    assert.ok(!/\bin \$alive\b/u.test(captured), 'never iterate $alive directly: zsh will not split it')
    assert.ok(/\bfor p in 10 20\b/u.test(captured), 'the pid list is interpolated literally')
    assert.ok(captured.includes('case " $alive " in *" $p "*)'), 'membership is matched with case, not word-splitting')
    assert.ok(captured.includes('kill $p'), 'a TERM pass runs')
    assert.ok(captured.includes('kill -9 $p'), 'a KILL pass follows')
    // No single quotes: `shellQuote` wraps the whole remote command in them.
    assert.ok(!captured.includes("'"), 'the kill command must not use single quotes')
  }
  // Nothing to kill must not cost a round-trip.
  {
    let called = false
    const killer = Object.create(ConnectionManager.prototype)
    killer.log = () => {}
    killer.remoteRun = async () => {
      called = true
      return { code: 0, lines: [], signal: null }
    }
    assert.deepStrictEqual(await killer.killRemotePids('stub', [0, -1, NaN, 'x']), [], 'no valid pid means no call')
    assert.strictEqual(called, false, 'an empty pid list costs no ssh round-trip')
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
  const alive = pid => isPidAlive(pid)
  // The sweep can only work if the host lets us LIST processes at all. The
  // shell now has two independent listers (`ps`, then `pgrep -fl`), so this
  // probe asks the real code path rather than assuming a single tool: a host
  // that refuses `ps` is exactly the case the fallback exists for.
  const enumerationWorks = (await posixProcessLines().catch(() => null)) !== null
    || IS_WINDOWS
  if (!enumerationWorks) {
    console.log('  · no process lister available on this host; skipping the sweep assertions')
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

    if (enumerationWorks) {
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
    }

    // Register the close listener BEFORE the kill: the wrapper can exit (and
    // emit its one close event) while the sweep+sleep below runs, and a
    // listener attached after that fires never will.
    const wrapperClosed = new Promise(resolve => {
      familySpawn.child.once('close', () => resolve('closed'))
    })
    if (enumerationWorks) {
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
    }
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
      toolPaths: { node: '', git: '', pnpm: '', shell: require('../src/tools').defaultLoginShell() },
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
  // The intent records the device it belongs to. An ssh update writes the
  // file into this LOCAL dshHome, and only the local device is ever resumed —
  // so a missing mode has to read as legacy/local, never as "resume anyway".
  assert.strictEqual(pending.mode, 'local')
  runtimeStore.writePendingUpdate({ ...homeSettings, mode: 'ssh' }, { intent: 'artifact', version: '0.1.0-rc.8' })
  assert.strictEqual(runtimeStore.readPendingUpdate(homeSettings).mode, 'ssh', 'an ssh intent is marked as such')
  runtimeStore.writePendingUpdate(homeSettings, { intent: 'artifact', version: '0.1.0-rc.7' })
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
    ...sleepCommand(30),
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
      resolvedTools: () => resolveTools({ local: { repoDir: '', repoUrl: '' }, toolPaths: { node: '', git: '', pnpm: '', shell: require('../src/tools').defaultLoginShell() } }),
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
  // …and carries no channel: the newest release is resolved at every check,
  // so a stale per-device channel preference must never be preserved.
  assert.strictEqual(mergeUpdates({ channel: 'alpha' }, {}).channel, undefined)
  assert.strictEqual(mergeUpdates({}, { channel: 'alpha' }).channel, undefined)


  // ── platform primitives ──────────────────────────────────────────────────
  // The shell runs on macOS, Windows and Linux; every OS-specific primitive is
  // asserted here so a port cannot silently fall back to a POSIX assumption.

  // Executable naming: a bare tool name resolves to .exe/.cmd shims on
  // Windows and to the bare name elsewhere.
  {
    const names = executableNames('node')
    if (IS_WINDOWS) {
      assert.deepStrictEqual(names.slice(0, 3), ['node.exe', 'node.cmd', 'node.bat'],
        'Windows must prefer node.exe, then the .cmd/.bat shims')
      assert.ok(names.includes('node'), 'the extensionless form stays as a last resort')
    } else {
      assert.deepStrictEqual(names, ['node'], 'POSIX tools resolve to the bare name')
    }
    // An explicit extension is never rewritten: pnpm.cmd must stay pnpm.cmd.
    assert.deepStrictEqual(executableNames('pnpm.cmd'), ['pnpm.cmd'])
  }

  // Home expansion handles both separators, so a settings file written on one
  // platform still resolves on the other.
  {
    const home = os.homedir()
    assert.strictEqual(expandHome('~'), home)
    assert.strictEqual(expandHome('~/x'), path.join(home, 'x'))
    assert.strictEqual(expandHome('~' + path.sep + 'x'), path.join(home, 'x'))
    assert.strictEqual(expandHome('/absolute/path'), '/absolute/path')
  }

  // Node distribution: the archive kind and filename differ per OS, and the
  // arch spelling must map arm64/x64 correctly (Windows arm64 builds ship).
  {
    // The POSIX shape is asserted with an explicit target so the assertion
    // means the same thing on a Windows host.
    const mac = nodeDistArchive('22.19.0', 'arm64', { windows: false, platform: 'darwin' })
    assert.ok(mac.url.endsWith('.tar.gz'), 'POSIX node distributions are tarballs')
    assert.ok(mac.url.includes('node-v22.19.0-'), 'the url carries the version')
    assert.ok(/22\.19\.0-darwin-arm64\.tar\.gz$/.test(mac.url), 'arch and platform are carried through')
    assert.strictEqual(mac.kind, 'tar.gz')
    // The archive kind follows the TARGET OS, so both shapes are assertable
    // from either host (a Windows installer may be built on a macOS runner).
    const win = nodeDistArchive('22.19.0', 'x64', { windows: true })
    assert.strictEqual(win.kind, 'zip', 'Windows node distributions are zips')
    assert.ok(win.url.includes('-win-x64.zip'), `Windows url must use the win-x64 shape, got ${win.url}`)
    const ia32 = nodeDistArchive('22.19.0', 'ia32')
    assert.ok(ia32.url.includes('-x86.'), 'ia32 maps to the x86 archive')
  }

  // The `current` pointer swap works on both a symlink and a junction host and
  // never leaves a half-swapped directory behind.
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-current-swap-'))
    try {
      const v1 = path.join(root, 'npm1')
      const v2 = path.join(root, 'npm2')
      fs.mkdirSync(v1)
      fs.mkdirSync(v2)
      fs.writeFileSync(path.join(v1, 'which.txt'), 'one')
      fs.writeFileSync(path.join(v2, 'which.txt'), 'two')
      const current = path.join(root, 'current')
      swapCurrentLink(current, v1, 'npm1')
      assert.strictEqual(fs.readFileSync(path.join(current, 'which.txt'), 'utf8'), 'one')
      swapCurrentLink(current, v2, 'npm2')
      assert.strictEqual(fs.readFileSync(path.join(current, 'which.txt'), 'utf8'), 'two',
        'a second swap must repoint current atomically')
      assert.deepStrictEqual(
        fs.readdirSync(root).filter(name => name.startsWith('.') || name.includes('.tmp-') || name.includes('.old-')),
        [],
        'no swap turds are left behind',
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  // Windows process discovery: netstat rows become loopback listeners, CIM
  // records become pid + command lines. Parsed as pure data so the formats are
  // covered without needing a Windows host.
  {
    const rows = [
      '  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       12345',
      '  TCP    [::1]:5678             [::]:0                 LISTENING       999',
      '  TCP    192.168.1.5:445        0.0.0.0:0              LISTENING       4',
      '  TCP    127.0.0.1:52000        127.0.0.1:5000         ESTABLISHED     777',
      '  UDP    127.0.0.1:53           *:*                                    888',
    ]
    const listeners = parseNetstatListeners(rows)
    assert.deepStrictEqual(listeners.map(entry => entry.port), [3080, 5678],
      'only loopback/wildcard LISTENING rows are listeners; LAN-only and non-LISTENING rows are not')
    assert.strictEqual(listeners[0].pid, 12345)
    assert.deepStrictEqual(parseNetstatListeners(''), [])
    assert.deepStrictEqual(parseNetstatListeners(undefined), [])
    assert.strictEqual(isLoopbackAddress('127.0.0.1'), true)
    assert.strictEqual(isLoopbackAddress('::1'), true)
    assert.strictEqual(isLoopbackAddress('0.0.0.0'), true, 'a wildcard bind serves loopback too')
    assert.strictEqual(isLoopbackAddress('10.1.2.3'), false)

    const processes = parseWindowsProcessList([
      '4321\t"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\u\\.dsh\\runtime\\current\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js web --port 0',
      'not-a-pid\tsomething',
      '',
    ])
    assert.strictEqual(processes.length, 1, 'only pid-prefixed records parse')
    assert.strictEqual(processes[0].pid, 4321)
    assert.ok(processes[0].command.includes('bin.js web --port 0'))

    // PowerShell string literals escape a single quote by doubling it.
    assert.strictEqual(psQuote("a'b"), "'a''b'")

    // Windows batch shims (npm.cmd, pnpm.cmd) can only run through cmd.exe,
    // and cmd.exe parses its command line differently from POSIX shells.
    const plain = spawnInvocation('/usr/bin/git', ['status'])
    assert.strictEqual(plain.cmd, '/usr/bin/git', 'POSIX invocation is unchanged')
    assert.deepStrictEqual(plain.args, ['status'])
    assert.deepStrictEqual(plain.options, {})
    // Quote rules are pure, so they are asserted on every platform.
    assert.strictEqual(cmdQuote('plain'), 'plain')
    assert.strictEqual(cmdQuote('has space'), '"has space"', 'spaces need quotes')
    // cmd.exe treats & | < > as LITERALS inside double quotes, so quoting (not
    // caret-escaping) is what neutralises them.
    assert.strictEqual(cmdQuote('a&b'), '"a&b"', 'cmd metacharacters are neutralised by quoting')
    assert.strictEqual(cmdQuote('say "hi"'), '"say ""hi"""', 'embedded quotes are doubled')
    assert.strictEqual(cmdQuote(''), '""')
  }

  // npm lives beside node and is spelled differently per OS; a wrong guess
  // makes 'install pnpm / the official artifact' fail with ENOENT.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-npm-locate-'))
    try {
      for (const name of IS_WINDOWS ? ['node.exe', 'npm.cmd'] : ['node', 'npm']) {
        fs.writeFileSync(path.join(dir, name), '')
      }
      const nodePath = path.join(dir, IS_WINDOWS ? 'node.exe' : 'node')
      assert.strictEqual(npmFor(nodePath), path.join(dir, IS_WINDOWS ? 'npm.cmd' : 'npm'),
        'npm must resolve to the launcher that actually exists on this OS')
      assert.strictEqual(npmFor(''), '', 'an empty node path has no npm beside it')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  // ssh config path: %USERPROFILE%\.ssh\config on Windows, ~/.ssh/config elsewhere.
  {
    const configPath = sshConfigPath()
    assert.strictEqual(configPath, path.join(os.homedir(), '.ssh', 'config'))
  }

  // Tool resolution must not depend on the launch PATH: every candidate list
  // includes the platform's system dirs and the repo-local tool bins.
  {
    const settings = {
      local: { repoDir: path.join(__dirname, '..', 'deepseek-harness') },
      toolPaths: { node: '', git: '', pnpm: '', shell: require('../src/tools').defaultLoginShell() },
    }
    const env = require('../src/tools').childEnv(settings, '')
    const pathKey = IS_WINDOWS ? 'Path' : 'PATH'
    assert.ok(typeof env[pathKey] === 'string' && env[pathKey] !== '', 'the child PATH must be set')
    const parts = env[pathKey].split(path.delimiter)
    assert.ok(parts.some(part => part.endsWith(path.join('.dsh-tools', 'node', 'bin'))),
      'the repo-local toolchain bin must be on PATH')
    assert.ok(parts.some(part => part.endsWith(path.join('node_modules', '.bin'))),
      'node_modules/.bin must be on PATH (pnpm shims live there)')
    if (IS_WINDOWS) {
      assert.strictEqual(env.PATH, env.Path, 'both PATH spellings must agree on Windows')
    }
    assert.strictEqual(env.DSH_LEFTHOOK_ALLOW_HOOKS_PATH_OVERRIDE, '1',
      'the lefthook override must survive the clean env')
  }

  // Home ownership gates a KILL: a host the sweep cannot identify must never be
  // signalled. The Windows path answers false when it cannot read a command
  // line, and the POSIX path answers false when lsof refuses — both are
  // asserted here because getting the polarity wrong kills bystanders.
  {
    // A pid that cannot exist has no command line and no open files.
    assert.strictEqual(
      await processUsesHome(2 ** 30, path.join(os.tmpdir(), 'dsh-no-such-home')),
      false,
      'an unidentifiable process must never be reported as using our home',
    )
    assert.strictEqual(
      await processUsesHome(process.pid, ''),
      true,
      'no configured home means "cannot distinguish" — keep the process',
    )
    // The Windows twin answers false when it cannot read a command line (no
    // PowerShell, no such pid, permission denied) — the fail-closed direction.
    assert.strictEqual(
      await windowsProcessUsesHome(2 ** 30, path.join(os.tmpdir(), 'nope')),
      false,
      'an unreadable Windows process must never count as using our home',
    )
  }


  // ps-free process enumeration: the shell must not lose its sweep when the
  // host denies `ps`. pgrep reaches processes through a different interface,
  // and the family walk (group members + children) is what keeps a validated
  // service alive — the ps-only version killed it (reproduced).
  {
    // `posixProcessLines` is the POSIX lister (`ps`, then `pgrep`); on Windows
    // there is neither, and the Windows path uses WMI instead — so an empty
    // answer here is CORRECT on Windows, not a missing capability.
    const lines = IS_WINDOWS ? null : await posixProcessLines().catch(() => null)
    if (lines === null) {
      if (!IS_WINDOWS) {
        console.log('  · no process lister at all on this host; skipping enumeration assertions')
      }
    } else {
      assert.ok(lines.length > 0, 'a working lister must yield lines')
      assert.ok(
        lines.some(line => /^\s*\d+\s+\S/.test(line)),
        'every line must be "pid command" so the parser can read it',
      )
      assert.ok(
        lines.some(line => Number(line.match(/^\s*(\d+)/)[1]) > 0),
        'pids must be numeric',
      )
    }
    // processChildren / processGroupMembers must degrade to [] rather than throw
    // for pids that cannot exist (cancellation and sweep paths call them blind).
    assert.deepStrictEqual(await processChildren(0), [])
    assert.deepStrictEqual(await processChildren(-1), [])
    assert.deepStrictEqual(await processGroupMembers(0), [])
    // A family always contains its own anchor, even with no discoverable kin:
    // skipping the anchor is what makes "keep this service" meaningful.
    const solo = await serviceFamily(process.pid)
    assert.ok(solo.has(process.pid), 'the anchor pid is always in its own family')
    const empty = await serviceFamily(0)
    assert.strictEqual(empty.size, 0, 'no anchor means no family')
  }


  // Windows host identification, exercised from any OS.
  //
  // Found on real Windows 11 ARM64: `dshWebProcesses()` returned [] while
  // WMI clearly listed the host, because the node binary there is `node.exe`
  // (a pattern accepting only bare `node` matches nothing) and because the
  // guard wrapper's command line CONTAINS the service's argv, so a greedy
  // "everything before bin.js" capture produced the guard's whole command line
  // as the bin path. Both are asserted here, plus the argv[1]-only rule that
  // keeps the guard out even if its argv ever changes shape.
  {
    const svc = String.raw`C:\Users\u\tools\node\node.exe C:\Users\u\.dsh\runtime\x\node_modules\@deepseek-ai\dsh\lib\bin.js web --port 0`
    assert.strictEqual(
      windowsHostBin(svc),
      String.raw`C:\Users\u\.dsh\runtime\x\node_modules\@deepseek-ai\dsh\lib\bin.js`,
      'node.exe + runtime bin + web is a host (the .exe must not defeat the match)',
    )
    assert.strictEqual(
      windowsHostBin(String.raw`C:\n\node.exe C:\r\apps\cli\lib\bin.js web --port 0`),
      String.raw`C:\r\apps\cli\lib\bin.js`,
      'the repo layout (apps/cli) is a host too',
    )
    assert.strictEqual(
      windowsHostBin(String.raw`"C:\Program Files\nodejs\node.exe" "C:\u\.dsh\node_modules\@deepseek-ai\dsh\lib\bin.js" web`),
      String.raw`C:\u\.dsh\node_modules\@deepseek-ai\dsh\lib\bin.js`,
      'quoted paths (Program Files) stay one token',
    )
    // NEVER a host: the guard wrapper, an unrelated app, a non-web subcommand,
    // and the Electron binary itself.
    assert.strictEqual(
      windowsHostBin(`C:\\n\\node.exe C:\\r\\src\\service-guard.js 42 ${svc}`),
      '',
      'the guard wrapper must not read as a host even though it contains the argv',
    )
    assert.strictEqual(windowsHostBin(String.raw`node.exe C:\other\app.js`), '', 'an unrelated node app is not a host')
    assert.strictEqual(
      windowsHostBin(String.raw`node.exe C:\x\node_modules\@deepseek-ai\dsh\lib\bin.js plugin add foo`),
      '',
      'only the web subcommand counts',
    )
    assert.strictEqual(
      windowsHostBin(String.raw`C:\app\DeepSeek Harness.exe C:\x\node_modules\@deepseek-ai\dsh\lib\bin.js web`),
      '',
      'a non-node executable is not a host',
    )
  }

  // Home ownership is boundary-aware: a sibling directory that merely shares a
  // prefix (`.dsh` vs `.dsh-dev`) must never be adopted — that would let the
  // sweep kill a bystander's healthy instance.
  {
    const home = String.raw`C:\Users\u\.dsh`
    assert.strictEqual(commandMentionsPath(`node "${home}\\runtime\\x\\bin.js" web`, home), true)
    assert.strictEqual(commandMentionsPath(String.raw`node "C:\Users\u\.dsh-dev\runtime\x\bin.js" web`, home), false,
      'a prefix-sharing sibling home is not ours')
    assert.strictEqual(commandMentionsPath(`node ${home} --x`, home), true, 'a bare quoted home matches')
    assert.strictEqual(commandMentionsPath(String.raw`node C:\other\bin.js`, home), false)
    assert.strictEqual(commandMentionsPath('/home/u/.dsh/runtime/x/bin.js web', '/home/u/.dsh'), true)
    assert.strictEqual(commandMentionsPath('/home/u/.dsh-dev/runtime/x/bin.js web', '/home/u/.dsh'), false)
  }


  // There must be NO harness-version ceiling.
  //
  // One existed (SHELL_COMPAT.maxHarness) and failed twice over: it was pinned
  // to 0.2.0 in 2026-08 and never updated while the harness moved through 0.2.1
  // and 0.2.2-alpha.2, and it could not even be read for months (hostVersion()
  // pointed at a source checkout absent from artifact installs), so it was
  // silently dead. The one time it spoke it wrongly told the user to upgrade a
  // working install. A curated ceiling needs someone to keep it in sync with a
  // fast-moving harness; that already failed, so the check is gone rather than
  // merely retuned. Real incompatibilities surface as concrete connect errors.
  {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8')
    assert.ok(
      !/SHELL_COMPAT/u.test(source),
      'no harness-version ceiling may come back — it cannot be kept current',
    )
    assert.ok(
      !/checkHostCompatibility/u.test(source),
      'the compatibility check must stay removed',
    )
    // The dialog title the user reported must not be reachable any more.
    assert.ok(
      !/桌面壳版本过低/u.test(source),
      'the "桌面壳版本过低" warning must be gone',
    )
  }

  // A failed connect must NEVER look like a hang.
  //
  // The old code retried twice in total silence and only then showed a MODAL
  // error box. On a clean Windows install (no node anywhere) that produced the
  // exact reported symptom: the loading panel counted "已等待 Ns" forever over a
  // log that never mentioned the failure, because the reason only ever reached
  // the third attempt's blocking dialog.
  {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8')
    // Take EVERYTHING from the handler to the next top-level function: a
    // non-greedy "up to the first \n}" stops inside the nested setTimeout/if
    // blocks and would then miss code that lives further down (which is exactly
    // how a deleted pendingOpen clear slipped past an earlier version of this
    // assertion).
    const start = source.indexOf('function onSessionConnectFailed(')
    assert.ok(start !== -1, 'onSessionConnectFailed must exist')
    const rest = source.slice(start)
    const nextFn = rest.slice(1).search(/\n(?:async )?function /u)
    const body = nextFn === -1 ? rest : rest.slice(0, nextFn + 1)
    // The failure reason must be logged BEFORE any retry branch, so attempt #1
    // already tells the user why.
    const firstLog = body.indexOf('connection.log')
    const retryGate = body.indexOf('autoReconnectAttempts <= 2')
    assert.ok(firstLog !== -1, 'the failure must be logged at all')
    assert.ok(
      firstLog < retryGate,
      'the error must be logged before the retry branch, so a first failure is never silent',
    )
    assert.ok(/详情|detail/u.test(body) || body.includes('error.message'), 'the message itself must reach the log')
    // A modal dialog must not be the only way the user learns about it.
    assert.ok(
      !/dialog\.showErrorBox\(\s*'连接失败'/u.test(body),
      'connect failures must not rely on a blocking showErrorBox',
    )
    // pendingOpen pins the loading panel; leaving it set is what keeps the
    // "正在连接 · 已等待 N 秒" counter alive over a dead connect. Check it inside
    // THIS handler — a match anywhere in main.js would let the fix be deleted.
    assert.ok(
      /workspace\.pendingOpen\s*=\s*false/u.test(body),
      'a failed connect must clear pendingOpen inside the handler',
    )
    // And the banner must actually be installed on the workspace(s).
    assert.ok(
      /setProgress\(workspace,\s*progress\)/u.test(body),
      'a failed connect must install a visible failure banner',
    )
    // The banner's 重试 button must name an action the shell actually handles.
    // It said `reconnect` for a while, which no `case` matches, so the most
    // prominent button on the error card did nothing.
    assert.ok(
      !/name:\s*'reconnect'/u.test(body),
      "the failure banner must not use the unhandled 'reconnect' action",
    )
    assert.ok(
      /name:\s*'retry-connect'/u.test(body),
      "the failure banner's 重试 must use the handled 'retry-connect' action",
    )
    // The banner must be TAGGED, so a later status transition can tell it apart
    // from a genuinely blocking init/update banner and clear exactly this one.
    assert.ok(
      /kind:\s*CONNECT_FAILED_BANNER/u.test(body),
      'the connect-failure banner must be tagged with its kind',
    )
    for (const [label, name] of [['retry-connect', 'retry-connect'], ['dismiss-progress', 'dismiss-progress']]) {
      assert.ok(
        new RegExp(`case '${name}':`, 'u').test(source),
        `the failure banner action ${label} must have a handler`,
      )
    }
  }

  // A recovered connection must never keep showing the failure card.
  //
  // The reported symptom: the harness tab sat on "连接失败 / 等待 dsh web 报告
  // 实际端口超时" over a service that was up and serving, while the settings
  // page — reading the connection status instead of the banner — correctly said
  // 已连接. Two surfaces of one session disagreed, so nothing looked broken
  // enough to investigate. The banner lives in `workspace.progress`, which
  // updateHarnessVisibility treats as a hard "do not show the web view", and
  // nothing removed it after a successful retry.
  {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8')
    const start = source.indexOf('function onSessionStatus(')
    assert.ok(start !== -1, 'onSessionStatus must exist')
    const rest = source.slice(start)
    const nextFn = rest.slice(1).search(/\n(?:async )?function /u)
    const body = nextFn === -1 ? rest : rest.slice(0, nextFn + 1)
    // Locate the clear statement and read BACKWARDS to the condition guarding
    // it. Asserting on the whole function body would pass even with the guard
    // removed, because the assignment itself would still be there.
    const clearAt = body.indexOf('workspace.progress = null')
    assert.ok(clearAt !== -1, 'a status update must clear the stale connect-failure banner')
    const guard = body.slice(Math.max(0, clearAt - 800), clearAt)
    assert.ok(
      /CONNECT_FAILED_BANNER/u.test(guard),
      'the guard must clear ONLY the connect-failure banner — init/update banners are real tasks',
    )
    assert.ok(
      /status\.state !== 'error'/u.test(guard),
      'the banner must be cleared on a non-error status (a recovered connect)',
    )
    // A failed connect leaves the tab with no URL loaded AND pendingOpen false,
    // so gating the harness sync on pendingOpen alone never pointed the view at
    // the live service after the auto-retry succeeded.
    assert.ok(
      /status\.state === 'ready' && \(workspace\.pendingOpen \|\| workspace\.loadedUrl === ''\)/u.test(body),
      'a ready status must sync the harness view even when the failure cleared pendingOpen',
    )
  }

  // The port-announce wait is a COLD-START budget.
  //
  // `dsh web` prints its URL only after the plugin loader settles and the
  // startup audit finishes. At 30s a slow first boot (Windows arm64 VM, cold
  // antivirus scan, empty caches) was killed mid-boot and immediately
  // respawned; the warm second spawn then reported ready, producing the
  // reported "连接失败 → 10 秒后自动重试 → ready" sequence that made a healthy
  // service look broken on its first attempt.
  {
    const { PORT_ANNOUNCE_TIMEOUT_MS } = require('../src/connection')
    assert.ok(
      Number.isInteger(PORT_ANNOUNCE_TIMEOUT_MS) && PORT_ANNOUNCE_TIMEOUT_MS >= 90_000,
      `the port-announce budget must fit a cold boot, got ${String(PORT_ANNOUNCE_TIMEOUT_MS)}`,
    )
  }

  // The detached worker must be able to bootstrap node itself.
  //
  // On a clean machine the shell hands the FIRST connect to the worker before
  // any toolchain exists; a worker that just errors out dead-ends the very
  // first run. Bootstrap is shared so the shell and worker cannot drift.
  {
    const { ensurePortableNode, PORTABLE_NODE_VERSION } = require('../src/node-bootstrap')
    assert.strictEqual(typeof ensurePortableNode, 'function', 'node bootstrap must be shared, not shell-only')
    assert.ok(/^\d+\.\d+\.\d+$/u.test(PORTABLE_NODE_VERSION), 'the vendored node version must be pinned')
    // Already-runnable hosts must not download anything.
    const skipped = await ensurePortableNode({
      toolRoot: path.join(os.tmpdir(), 'dsh-should-not-exist'),
      isRunnable: () => true,
      onLine: () => {},
    })
    assert.strictEqual(skipped.ok, true, 'an already-working node must short-circuit')
    assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'dsh-should-not-exist')), 'a working node must not create dirs')
    // The worker must reference it, not re-implement or skip it.
    // The worker must CALL it (an import alone would still dead-end), and must
    // not fall back to the old "no node -> throw" behaviour.
    const worker = fs.readFileSync(path.join(__dirname, '..', 'src', 'update-worker.js'), 'utf8')
    assert.ok(
      /await\s+ensurePortableNode\(/u.test(worker),
      'the update worker must CALL ensurePortableNode rather than fail on a clean machine',
    )
    assert.ok(
      !/if \(tools\.node === ''\)\s*\{\s*throw new Error\('未找到兼容的 node/u.test(worker),
      'the worker must not hard-fail when no node is found',
    )
    const shell = fs.readFileSync(path.join(__dirname, '..', 'src', 'update.js'), 'utf8')
    assert.ok(
      /await\s+ensurePortableNode\(/u.test(shell),
      'the shell must use the same bootstrap',
    )
  }


  // EVERY runtimeStore.<name> used anywhere in src/ must actually be exported.
  //
  // This class of bug is brutal because the call site looks fine, the failure
  // is a TypeError at RUNTIME, and it lands inside a promise whose rejection the
  // shell used to swallow — so the whole app just sat on "正在连接" forever with
  // an empty log. Found live on Windows 11 ARM64:
  //   ✗ 任务异常终止：runtimeStore.localRuntimeRoot is not a function
  // That one missing export dead-ended EVERY first connect, on every platform.
  {
    const runtimeStore = require('../src/runtime-store')
    const srcDir = path.join(__dirname, '..', 'src')
    const used = new Set()
    for (const name of fs.readdirSync(srcDir)) {
      if (!name.endsWith('.js')) continue
      const text = fs.readFileSync(path.join(srcDir, name), 'utf8')
      for (const match of text.matchAll(/runtimeStore\.([A-Za-z_][A-Za-z0-9_]*)/gu)) used.add(match[1])
    }
    assert.ok(used.size > 20, `expected many runtimeStore accesses, saw ${used.size}`)
    const missing = [...used].filter(key => runtimeStore[key] === undefined).sort()
    assert.deepStrictEqual(
      missing,
      [],
      `runtime-store does not export: ${missing.join(', ')} — every call site would throw at runtime`,
    )
    // The specific regression.
    assert.strictEqual(typeof runtimeStore.localRuntimeRoot, 'function', 'localRuntimeRoot must stay exported')
  }

  // The update worker's own spawn path must be reachable end to end.
  //
  // spawnUpdateWorker writes the task file under the runtime root BEFORE
  // spawning, so if that step throws, no worker exists, no status file appears,
  // and the shell waits forever. Assert the function it calls is callable.
  {
    const runtimeStore = require('../src/runtime-store')
    const settings = { mode: 'local', local: { dshHome: os.tmpdir(), repoDir: '' }, toolPaths: {}, update: {} }
    const root = runtimeStore.localRuntimeRoot(settings)
    assert.ok(typeof root === 'string' && root.includes('runtime'), `runtime root must be a path, got ${root}`)
    // Every export the worker touches.
    for (const name of ['buildLockName', 'localVersionDir', 'localRuntimeRoot', 'withLocalLock', 'writeUpdateStatus', 'clearPendingUpdate', 'clearCancelToken', 'readCancelToken', 'activateLocalRuntime']) {
      assert.strictEqual(typeof runtimeStore[name], 'function', `worker dependency runtimeStore.${name} must be exported`)
    }
  }

  // A killTree on a dead pid is a no-op rather than a throw: cancellation paths
  // call it on children that may already have exited.
  {
    assert.strictEqual(killTree(0), false)
    assert.strictEqual(killTree(-1), false)
    assert.strictEqual(killTree(2 ** 30), false, 'a pid that cannot exist must not throw')
  }

  // ── Windows branch, executed on every host ───────────────────────────────
  // platform.js / tools.js / settings.js read process.platform at require
  // time, so a fresh copy of each is loaded with platform faked to win32. This
  // is how the Windows side gets real coverage on a macOS/Linux CI runner; the
  // only thing it cannot prove is a call that needs a real Windows binary.
  {
    // Every platform-aware module must be re-required inside the fake window:
    // `tools`/`settings` capture IS_WINDOWS from `platform` at require time, so
    // loading them alone would silently reuse the POSIX copy of platform.js
    // (which is exactly the mistake this test caught once already).
    const load = modulePath => {
      const chain = ['../src/platform', '../src/process-scan', '../src/tools', '../src/settings']
      const saved = chain.map(entry => {
        const resolved = require.resolve(entry)
        const cached = require.cache[resolved]
        delete require.cache[resolved]
        return { resolved, cached }
      })
      const frozen = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      try {
        return require(require.resolve(modulePath))
      } finally {
        Object.defineProperty(process, 'platform', frozen)
        for (const entry of saved) {
          delete require.cache[entry.resolved]
          if (entry.cached !== undefined) require.cache[entry.resolved] = entry.cached
        }
      }
    }
    const win = load('../src/platform')
    assert.strictEqual(win.IS_WINDOWS, true, 'faked platform must reach platform.js')
    assert.deepStrictEqual(win.executableNames('node'), ['node.exe', 'node.cmd', 'node.bat', 'node'])
    assert.strictEqual(win.PATH_DELIMITER, ';', 'Windows PATH separator')
    assert.strictEqual(win.PATH_KEY, 'Path', 'Windows spells the PATH key Path')
    assert.strictEqual(win.needsShell('npm.cmd'), true, 'npm.cmd needs cmd.exe')
    assert.strictEqual(win.needsShell('node.exe'), false, 'node.exe runs directly')

    // A batch shim is launched through cmd.exe with verbatim arguments, and
    // every path/arg with spaces stays one token.
    const shim = win.spawnInvocation('C:\\Program Files\\nodejs\\npm.cmd', ['install', '--prefix', 'C:\\a b'])
    assert.ok(/cmd\.exe$/i.test(shim.cmd), 'a .cmd shim must run under cmd.exe')
    assert.deepStrictEqual(shim.args.slice(0, 3), ['/d', '/s', '/c'])
    assert.strictEqual(shim.options.windowsVerbatimArguments, true,
      'the pre-quoted line must reach cmd.exe untouched')
    const line = shim.args[3]
    assert.ok(line.includes('C:\\Program Files\\nodejs\\npm.cmd'), 'the shim path survives: ' + line)
    assert.ok(line.includes('\"C:\\a b\"'), 'a spaced argument stays one token: ' + line)
    assert.ok(line.indexOf(String.fromCharCode(39)) === -1, 'POSIX quoting must never reach cmd.exe')
    assert.strictEqual(win.spawnInvocation('C:\\nodejs\\node.exe', ['x']).cmd, 'C:\\nodejs\\node.exe')

    // Windows node distributions are zips named -win-<cpu>.zip.
    const winDist = win.nodeDistArchive('22.19.0', 'arm64')
    assert.strictEqual(winDist.kind, 'zip')
    assert.ok(winDist.url.includes('win-arm64.zip'), winDist.url)
    // OpenSSH ships inside System32 on Windows and must be on the clean PATH,
    // otherwise remote mode cannot find ssh.exe.
    assert.ok(win.SYSTEM_PATH_DIRS.some(dir => String(dir).toLowerCase().includes('openssh')),
      'System32\\OpenSSH must be on the system PATH list')
    assert.ok(win.expandHome('~\\x').endsWith('x'), 'backslash home paths expand')

    // The clean child environment keys PATH as Path AND keeps both spellings in
    // sync — writing only PATH leaves cmd.exe reading a stale value.
    const winTools = load('../src/tools')
    const winEnv = winTools.childEnv(
      { local: { repoDir: 'C:\\work\\deepseek-harness' }, toolPaths: {} },
      'C:\\nodejs\\node.exe',
    )
    assert.strictEqual(typeof winEnv.Path, 'string')
    assert.strictEqual(winEnv.PATH, winEnv.Path, 'PATH and Path must agree on Windows')
    assert.ok(winEnv.Path.split(';').some(part => part.includes('deepseek-harness')),
      'the repo toolchain must be on the Windows PATH')

    // A settings file carried over from macOS names a shell Windows cannot run;
    // normalization must swap in this platform's default.
    const winSettings = load('../src/settings')
    const swapped = winSettings.normalizeSettings({ toolPaths: { shell: '/bin/zsh' } })
    assert.notStrictEqual(swapped.toolPaths.shell, '/bin/zsh',
      'a POSIX shell path must not survive on Windows')
  }
  console.log('smoke: all checks passed')
}

main().catch(error => {
  console.error(`smoke failed: ${error.message}`)
  process.exit(1)
})
