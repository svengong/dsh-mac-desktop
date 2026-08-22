'use strict'

/**
 * UpdateManager — the shell's unified update surface.
 *
 * Only the built-in `harness` component is managed. It delegates to the
 * existing Updater pipeline (official npm artifact → atomic switch → restart).
 * Only Harness is supported.
 *
 * The class is plain Node (no Electron) so it is smoke-testable; window and
 * menu wiring live in main.js.
 */

const {
  componentView, DEFAULT_COMPONENTS,
} = require('./components')

const { request } = require('node:https')
const { URL } = require('node:url')

const NETWORK_TIMEOUT_MS = 20 * 1000

/**
 * Fetch one JSON document over HTTPS with a hard timeout and bounded redirects.
 * @param {string} url - absolute https URL.
 * @param {number} timeoutMs - per-attempt timeout.
 * @param {number} redirects - remaining redirect budget.
 * @returns {Promise<object>} parsed JSON body.
 */
function fetchJson(url, timeoutMs = NETWORK_TIMEOUT_MS, redirects = 3) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch (error) {
      reject(new Error(`无效的 registry URL：${url}`))
      return
    }
    if (target.protocol !== 'https:') {
      reject(new Error(`registry 必须使用 https：${url}`))
      return
    }
    const req = request(target, { method: 'GET', headers: { accept: 'application/json' } }, response => {
      if (response.statusCode !== undefined && response.statusCode >= 300 && response.statusCode < 400) {
        const location = response.headers.location
        response.resume()
        if (redirects > 0 && typeof location === 'string' && location !== '') {
          fetchJson(new URL(location, target).toString(), timeoutMs, redirects - 1).then(resolve, reject)
        } else {
          reject(new Error(`registry 重定向失败（${response.statusCode}）`))
        }
        return
      }
      if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume()
        reject(new Error(`registry 返回 HTTP ${response.statusCode ?? '未知'}：${url}`))
        return
      }
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          reject(new Error(`registry 响应不是 JSON：${error.message}`))
        }
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求 registry 超时（${timeoutMs / 1000} 秒）`)))
    req.on('error', error => reject(new Error(`请求 registry 失败：${error.message}`)))
    req.end()
  })
}


/** State each runtime component row carries between checks. */
function blankRow(def) {
  return {
    ...componentView(def),
    status: 'idle',
    current: '',
    latest: '',
    updateAvailable: false,
    summary: '尚未检查',
    error: '',
  }
}

class UpdateManager {
  /**
   * @param {object} deps - shell wiring.
   * @param {() => object} deps.getSettings - current normalized settings.
   * @param {(patch: object) => object} deps.saveUpdate - persist partial `update` section.
   * @param {object} deps.connection - ConnectionManager instance.
   * @param {object} deps.harnessUpdater - existing Updater instance.
   * @param {(line: string) => void} deps.onLog - line sink (session log + panels).
   * @param {() => void} deps.onState - fired after every state mutation.
   */
  constructor({ getSettings, saveUpdate, connection, harnessUpdater, onLog, onState }) {
    this.getSettings = getSettings
    this.saveUpdate = saveUpdate
    this.connection = connection
    this.harnessUpdater = harnessUpdater
    this.owner = () => connection.owner()
    this.onLog = onLog || (() => {})
    this.onState = onState || (() => {})
    this.busy = false
    this.rows = new Map()
    this.settings = getSettings()
    this.reloadComponents()
  }

  log(line) {
    this.onLog(line)
  }

  emit() {
    this.onState()
  }

  setBusy(value) {
    if (this.busy === value) return
    this.busy = value
    this.emit()
  }

  /** Re-read persisted component definitions (only the built-in harness). */
  reloadComponents() {
    const update = this.settings.update
    const defs = Array.isArray(update?.components) ? update.components : DEFAULT_COMPONENTS
    const next = new Map()
    for (const def of defs) {
      const previous = this.rows.get(def.id)
      const row = blankRow(def)
      if (previous !== undefined) {
        Object.assign(row, {
          status: previous.status,
          current: previous.current,
          latest: previous.latest,
          updateAvailable: previous.updateAvailable,
          summary: previous.summary,
          error: previous.error,
        })
      }
      next.set(def.id, row)
    }
    this.rows = next
  }

  patchRow(id, patch) {
    const row = this.rows.get(id)
    if (row === undefined) return
    this.rows.set(id, { ...row, ...patch })
    this.emit()
  }

  /** JSON-safe snapshot for the renderer, menu labels, and notifications. */
  snapshot() {
    const components = [...this.rows.values()]
    const available = components.filter(row => row.enabled && row.updateAvailable)
    return {
      busy: this.busy,
      autoCheckOnLaunch: this.settings.update?.autoCheckOnLaunch !== false,
      lastCheckAt: this.settings.update?.lastCheckAt ?? '',
      components,
      available,
    }
  }

  enabledComponents() {
    return [...this.rows.values()].filter(row => row.enabled)
  }

  component(id) {
    const row = this.rows.get(id)
    if (row === undefined) throw new Error(`未知更新组件：${id}`)
    return row
  }

  // ── component checks ───────────────────────────────────────────────────────

  async checkHarness() {
    this.patchRow('harness', { status: 'checking', summary: '查询官方产物版本…', error: '' })
    const facts = await this.harnessUpdater.check()
    if (!facts.artifact.ok) {
      this.patchRow('harness', {
        status: 'error',
        current: '',
        summary: facts.summary,
        error: facts.summary,
      })
      return
    }
    this.patchRow('harness', {
      status: 'ready',
      current: facts.currentNpm !== '' ? `v${facts.currentNpm}` : '未安装',
      latest: `v${facts.artifact.version}`,
      updateAvailable: facts.updateAvailable,
      summary: facts.summary,
      error: '',
    })
  }

  /** Check one component by id; a per-row failure becomes its error state. */
  async checkOne(id) {
    if (this.busy) return this.snapshot()
    this.setBusy(true)
    this.settings = this.getSettings()
    this.reloadComponents()
    try {
      const def = this.component(id)
      if (!def.enabled) throw new Error(`组件已停用：${def.title}`)
      if (def.kind !== 'harness') throw new Error(`未知组件类型：${def.kind}`)
      await this.checkHarness()
      this.saveUpdate({ lastCheckAt: new Date().toISOString() })
      this.settings = this.getSettings()
      return this.snapshot()
    } catch (error) {
      this.patchRow(id, { status: 'error', summary: '检查失败', error: error.message })
      throw error
    } finally {
      this.setBusy(false)
    }
  }

  /** Check every enabled component; one failure never skips the others. */
  async checkAll() {
    if (this.busy) return this.snapshot()
    this.setBusy(true)
    this.settings = this.getSettings()
    this.reloadComponents()
    const checks = this.enabledComponents().map(async row => {
      const def = this.rows.get(row.id)
      try {
        if (def.kind !== 'harness') throw new Error(`未知组件类型：${def.kind}`)
        await this.checkHarness()
      } catch (error) {
        this.patchRow(row.id, { status: 'error', summary: '检查失败', error: error.message })
        this.onLog(`✗ 检查失败：${error.message}`)
      }
    })
    await Promise.all(checks)
    const lastCheckAt = new Date().toISOString()
    this.saveUpdate({ lastCheckAt })
    this.settings = this.getSettings()
    this.setBusy(false)
    return this.snapshot()
  }

  // ── component updates ──────────────────────────────────────────────────────

  async updateHarness() {
    this.patchRow('harness', {
      status: 'updating',
      summary: '下载官方产物 → 原子切换 current → 重启服务',
      error: '',
    })
    const outcome = await this.harnessUpdater.runPipeline({ includePull: true })
    if (!outcome.ok) {
      const summary = outcome.rolledBack === true
        ? `新版本启动失败，已回滚到 ${outcome.rollbackVersion}`
        : '更新失败'
      this.patchRow('harness', { status: 'error', summary, error: outcome.error?.message ?? summary })
      throw outcome.error ?? new Error(summary)
    }
    this.patchRow('harness', { status: 'ready', summary: '已更新、原子切换并重启', updateAvailable: false })
    return true
  }

  async restartService() {
    this.log('重启 DSH 服务使更新生效…')
    await this.connection.restartService()
  }

  /** Update one component; only the built-in Harness is supported. */
  async updateOne(id) {
    if (this.busy) throw new Error('已有更新任务执行中')
    this.settings = this.getSettings()
    this.reloadComponents()
    const def = this.component(id)
    if (!def.enabled) throw new Error(`组件已停用：${def.title}`)
    this.setBusy(true)
    try {
      if (def.kind !== 'harness') throw new Error(`未知组件类型：${def.kind}`)
      await this.updateHarness()
      return { ok: true, restarted: true }
    } finally {
      this.setBusy(false)
    }
  }

  /** Update the available Harness component (the only managed component). */
  async updateAll() {
    if (this.busy) throw new Error('已有更新任务执行中')
    this.settings = this.getSettings()
    this.reloadComponents()
    const harness = this.rows.get('harness')
    if (harness === undefined || !harness.enabled || !harness.updateAvailable) {
      await this.checkAll()
      return { ok: true, changed: [], restarted: false }
    }
    this.setBusy(true)
    try {
      await this.updateHarness()
      this.log('\n更新完成。')
      return { ok: true, changed: ['harness'], restarted: true }
    } finally {
      this.setBusy(false)
    }
  }

  /** Notification key for the currently available set (dedupe auto prompts). */
  notificationKey() {
    return this.snapshot().available
      .map(row => `${row.id}:${row.latest}`)
      .sort()
      .join('|')
  }
}

module.exports = { UpdateManager, fetchJson }
