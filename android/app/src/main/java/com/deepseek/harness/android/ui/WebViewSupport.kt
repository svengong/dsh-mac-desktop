package com.deepseek.harness.android.ui

import android.content.Context
import androidx.webkit.WebViewCompat

/**
 * Can this device actually run the harness UI?
 *
 * The harness client bundle calls `Promise.withResolvers` (Chrome 119) and
 * `AbortSignal.any` (Chrome 116) at module scope. On an older WebView that is not
 * a degraded experience — the app renders a permanently blank page with nothing
 * but a console error to show for it, which reads to a user as "the app is
 * broken".
 *
 * Checking the installed WebView up front turns that into a sentence they can act
 * on: update WebView or Chrome. The check runs before any URL is loaded and never
 * blocks the connection itself.
 */
object WebViewSupport {

    /**
     * Lowest WebView major this client supports.
     *
     * The missing-API problem is handled by [WebViewCompatScript], which backfills
     * `Promise.withResolvers`, `AbortSignal.any` and friends before the document
     * loads, so Chromium 97+ is fine. Below that the modern client bundle falls
     * over on features a shim cannot sensibly reproduce (module scripts plus a
     * handful of CSS features the layout depends on).
     */
    const val MIN_MAJOR = 99

    data class Verdict(val supported: Boolean, val majorVersion: Int, val message: String?)

    fun check(context: Context): Verdict {
        val pkg = runCatching { WebViewCompat.getCurrentWebViewPackage(context) }.getOrNull()
            ?: return Verdict(false, 0, "此设备没有可用的系统 WebView，无法显示 Harness 页面。")
        val major = pkg.versionName?.substringBefore('.')?.toIntOrNull() ?: 0
        if (major >= MIN_MAJOR) return Verdict(true, major, null)
        val versionText = if (major > 0) major.toString() else (pkg.versionName ?: "未知")
        return Verdict(
            supported = false,
            majorVersion = major,
            message = "系统 WebView 版本过低（$versionText），DeepSeek Harness 需要 $MIN_MAJOR 及以上。" +
                "请在应用商店更新「Android System WebView」或「Chrome」后重试。",

        )
    }
}
