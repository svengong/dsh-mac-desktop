'use strict'

/**
 * The shell's own directory chooser, shared by every surface that asks the
 * user to pick a workspace/repository folder.
 *
 * Why the shell must own this (measured, macOS 26.6 / Electron 35):
 *
 * The harness Web UI ships a native directory-picker client row
 * (`@deepseek-ai/dsh-client-ui-directory-picker-native`). When the page has no
 * desktop bridge — `globalThis.__DSH_DIRECTORY_PICKER__` is undefined — that
 * row falls back to the HOST chooser: the `dsh web` process spawns
 * `osascript -l JavaScript`, which builds a throwaway Accessory
 * `NSApplication`, calls `activateIgnoringOtherApps`, and runs a modal
 * `NSOpenPanel`. The panel is therefore owned by a helper process that is NOT
 * the frontmost app, and macOS leaves that window non-key: the panel paints,
 * but the click that should select a folder is consumed by activation, so the
 * user has to click the DSH window first and only then can operate the panel.
 *
 * The harness README states the intended contract for this exact situation:
 * "In the local Electron application, this flow uses the narrow preload
 * directory-picker bridge." So the shell exposes
 * `__DSH_DIRECTORY_PICKER__.pick()` (see `harness-preload.js`) and answers it
 * with `dialog.showOpenDialog(ownerWindow, …)` below — an NSOpenPanel owned by
 * the already-frontmost DSH application, attached to the window the user
 * clicked in. It is key on arrival, so the first click selects.
 *
 * Everything here is injectable (`dialog` is a parameter) so the normalization
 * and the parent-window policy stay testable without Electron.
 */

/**
 * What every directory pick in the shell asks for: one directory, and the
 * ability to create one in place (choosing a not-yet-existing workspace
 * folder is a first-class flow, not an error path).
 */
const DIRECTORY_PROPERTIES = Object.freeze(['openDirectory', 'createDirectory'])

/**
 * Normalize an Electron `showOpenDialog` result to the one value the bridge
 * contract promises: an absolute path, or `null` when the user cancelled.
 *
 * Cancellation is `canceled: true` from Electron, but a cancelled macOS panel
 * can still report a highlighted directory in `filePaths`; reading the array
 * unconditionally would turn "cancel" into "picked whatever was highlighted".
 * Only a non-cancelled result yields a path.
 * @param {{canceled?: boolean, filePaths?: string[]}|null|undefined} result
 * @returns {string|null}
 */
function pickedPath(result) {
  if (result === null || result === undefined) return null
  if (result.canceled === true) return null
  const paths = Array.isArray(result.filePaths) ? result.filePaths : []
  const first = paths[0]
  return typeof first === 'string' && first !== '' ? first : null
}

/**
 * Show one directory chooser on behalf of `ownerWindow` and resolve the picked
 * path (or `null` on cancel).
 *
 * The owner window is passed whenever it is alive so the panel is a WINDOW
 * sheet: it belongs to the DSH app, inherits its frontmost status, and takes
 * keyboard focus immediately. Without a parent the panel is app-modal and its
 * relation to the window the user clicked is lost — which is the very failure
 * this module exists to avoid. A dead/absent window still gets a chooser
 * (app-modal), because a missing folder dialog is worse than an unsheeted one.
 * @param {import('electron').BrowserWindow|null} ownerWindow
 * @param {object} dialog - Electron's `dialog` module (injected for tests).
 * @param {object} [options]
 * @param {string} [options.title]
 * @param {string} [options.defaultPath]
 * @returns {Promise<string|null>}
 */
async function pickDirectory(ownerWindow, dialog, options = {}) {
  const config = { properties: [...DIRECTORY_PROPERTIES] }
  if (typeof options.title === 'string' && options.title !== '') config.title = options.title
  if (typeof options.defaultPath === 'string' && options.defaultPath !== '') {
    config.defaultPath = options.defaultPath
  }
  const usable = ownerWindow !== null
    && ownerWindow !== undefined
    && (typeof ownerWindow.isDestroyed !== 'function' || !ownerWindow.isDestroyed())
  const result = usable
    ? await dialog.showOpenDialog(ownerWindow, config)
    : await dialog.showOpenDialog(config)
  return pickedPath(result)
}

module.exports = { DIRECTORY_PROPERTIES, pickedPath, pickDirectory }
