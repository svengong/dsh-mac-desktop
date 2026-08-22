'use strict'

/**
 * Device-document merge helpers (pure, smoke-testable).
 *
 * The shell keys devices by `machine:<id>` after an ssh connect resolves
 * the remote machine identity (~/.dsh/.desktop-machine-id). When that id
 * is rebuilt (file deleted, remote home reset), the new `machine:<newid>`
 * device would start EMPTY while the Harness update state stays under the
 * old key. `mergeUpdates` gathers the update sections of every ssh
 * device pointing at the same host (old machine ids, other aliases) so the
 * new machine device inherits the Harness row instead of losing it.
 */

/**
 * Merge two `update` sections. Only the built-in Harness component is kept;
 * other entries are intentionally dropped. Check timestamps keep the
 * newer value. Idempotent: merging the same sources repeatedly yields the
 * same component list.
 */
function mergeUpdates(primary, secondary) {
  const left = primary ?? {}
  const right = secondary ?? {}
  const seen = new Set()
  const components = []
  const leftComponents = Array.isArray(left.components) ? left.components : []
  const rightComponents = Array.isArray(right.components) ? right.components : []
  for (const def of [...leftComponents, ...rightComponents]) {
    if (def === null || typeof def !== 'object') continue
    if (def.kind !== 'harness' && def.id !== 'harness') continue
    const key = `harness:${def.id ?? 'harness'}`
    if (seen.has(key)) continue
    seen.add(key)
    components.push(def)
  }
  const leftTime = left.lastCheckAt ?? ''
  const rightTime = right.lastCheckAt ?? ''
  const newerIsLeft = String(leftTime).localeCompare(String(rightTime)) >= 0
  return {
    autoCheckOnLaunch: left.autoCheckOnLaunch !== undefined ? left.autoCheckOnLaunch : right.autoCheckOnLaunch,
    lastCheckAt: newerIsLeft ? leftTime : rightTime,
    lastNotifiedKey: newerIsLeft ? (left.lastNotifiedKey ?? '') : (right.lastNotifiedKey ?? ''),
    components,
  }
}

module.exports = { mergeUpdates }
