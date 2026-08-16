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

module.exports = { presentWindow }
