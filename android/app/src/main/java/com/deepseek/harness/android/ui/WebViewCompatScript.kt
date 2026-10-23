package com.deepseek.harness.android.ui

/**
 * A document-start shim for the handful of JavaScript APIs the harness bundle
 * uses but older WebViews do not ship.
 *
 * The alternative is refusing to run: the harness calls these at MODULE SCOPE,
 * so a missing function aborts the bundle before anything renders — the user
 * gets a blank page and the only diagnostic is a console error they cannot see.
 * Telling them to update WebView is not a fix on Android 8–13 devices whose
 * vendor never shipped a newer one, and those are exactly the phones this client
 * is for.
 *
 * The shim only defines functions that are ABSENT, so on a modern WebView it is
 * a no-op and the native implementation always wins. It runs before any page
 * script, which is what makes it usable for module-scope calls.
 *
 * Keep this list minimal and justified: every entry is a compatibility promise
 * that has to be re-verified against the harness bundle.
 */
object WebViewCompatScript {

    /** The payload injected at document start. Pure string: no Android APIs. */
    val JAVASCRIPT: String = """
(function () {
  'use strict';
  if (typeof Promise.withResolvers !== 'function') {
    /**
     * Chrome 119. The exact contract: return the promise together with the
     * functions that settle it, so callers need no outer variable dance.
     */
    Object.defineProperty(Promise, 'withResolvers', {
      configurable: true,
      writable: true,
      value: function withResolvers() {
        var resolve, reject;
        var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
        return { promise: promise, resolve: resolve, reject: reject };
      }
    });
  }
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any !== 'function') {
    /**
     * Chrome 116. Combine signals into one that aborts when ANY input aborts,
     * carrying that input's reason. Already-aborted inputs win immediately, and
     * the result must not keep the inputs alive as listeners forever.
     */
    Object.defineProperty(AbortSignal, 'any', {
      configurable: true,
      writable: true,
      value: function any(signals) {
        var controller = new AbortController();
        var list = Array.prototype.slice.call(signals);
        for (var i = 0; i < list.length; i += 1) {
          var signal = list[i];
          if (signal.aborted) {
            controller.abort(signal.reason);
            return controller.signal;
          }
        }
        list.forEach(function (signal) {
          signal.addEventListener('abort', function () {
            controller.abort(signal.reason);
          }, { once: true, signal: controller.signal });
        });
        return controller.signal;
      }
    });
  }
  if (typeof Array.prototype.findLast !== 'function') {
    /** Chrome 97. Cheap to provide and used by list rendering paths. */
    Object.defineProperty(Array.prototype, 'findLast', {
      configurable: true,
      writable: true,
      value: function findLast(predicate, thisArg) {
        for (var i = this.length - 1; i >= 0; i -= 1) {
          if (predicate.call(thisArg, this[i], i, this)) return this[i];
        }
        return undefined;
      }
    });
  }
  if (typeof Array.prototype.toSorted !== 'function') {
    /** Chrome 110. A copy, never an in-place sort. */
    Object.defineProperty(Array.prototype, 'toSorted', {
      configurable: true,
      writable: true,
      value: function toSorted(compare) {
        return Array.prototype.slice.call(this).sort(compare);
      }
    });
  }
  if (typeof structuredClone !== 'function') {
    /** Chrome 98. JSON round-trip is enough for the plain data the UI clones. */
    globalThis.structuredClone = function structuredClone(value) {
      return JSON.parse(JSON.stringify(value));
    };
  }
})();
""".trimIndent()
}
