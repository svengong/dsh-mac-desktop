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
 * The scope must be the harness's OWN port, not merely "some loopback". A
 * model answer linking `http://127.0.0.1:8811/` (a preview server, a docs site,
 * any second local service) is an ordinary external page; classifying it as
 * "harness, different path" silently swallowed the click — nothing opened and
 * nothing was logged as attempted. So the caller passes the origin it is
 * actually rendering, `isExternalUrl` treats that origin's root as internal,
 * and every OTHER origin — loopback or not — leaves for the default browser.
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
 *
 * "Is this the harness?" is an ORIGIN question — host AND port. Two loopback
 * services on different ports are two different servers: a model answer that
 * links `http://127.0.0.1:8811/` points at whatever runs on 8811, never at the
 * harness on `<port>`. Answering it with the port-blind rule ("loopback but
 * not the root path") dropped the click on the floor.
 * @param {string} url - the navigation target.
 * @param {string} [harnessUrl] - the URL the harness view is currently
 *   rendering; its origin is the only loopback origin kept in-app. Omitting it
 *   never widens the rule in-app: only the ROOT of a loopback host is then
 *   considered internal, which is what every caller used to get.
 * @returns {boolean}
 */
function isExternalUrl(url, harnessUrl) {
  const parsed = parseUrl(url)
  if (parsed === null) return false
  if (parsed.protocol === 'about:') return false
  const isLoopback = parsed.protocol === 'http:' && LOOPBACK_HOSTS.includes(parsed.hostname)
  if (isLoopback) {
    const harness = parseUrl(harnessUrl)
    // The harness origin is known: it is the ONLY loopback origin kept in-app,
    // and even there only the root is the app (its routes live in the hash).
    if (harness !== null) {
      if (parsed.port !== harness.port) return true
      return !(parsed.pathname === '/' || parsed.pathname === '')
    }
    // No harness origin supplied (a detached window, or a call before the
    // first load). A non-root loopback URL is then ambiguous: it could be the
    // harness's own 404 path or a second local service. Swallowing it is the
    // only unrecoverable answer — nothing opens and nothing is logged as
    // attempted — so the benefit of the doubt goes to the browser, which can
    // still show whatever is actually there.
    return !(parsed.pathname === '/' || parsed.pathname === '')
  }
  // The harness frontend may be served over a tunneled loopback port on
  // `localhost`, never on a routable host. Anything else — including https,
  // file: and mailto: — is third-party content that must leave the shell.
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
 * otherwise stays out of the way. "Off-origin" is measured against the harness
 * origin for loopback, exactly like the main frame: `127.0.0.1:8811` is a
 * different server from the harness on its own port, so a frame pointed at it
 * is third-party content.
 * @param {string} url - the navigation target.
 * @param {string} [harnessUrl] - the URL the harness view is rendering.
 * @returns {boolean}
 */
function isExternalSubFrameUrl(url, harnessUrl) {
  const parsed = parseUrl(url)
  if (parsed === null) return false
  // Off-origin content (public web, file:) never renders inside the shell.
  if (parsed.protocol === 'file:') return true
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    if (!LOOPBACK_HOSTS.includes(parsed.hostname)) return true
    // Loopback: only the harness's own port is ours; another port is a
    // different local service and is not the plugin's own content.
    const harness = parseUrl(harnessUrl)
    return harness !== null && parsed.port !== harness.port
  }
  return EXTERNAL_PROTOCOLS.includes(parsed.protocol)
}

/**
 * Schemes the shell may hand to the OS via `shell.openExternal`.
 *
 * `isExternalUrl` answers "must this leave the harness view?" — and the
 * answer is yes for `file:` and for any unknown scheme with a host. That is
 * the right NAVIGATION decision (block it in-app), but the wrong LAUNCH
 * decision: `openExternal('file:///…/x.app')` or an `.exe` executes it, and
 * `smb://host/share` makes Windows authenticate to that host (NTLM hash leak).
 * Harness pages render model output and web citations, so a link there must
 * never be able to launch anything but a browser or mail client.
 */
const BROWSER_PROTOCOLS = ['https:', 'http:', 'mailto:']

/** True when `url` is safe to pass to `shell.openExternal`. */
function isBrowserSafeUrl(url) {
  const parsed = parseUrl(url)
  return parsed !== null && BROWSER_PROTOCOLS.includes(parsed.protocol)
}

module.exports = { isExternalUrl, isExternalSubFrameUrl, isBrowserSafeUrl }
