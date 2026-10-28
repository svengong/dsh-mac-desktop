'use strict'

/**
 * Preload for the harness view — the ONLY desktop-specific bridge the web app
 * is allowed to see.
 *
 * The harness ships a directory-picker client row
 * (`@deepseek-ai/dsh-client-ui-directory-picker-native`) that looks for
 * `globalThis.__DSH_DIRECTORY_PICKER__` before every pick:
 *
 *   const desktop = globalThis.__DSH_DIRECTORY_PICKER__;
 *   const pick = desktop === void 0
 *     ? () => ctx.uiWorkspace.pickDirectory()   // Host-side osascript panel
 *     : () => desktop.pick();                   // this bridge
 *
 * Without the bridge, the host process opens its own `NSOpenPanel` from a
 * throwaway helper app that is not the frontmost process, so the panel is not
 * key and the first click is eaten by activation — the user has to click the
 * DSH window before the folder chooser responds. With the bridge, the shell
 * opens the panel as a sheet on the window the user is actually using (see
 * `picker.js`), so the first click selects.
 *
 * The contract is deliberately tiny and matches the harness's own fallback:
 * `pick()` resolves a chosen absolute path, `null` on cancel, and rejects only
 * on a real failure. Nothing else about the desktop shell is exposed here —
 * the harness view must keep running as an ordinary sandboxed web page.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__DSH_DIRECTORY_PICKER__', {
  /**
   * Ask the shell for one directory.
   * @returns {Promise<string|null>} picked absolute path, or null on cancel.
   */
  pick: () => ipcRenderer.invoke('picker:directory'),
})
