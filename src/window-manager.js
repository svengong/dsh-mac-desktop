'use strict'

/**
 * WindowManager — VS Code-inspired window bookkeeping for the shell.
 *
 * The shell keeps one BrowserWindow per workspace. This module owns the parts
 * that must survive beyond the in-memory `workspaces` map:
 *
 * - last active workspace id / device key,
 * - per-device bounds and active view,
 * - persistence to `<userData>/window-state.json`.
 *
 * It is intentionally plain Node (no Electron import) so it can be
 * smoke-tested and reused if the shell ever grows auxiliary windows.
 */

const fs = require('node:fs')
const path = require('node:path')

function normalizeDeviceKey(value, fallback = 'local') {
  return typeof value === 'string' && value !== '' ? value : fallback
}

function normalizeBounds(value, fallback) {
  if (value === null || typeof value !== 'object') return fallback
  const width = Number(value.width)
  const height = Number(value.height)
  const x = Number(value.x)
  const y = Number(value.y)
  if (!Number.isFinite(width) || width < 900) return fallback
  if (!Number.isFinite(height) || height < 600) return fallback
  const bounds = { width: Math.round(width), height: Math.round(height) }
  if (Number.isFinite(x)) bounds.x = Math.round(x)
  if (Number.isFinite(y)) bounds.y = Math.round(y)
  return bounds
}

function emptyState() {
  return {
    version: 1,
    lastActiveDeviceKey: 'local',
    lastActiveWorkspaceId: null,
    windows: {},
  }
}

function normalizeState(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const windows = {}
  for (const [id, entry] of Object.entries(source.windows ?? {})) {
    if (entry === null || typeof entry !== 'object') continue
    windows[id] = {
      deviceKey: normalizeDeviceKey(entry.deviceKey),
      bounds: normalizeBounds(entry.bounds, null),
      activeView: typeof entry.activeView === 'string' ? entry.activeView : 'harness',
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
    }
  }
  return {
    version: 1,
    lastActiveDeviceKey: normalizeDeviceKey(source.lastActiveDeviceKey),
    lastActiveWorkspaceId: Number.isInteger(source.lastActiveWorkspaceId) ? source.lastActiveWorkspaceId : null,
    windows,
  }
}

class WindowManager {
  /**
   * @param {string} stateFile - absolute path to `<userData>/window-state.json`.
   */
  constructor(stateFile) {
    this.stateFile = stateFile
    this.state = emptyState()
    this.load()
    this.saveTimer = null
  }

  load() {
    try {
      this.state = normalizeState(JSON.parse(fs.readFileSync(this.stateFile, 'utf8')))
    } catch {
      this.state = emptyState()
    }
    return this.state
  }

  /** Persist immediately; the file is tiny and window changes are infrequent. */
  save() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true })
      const tmp = `${this.stateFile}.tmp`
      fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`)
      fs.renameSync(tmp, this.stateFile)
    } catch {
      // Window restore is best-effort; a read-only userData must not break app.
    }
  }

  /** Debounced save for resize bursts. */
  scheduleSave() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.save()
    }, 300)
  }

  /**
   * Record the workspace that currently owns the user's attention. A
   * detached window has no terminal and must not overwrite the last ACTIVE
   * TERMINAL: startup should still restore the most recent bound device.
   */
  markActive(workspace) {
    if (workspace === null || typeof workspace !== 'object') return
    this.state.lastActiveWorkspaceId = workspace.id
    if (workspace.deviceKey === null || workspace.deviceKey === undefined) {
      // Keep the previous terminal; only the workspace-id changes.
    } else {
      this.state.lastActiveDeviceKey = normalizeDeviceKey(workspace.deviceKey)
    }
    this.touch(workspace)
  }

  /** Record the current shape of one workspace window. */
  touch(workspace, bounds = null) {
    if (workspace === null || typeof workspace !== 'object') return
    const win = workspace.window
    let nextBounds = bounds
    if (nextBounds === null && win !== null && win !== undefined && !win.isDestroyed()) {
      nextBounds = win.getBounds()
    }
    const previous = this.state.windows[workspace.id] ?? {}
    this.state.windows[workspace.id] = {
      // Persist detached windows as a neutral key so they never masquerade
      // as the local terminal for bounds/last-active-device restoration.
      deviceKey: workspace.deviceKey === null || workspace.deviceKey === undefined
        ? 'detached'
        : normalizeDeviceKey(workspace.deviceKey),
      bounds: normalizeBounds(nextBounds, previous.bounds),
      activeView: workspace.activeView || previous.activeView || 'harness',
      updatedAt: new Date().toISOString(),
    }
    const ids = Object.keys(this.state.windows)
    if (ids.length > 12) {
      const oldest = ids
        .sort((a, b) => String(this.state.windows[a].updatedAt).localeCompare(String(this.state.windows[b].updatedAt)))
        .slice(0, ids.length - 12)
      for (const id of oldest) delete this.state.windows[id]
    }
    this.scheduleSave()
  }

  forget(workspaceId) {
    delete this.state.windows[workspaceId]
    if (this.state.lastActiveWorkspaceId === workspaceId) this.state.lastActiveWorkspaceId = null
    this.save()
  }

  /** Most recently used workspace still alive in the provided map. */
  lastActiveWorkspace(workspaces) {
    const preferred = this.state.lastActiveWorkspaceId
    for (const workspace of workspaces.values()) {
      if (workspace.id === preferred && workspace.window !== null && !workspace.window.isDestroyed()) {
        return workspace
      }
    }
    return null
  }

  /** Bounds that should be used when opening a window for `deviceKey`. */
  boundsFor(deviceKey) {
    const entries = Object.values(this.state.windows)
      .filter(entry => entry.deviceKey === deviceKey && entry.bounds !== null)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    return entries[0]?.bounds ?? null
  }

  /** Device that owned the most recently used window. */
  lastActiveDeviceKey() {
    return this.state.lastActiveDeviceKey
  }

  /** Workspace id that owned the most recently used window. */
  get lastActiveWorkspaceId() {
    return this.state.lastActiveWorkspaceId
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state))
  }
}

module.exports = { WindowManager, normalizeBounds, normalizeState }
