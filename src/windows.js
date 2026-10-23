'use strict'

/**
 * Bring a BrowserWindow to the foreground the way macOS expects.
 *
 * A minimized window is deminiaturized with `restore()` and focus is deferred
 * to the `restore` event, so the system plays its Dock unminimize animation
 * instead of the window appearing with an instantaneous `show()`. A hidden
 * window (the close→hide path) has no native transition, so it is shown and
 * focused directly.
 */
function presentWindow(win) {
  if (win === null || win.isDestroyed()) return null
  if (win.isMinimized()) {
    win.once('restore', () => {
      if (!win.isDestroyed()) win.focus()
    })
    win.restore()
    return win
  }
  win.show()
  win.focus()
  return win
}

/**
 * Give a window's WebContentsView (harness or settings) the keyboard, but ONLY
 * when that window is already the key window.
 *
 * Why the guard is not optional — measured on Electron 35 / macOS:
 *
 *  - `win.webContents.focus()` on a window that is not key does nothing.
 *  - `view.webContents.focus()` on a WebContentsView of a window that is not
 *    key **activates that window**: the app comes forward and this window
 *    becomes key, taking front-most status away from whatever window — or
 *    application — the user is actually using.
 *
 * The shell re-syncs views from SESSION-wide broadcasts (`onSessionStatus`,
 * `setProgress`, `observeUpdateWorker`, `reloadSessionWindows`), which iterate
 * every window bound to one terminal. With two windows open, a background
 * service event therefore focused the OTHER window's harness view and yanked
 * the user across screens mid-typing; because those events keep arriving (the
 * health watchdog alone fires every 4s), the result looked like two windows
 * flashing back and forth at random.
 *
 * `isFocused()` is already true while the window's own `focus` event runs, so
 * the legitimate re-focus after a window switch still goes through.
 *
 * @returns {boolean} whether focus was handed to the view.
 */
function focusViewInKeyWindow(win, webContents) {
  if (win === null || win === undefined || win.isDestroyed()) return false
  if (webContents === null || webContents === undefined) return false
  if (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) return false
  if (!win.isFocused()) return false
  webContents.focus()
  return true
}

module.exports = { presentWindow, focusViewInKeyWindow }
