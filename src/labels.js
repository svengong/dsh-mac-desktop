'use strict'

/**
 * Human-readable device labels shared by window titles, the workspace frame,
 * the application menu, and the tray. Keeping the formatting in one module
 * guarantees every surface spells the same terminal prefix: `DSH-[终端]`.
 */

const { parseTarget } = require('./ssh')

/** Short terminal/device name used inside `DSH-[...]`. */
function terminalLabel(settings) {
  if (settings === null || typeof settings !== 'object') return '本地'
  if (settings.mode !== 'ssh') return '本地'
  const target = typeof settings.ssh?.host === 'string' ? settings.ssh.host.trim() : ''
  if (target === '') return 'SSH'
  // Config aliases stay readable (`ubuntu`), custom targets collapse to the
  // host part (`dev@10.0.0.8:22` → `10.0.0.8`) so the window title stays short.
  const parsed = parseTarget(target)
  return parsed !== null && parsed.host !== '' ? parsed.host : target
}

/** `DSH-[终端]` prefix for titles and menu labels. */
function terminalPrefix(settings) {
  return `DSH-[${terminalLabel(settings)}]`
}

module.exports = { terminalLabel, terminalPrefix }
