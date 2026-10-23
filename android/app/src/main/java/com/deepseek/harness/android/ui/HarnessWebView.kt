package com.deepseek.harness.android.ui

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView

/**
 * The harness page.
 *
 * Navigating HOME is deliberately routed through the system browser. The shell
 * revives one page only — the service root — and the harness's real routes are
 * hash routes under it, so anything that leaves that root is somebody else's
 * destination (docs, an external link in a message). Loading it in-place would
 * replace the app with a page the user cannot get back from without a reload.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun HarnessWebView(
    url: String,
    onLoadingChanged: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var webView by remember { mutableStateOf<WebView?>(null) }
    var canGoBack by remember { mutableStateOf(false) }

    // The harness keeps local state (scroll, open panel) across reconnects as
    // long as the WebView survives; we therefore recreate it only when the URL
    // authority changes, which is the only case where the old document is
    // meaningless anyway.
    val identity = remember(url) { url.substringBefore("?").substringBefore("#") }

    // Android's back button means "go back inside the page" while there is
    // history, and "leave" otherwise. Without this, back closes the whole app
    // from a deep conversation, which loses the scroll position.
    BackHandler(enabled = canGoBack) {
        webView?.let { view ->
            if (view.canGoBack()) view.goBack() else canGoBack = false
        }
    }

    Box(modifier = modifier.fillMaxSize()) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                WebView(ctx).apply {
                    layoutParams = ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT,
                    )
                    settings.apply {
                        javaScriptEnabled = true
                        domStorageEnabled = true
                        databaseEnabled = true
                        loadWithOverviewMode = false
                        useWideViewPort = true
                        builtInZoomControls = false
                        displayZoomControls = false
                        mediaPlaybackRequiresUserGesture = false
                        allowFileAccess = false
                        allowContentAccess = true
                        mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                        cacheMode = WebSettings.LOAD_DEFAULT
                        // The harness ships its own viewport meta; letting the
                        // WebView re-scale would double-apply safe-area maths on
                        // tablets.
                        setSupportZoom(false)
                    }
                    CookieManager.getInstance().setAcceptCookie(true)
                    CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
                    // Inject the compatibility shim BEFORE the document loads:
                    // the harness calls Promise.withResolvers / AbortSignal.any at
                    // module scope, so a shim applied after onPageStarted is too
                    // late and the bundle has already aborted.
                    // WebViewCompat owns this, not WebView: it is a feature-gated
                    // androidx API, and it must be evaluated AFTER the WebView has
                    // a provider (i.e. inside the factory), not at composable time.
                    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                        WebViewCompat.addDocumentStartJavaScript(this, WebViewCompatScript.JAVASCRIPT, setOf("*"))
                    }
                    webChromeClient = WebChromeClient()
                    webViewClient = object : WebViewClient() {
                        override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                            onLoadingChanged(true)
                        }

                        override fun onPageFinished(view: WebView?, url: String?) {
                            onLoadingChanged(false)
                            canGoBack = view?.canGoBack() == true
                        }

                        override fun shouldOverrideUrlLoading(
                            view: WebView,
                            request: WebResourceRequest,
                        ): Boolean = handleUrl(context, request.url, view)

                        @Deprecated("Legacy callback for API < 24")
                        override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean =
                            handleUrl(context, Uri.parse(url), view)
                    }
                    webView = this
                }
            },
            update = { view ->
                if (view.url != url && identity != view.url?.substringBefore("?")?.substringBefore("#")) {
                    view.loadUrl(url)
                }
            },
        )
    }

    DisposableEffect(Unit) {
        onDispose {
            webView?.apply {
                stopLoading()
                destroy()
            }
            webView = null
        }
    }

    LaunchedEffect(url) {
        webView?.loadUrl(url)
    }
}

private fun handleUrl(context: android.content.Context, uri: Uri, view: WebView): Boolean {
    val scheme = uri.scheme?.lowercase().orEmpty()
    val host = uri.host?.lowercase().orEmpty()
    val isLoopback = host == "127.0.0.1" || host == "localhost" || host == "[::1]"
    if (scheme == "http" || scheme == "https") {
        // Loopback stays inside the shell; everything else is an external site.
        if (isLoopback) return false
        return openExternally(context, uri)
    }
    // mailto:, tel:, intent: and custom app links.
    return openExternally(context, uri)
}

private fun openExternally(context: android.content.Context, uri: Uri): Boolean = try {
    val intent = Intent(Intent.ACTION_VIEW, uri).apply {
        addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    context.startActivity(intent)
    true
} catch (_: ActivityNotFoundException) {
    true
}
