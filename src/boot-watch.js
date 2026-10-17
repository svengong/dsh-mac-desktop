'use strict'

/**
 * Boot-failure detection for the harness view.
 *
 * `did-finish-load` proves the HTML arrived, not that the harness started.
 * The frontend then boots its client plugin graph, and that boot can fail on
 * its own: the page replaces its loading card with a "Failed to load plugins"
 * card and no further DOM lifecycle event ever reaches the shell.
 *
 * Measured case: after upgrading a device's harness, a window that had
 * committed the outgoing page showed that card indefinitely — the connection
 * was `ready` the whole time, the service behind it healthy, and the window
 * never reloaded because its URL had not changed. Nothing in the shell noticed,
 * because "loaded" and "booted" were the same flag.
 *
 * This module holds the part worth testing without Electron: the in-page
 * predicate that recognises the failure card, and the policy that decides
 * whether a failure earns a reload. The timers and webContents plumbing stay
 * in main.js.
 */

/**
 * In-page test for the frontend's boot failure card.
 *
 * The boot overlay carries `data-dsh-boot` for the whole boot — success or
 * failure — so its presence says nothing. The failure card is the overlay's
 * replacement CONTENT, and it is the only state that also names the failure.
 * Matching on rendered text (rather than the card's hashed CSS class, which
 * changes every build) keeps the probe stable across harness releases.
 *
 * Runs in the page, so it must be a self-contained expression string.
 */
const BOOT_FAILURE_PROBE = `(() => {
  const boot = document.querySelector('[data-dsh-boot]');
  if (boot === null) return false;
  const text = boot.textContent || '';
  return text.includes('Failed to load plugins') || text.includes('did not activate');
})()`

/**
 * Decide whether a boot failure reported by the page warrants a reload.
 *
 * Two ways a failure must NOT trigger one:
 *
 *  - the probe was superseded (a newer navigation owns the view now), so this
 *    answer describes a page that is no longer on screen;
 *  - the page had already spent its attempts for this URL. A boot that fails
 *    twice is a broken profile, not a lost race, and reloading it forever only
 *    repaints the same card.
 * @param {object} state - the decision inputs.
 * @param {number} state.probeSeq - sequence captured when the probe was armed.
 * @param {number} state.currentSeq - the workspace's live sequence.
 * @param {string} state.probedUrl - URL the probe was armed for.
 * @param {string} state.loadedUrl - URL the view has committed now.
 * @param {number} state.reloads - reloads already spent for `probedUrl`.
 * @param {number} state.limit - reload cap.
 * @returns {boolean} true when the caller should reload the service URL.
 */
function shouldReloadAfterBootFailure(state) {
  if (state.probeSeq !== state.currentSeq) return false
  if (state.probedUrl === '' || state.probedUrl !== state.loadedUrl) return false
  if (!Number.isInteger(state.limit) || state.limit <= 0) return false
  return state.reloads < state.limit
}

module.exports = { BOOT_FAILURE_PROBE, shouldReloadAfterBootFailure }
