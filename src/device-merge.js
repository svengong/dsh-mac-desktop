'use strict'

/**
 * Device-document merge helpers (pure, smoke-testable).
 *
 * The shell keys devices by `machine:<id>` after an ssh connect resolves
 * the remote machine identity (~/.dsh/.desktop-machine-id). When that id
 * is rebuilt (file deleted, remote home reset), the new `machine:<newid>`
 * device would start EMPTY while every configured component stays under the
 * old key. `mergeSameHostUpdates` gathers the update sections of every ssh
 * device pointing at the same host (old machine ids, other aliases) so the
 * new machine device inherits the full component list instead of losing it.
 */

/**
 * Merge two `update` sections. Components are deduplicated by identity
 * (`packageName`/`installSpec` for npm, `presetId` for git presets); the
 * check timestamps keep the newer value. Idempotent: merging the same
 * sources repeatedly yields the same component list.
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
    const key = def.kind === 'git-preset'
      ? `preset:${def.presetId ?? def.id}`
      : `npm:${def.packageName ?? def.installSpec ?? def.id}`
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

/**
 * Gather the update sections of every ssh device pointing at `host`, except
 * the excluded keys. Returns them in document order (callers fold with
 * mergeUpdates, so order only affects tie-breaking, not content).
 */
function sameHostUpdates(devices, host, excludeKeys) {
  const excluded = new Set(excludeKeys ?? [])
  const updates = []
  if (host === '' || host === undefined || host === null) return updates
  for (const [key, device] of Object.entries(devices)) {
    if (excluded.has(key)) continue
    if (device === null || typeof device !== 'object') continue
    if (device.mode !== 'ssh') continue
    if (device.ssh === null || device.ssh === undefined || device.ssh.host !== host) continue
    if (device.update !== undefined && device.update !== null) updates.push(device.update)
  }
  return updates
}

module.exports = { mergeUpdates, sameHostUpdates }
