'use strict'

/**
 * Official-artifact channel for the harness runtime (Phase 2).
 *
 * The harness publishes a prebuilt CLI to npm (`@deepseek-ai/dsh`), so the
 * shell can install a runtime WITHOUT a source checkout or a local pnpm
 * build — download → verify → atomic `current` switch, like VS Code's
 * extension/update model. This module owns:
 *
 * - `queryNpmArtifact`: registry preflight — latest version + whether the
 *   whole dependency chain is publishable (the CLI's web-app dependency
 *   `@deepseek-ai/dsh-frontend` has historically 404'd, which makes a raw
 *   `npm install` fail; the shell must detect that up front and surface a
 *   clear reason instead of a broken install);
 * - `installNpmArtifact`: `npm install --prefix <runtimeDir>` of the pinned
 *   spec into a fresh version dir (idempotent, resumable);
 * - `verifyNpmArtifact`: the installed bin exists and reports the expected
 *   package version before the dir is activated.
 */

const fs = require('node:fs')
const path = require('node:path')
const { fetchJson } = require('./update-manager')
const { runCommand } = require('./runner')
const { NPM_PACKAGE, npmArtifactVersion } = require('./runtime-layout')

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/**
 * Registry preflight for the official npm artifact. Returns the latest
 * version when the chain is complete, or a failure reason. Never throws.
 * @returns {object} {ok, version, reason} - reason is set when !ok.
 */
async function queryNpmArtifact({ registryUrl = '', timeoutMs = 20_000 } = {}) {
  const registry = String(registryUrl || DEFAULT_REGISTRY).replace(/\/$/, '')
  try {
    const meta = await fetchJson(`${registry}/${NPM_PACKAGE}`, timeoutMs)
    const latest = typeof meta['dist-tags']?.latest === 'string' ? meta['dist-tags'].latest : ''
    if (latest === '') return { ok: false, version: '', reason: `registry 未报告 ${NPM_PACKAGE} 的 latest 版本` }
    // The CLI's web boot depends on @deepseek-ai/dsh-web-app, which in turn
    // needs the published frontend dist. Probe that one package (the chain's
    // historical break point) so a broken chain falls back BEFORE install.
    const webApp = await fetchJson(`${registry}/@deepseek-ai%2Fdsh-web-app/latest`, timeoutMs)
    const webDeps = webApp?.dependencies ?? {}
    const frontendSpec = webDeps['@deepseek-ai/dsh-frontend'] ?? ''
    if (frontendSpec !== '') {
      try {
        await fetchJson(`${registry}/@deepseek-ai%2Fdsh-frontend/latest`, timeoutMs)
      } catch (error) {
        return {
          ok: false,
          version: latest,
          reason: `官方产物链不完整：${NPM_PACKAGE}@${latest} 依赖的 @deepseek-ai/dsh-frontend 未发布（${error.message}）。官方产物暂不可用，无法更新。`,
        }
      }
    }
    return { ok: true, version: latest, reason: '' }
  } catch (error) {
    return { ok: false, version: '', reason: `查询官方产物失败：${error.message}` }
  }
}

/**
 * Install the pinned official CLI into `runtimeDir` with `npm install --prefix`.
 * The runtime dir must already exist (created by the caller); node_modules is
 * created inside it. Returns the resolved bin path on success.
 * @param {object} options - nodeBin, npmBin, runtimeDir, spec, env, onLine, timeoutMs.
 */
async function installNpmArtifact({ nodeBin, npmBin, runtimeDir, spec, env, onLine, timeoutMs = 20 * 60_000, owner = null }) {
  const npm = npmBin !== '' && npmBin !== null && npmBin !== undefined
    ? npmBin
    : path.join(path.dirname(nodeBin), 'npm')
  if (!fs.existsSync(npm)) throw new Error(`npm 不可用：${npm}（便携版 node 应自带 npm）`)
  const result = await runCommand({
    cmd: npm,
    args: ['install', '--prefix', runtimeDir, '--no-audit', '--no-fund', spec],
    cwd: runtimeDir,
    env,
    timeoutMs,
    onLine: onLine === undefined ? undefined : line => onLine(`[npm] ${line}`),
    owner,
  })
  if (result.code !== 0) {
    const tail = result.lines.slice(-8).join('\n')
    throw new Error(`官方产物安装失败（退出码 ${result.code}）：${tail || '无输出'}`)
  }
  const version = verifyNpmArtifact(runtimeDir)
  if (version === '') throw new Error(`官方产物安装后校验失败：${runtimeDir}`)
  return version
}

/**
 * Verify an installed npm-layout runtime and return its version token
 * (`npm:<version>`), or '' when the bin/manifest is missing.
 */
function verifyNpmArtifact(runtimeDir) {
  try {
    const bin = path.join(runtimeDir, 'node_modules', NPM_PACKAGE, 'lib', 'bin.js')
    if (!fs.existsSync(bin)) return ''
    return npmArtifactVersion(runtimeDir)
  } catch {
    return ''
  }
}

module.exports = { DEFAULT_REGISTRY, queryNpmArtifact, installNpmArtifact, verifyNpmArtifact }
