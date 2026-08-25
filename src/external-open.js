'use strict'

/**
 * URL classification for harness page navigation.
 *
 * The harness web app is rendered inside the shell's WebContentsView. Links
 * like search results and web-search citations are `target="_blank"` links,
 * and Electron would by default open them as child windows INSIDE the shell
 * app. The product contract is the opposite: the shell never renders
 * third-party content, so any external page must be delegated to the system
 * default browser instead of being shown in a new window here.
 *
 * `isExternalUrl` decides where a URL belongs:
 *
 * - the harness service lives on http://127.0.0.1:<port> (local) or on
 *   http://localhost:<forward-port> (ssh tunnel), and is the ONLY thing the
 *   shell may keep in its own web view;
 * - every other URL — public web pages, `file:`, `about:` — is external and
 *   belongs in the user's default browser.
 *
 * The function is pure (no Electron imports) so the smoke test can cover it
 * without booting an app.
 */

const EXTERNAL_PROTOCOLS = ['https:', 'http:', 'file:', 'mailto:']
// Loopback hostnames the harness service may be served under. The local
// backend binds 127.0.0.1; the ssh tunnel accepts on the same interface.
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '::1']

/** Parse a URL, returning null when it is empty or unparsable. */
function parseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/**
 * True when `url` must not be loaded inside the shell's harness view and
 * should instead be handed to the system default browser.
 * @param {string} url - the navigation target.
 * @returns {boolean}
 */
function isExternalUrl(url) {
  const parsed = parseUrl(url)
  if (parsed === null) return false
  if (parsed.protocol === 'about:') return false
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.includes(parsed.hostname)) return false
  // The harness frontend may be served over a tunneled loopback port on
  // `localhost`, never on a routable host. Anything else — including https,
  // file: and mailto: — is third-party content that must leave the shell.
  return EXTERNAL_PROTOCOLS.includes(parsed.protocol) || parsed.hostname !== ''
}

module.exports = { isExternalUrl }
