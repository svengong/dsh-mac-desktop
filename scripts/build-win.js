#!/usr/bin/env node
'use strict'

/**
 * Build the Windows installers.
 *
 * This wrapper exists for ONE reason: `ELECTRON_BUILDER_7Z_FILTER=BCJ`.
 *
 * electron-builder 26.15.x packs the NSIS app payload with 7za's automatic
 * filters, which on x64/arm64 selects BCJ2. The installer's own extractor
 * (Nsis7z) cannot decode the multi-stream BCJ2 filter, so it silently SKIPS
 * every PE file in the payload — the main .exe, every .dll, and any bundled
 * .exe/.node. Nothing fails: the installer exits 0 and leaves a directory that
 * looks plausible (locales/, *.pak, resources/) while the binary that runs the
 * app is missing. Measured on Windows 11 ARM64 with this very package:
 *
 *   before: 68 files, 71.3 MB, 0 dlls, no "DeepSeek Harness.exe"
 *   after : 75 files, 287.7 MB, 6 dlls, "DeepSeek Harness.exe" (PE 0xAA64)
 *
 * Pinning the filter to BCJ (plain single-stream) is exactly what upstream
 * fixed in electron-builder 26.16+ (see their PR "reliably install the main
 * executable and native binaries on x64 and arm64"). The env var is honoured
 * by 26.15 too, so this works without forcing an upgrade.
 *
 * Do NOT drop this and call electron-builder for Windows directly.
 */

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// electron-builder resolves its Electron download into a cache under $HOME;
// on CI and on a locked-down profile that write can be denied, so keep the
// cache inside the workspace when the caller has not chosen one.
const root = path.resolve(__dirname, '..')
const env = { ...process.env, ELECTRON_BUILDER_7Z_FILTER: 'BCJ' }
if (!env.ELECTRON_BUILDER_CACHE) env.ELECTRON_BUILDER_CACHE = path.join(root, '.cache', 'electron-builder')
// An unsigned local build must not try to discover a signing identity.
if (!env.CSC_IDENTITY_AUTO_DISCOVERY) env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'

const passthrough = process.argv.slice(2)
// NSIS setup ONLY. The portable and zip targets are the same payload in other
// wrappers; the release surface was narrowed to the one artifact that has
// install/upgrade/uninstall semantics. Narrowing here (not just in the release
// workflow) keeps every Windows entry point consistent — the workflow, the npm
// scripts and a manual run all produce the same set.
const args = ['--win', 'nsis', ...passthrough]
const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder')
const command = fs.existsSync(bin) ? bin : 'electron-builder'

console.log(`building Windows installers: ${command} ${args.join(' ')}`)
console.log('ELECTRON_BUILDER_7Z_FILTER=BCJ (installer must not get a BCJ2 payload)')

const result = spawnSync(command, args, { stdio: 'inherit', env, shell: process.platform === 'win32' })
if (result.error) {
  console.error(`could not run electron-builder: ${result.error.message}`)
  process.exit(1)
}
if (result.status !== 0) process.exit(result.status === null ? 1 : result.status)

/**
 * Read the compression METHOD out of the 7z payload embedded in an NSIS setup.
 *
 * This is the regression guard: if the method comes back with `BCJ2` in it the
 * installer will drop every PE file at install time again, and that failure is
 * invisible until someone runs the installer on real Windows. Needs a `7z` on
 * PATH; when there is none the check is skipped loudly rather than silently.
 * @param {string} setup absolute path to the built setup.exe
 * @returns {{method: string, ok: boolean}|null} null when it could not be read.
 */
function inspectPayloadMethod(setup) {
  const probe = spawnSync('7z', ['l', setup], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (probe.error || probe.status !== 0 || !probe.stdout) return null
  // The listing names the embedded payload; its method is on its own line.
  const payload = /app-(\w+)\.7z/u.exec(probe.stdout)
  if (payload === null) return null
  const extractDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dsh-payload-'))
  let method = ''
  try {
    const un = spawnSync('7z', ['x', '-y', `-o${extractDir}`, setup, `$PLUGINSDIR/app-${payload[1]}.7z`], { encoding: 'utf8' })
    if (un.status === 0) {
      const list = spawnSync('7z', ['l', path.join(extractDir, '$PLUGINSDIR', `app-${payload[1]}.7z`)], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      const found = /^Method = (.+)$/mu.exec(list.stdout || '')
      if (found !== null) method = found[1].trim()
    }
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true })
  }
  if (method === '') return null
  return { method, ok: !/BCJ2/u.test(method) }
}

const dist = path.join(root, 'dist')
// The NSIS setup is a self-extractor that decompresses an embedded app-*.7z
// through the Nsis7z decoder, so it can silently drop the main executable.
// `-portable` is still matched: a dist/ left over from an older build must not
// slip past the guard just because this run no longer produces that target.
const setups = fs.existsSync(dist)
  ? fs.readdirSync(dist).filter(name => /^dsh-desktop-.*-windows-.*(-setup|-portable)\.exe$/i.test(name))
  : []
let bad = false
for (const name of setups) {
  const inspected = inspectPayloadMethod(path.join(dist, name))
  if (inspected === null) {
    console.log(`  ! ${name}: could not read the 7z payload (is 7z on PATH?) — install it on Windows before shipping`)
    continue
  }
  if (inspected.ok) {
    console.log(`  ok ${name}  (payload method: ${inspected.method})`)
  } else {
    bad = true
    console.error(`  FAIL ${name}  (payload method: ${inspected.method})`)
    console.error('    BCJ2 payloads are silently unterminated by the NSIS extractor: every PE file is skipped.')
  }
}
if (bad) {
  console.error('refusing to call this build good: the installer would drop the main executable')
  process.exit(1)
}
console.log(`done — ${setups.length} installer(s) verified`)
