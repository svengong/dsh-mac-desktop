'use strict'

/**
 * Runtime layout resolution.
 *
 * A runtime directory can be materialized in two shapes:
 *
 * - `repo`: a full harness source checkout built in place
 *   (`<dir>/apps/cli/lib/bin.js`) — the git worktree / source-build path;
 * - `npm`: an npm-installed official artifact
 *   (`<dir>/node_modules/@deepseek-ai/dsh/lib/bin.js`) — the artifact path
 *   (Phase 2). The CLI resolves its own deps from that node_modules; the
 *   shell only ever spawns the recorded bin with a clean env + DSH_HOME.
 *
 * Every bin lookup in the shell goes through this module so a runtime dir
 * never has to be the repo layout again.
 */

const fs = require('node:fs')
const path = require('node:path')

const NPM_PACKAGE = '@deepseek-ai/dsh'
const REPO_BIN = ['apps', 'cli', 'lib', 'bin.js']
const NPM_BIN = ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js']

/** Detect which layout a runtime directory uses. `null` when neither exists. */
function runtimeLayout(runtimeDir) {
  if (runtimeDir === null || runtimeDir === undefined || runtimeDir === '') return null
  try {
    if (fs.existsSync(path.join(runtimeDir, ...REPO_BIN))) {
      return { kind: 'repo', bin: path.join(runtimeDir, ...REPO_BIN), cwd: runtimeDir }
    }
  } catch {
    // Fall through to the npm probe.
  }
  try {
    if (fs.existsSync(path.join(runtimeDir, ...NPM_BIN))) {
      return { kind: 'npm', bin: path.join(runtimeDir, ...NPM_BIN), cwd: runtimeDir }
    }
  } catch {
    // No layout.
  }
  return null
}

/** The CLI bin of a built runtime dir, or null when it is not built. */
function runtimeBin(runtimeDir) {
  const layout = runtimeLayout(runtimeDir)
  return layout === null ? null : layout.bin
}

/** Whether a runtime dir looks built (any layout). */
function runtimeIsBuilt(runtimeDir) {
  return runtimeBin(runtimeDir) !== null
}

/**
 * Version token for an npm-layout runtime (`npm:<version>`), read from the
 * installed package manifest. Returns '' when the manifest is unreadable so
 * callers can fall back to mtime tokens.
 */
function npmArtifactVersion(runtimeDir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(runtimeDir, 'node_modules', NPM_PACKAGE, 'package.json'), 'utf8',
    ))
    if (typeof manifest.version === 'string' && manifest.version !== '') {
      return `npm:${manifest.version}`
    }
  } catch {
    // Unreadable manifest.
  }
  return ''
}

module.exports = { NPM_PACKAGE, runtimeLayout, runtimeBin, runtimeIsBuilt, npmArtifactVersion }
