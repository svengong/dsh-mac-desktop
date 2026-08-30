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
 * Two rules, because the two frame kinds have different owners:
 *
 * `isExternalUrl` — the harness view's MAIN frame. The harness service lives
 * on http://127.0.0.1:<port> (local) or http://localhost:<forward-port> (ssh
 * tunnel), and its ROOT path is the ONLY thing the shell keeps; every other
 * URL — public web pages, other loopback paths, `file:` — goes to the default
 * browser. The harness is a single-page app served from `/` and routed by HASH
 * (`#/session/…`), so a real in-app route never changes `pathname`. Any other
 * path is therefore NOT the harness: workspace files the user clicks (e.g. an
 * .html artifact) land on paths the service does not serve and answer 404 with
 * an empty body, which used to leave the shell showing a blank harness view
 * with no way back.
 *
 * `isExternalSubFrameUrl` — SUB-FRAMES. A sub-frame belongs to whoever
 * embedded it. Plugin-provided panels (the sidebar's file preview among them)
 * route their own content in their own frame; the shell hijacking those
 * navigations breaks the plugin's UI, so the shell stays out of the way and
 * only expels genuinely off-origin content it must never render.
 *
 * Both functions are pure (no Electron imports) so the smoke test can cover
 * them without booting an app.
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
 *
 * Applies to the harness view's MAIN frame only. The harness app is served
 * from the service ROOT and routes by hash (`#/session/…`), so a real in-app
 * route never changes `pathname`; every other main-frame destination is not
 * the harness and belongs in the default browser.
 * @param {string} url - the navigation target.
 * @returns {boolean}
 */
function isExternalUrl(url) {
  const parsed = parseUrl(url)
  if (parsed === null) return false
  if (parsed.protocol === 'about:') return false
  // Root (with or without a query string) is the harness itself.
  if (parsed.protocol === 'http:'
    && LOOPBACK_HOSTS.includes(parsed.hostname)
    && (parsed.pathname === '/' || parsed.pathname === '')) return false
  // The harness frontend may be served over a tunneled loopback port on
  // `localhost`, never on a routable host. Anything else — including https,
  // file:, mailto: and non-root loopback paths — is third-party content that
  // must leave the shell.
  return EXTERNAL_PROTOCOLS.includes(parsed.protocol) || parsed.hostname !== ''
}

/**
 * True when a SUB-FRAME navigation must leave the shell.
 *
 * Sub-frames belong to whoever embedded them: plugin-provided panels (the
 * sidebar's file preview among them) render their own content in their own
 * frame, and their routing is theirs to decide. Intercepting those navigations
 * hijacks the plugin's UI — a preview click would jump to the system browser
 * instead of rendering in place.
 *
 * So the shell only expels a sub-frame when the destination is genuinely
 * off-origin content it must never render (a real external web page), and
 * otherwise stays out of the way.
 * @param {string} url - the navigation target.
 * @returns {boolean}
 */
function isExternalSubFrameUrl(url) {
  const parsed = parseUrl(url)
  if (parsed === null) return false
  // Off-origin content (public web, file:) never renders inside the shell.
  if (parsed.protocol === 'file:') return true
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return !LOOPBACK_HOSTS.includes(parsed.hostname)
  }
  return EXTERNAL_PROTOCOLS.includes(parsed.protocol)
}

module.exports = { isExternalUrl, isExternalSubFrameUrl }
