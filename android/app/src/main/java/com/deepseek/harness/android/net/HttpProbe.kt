package com.deepseek.harness.android.net

import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

/**
 * HTTP probes against a harness service.
 *
 * Two details matter since `dsh web` started gating its index behind a launch
 * token cookie:
 *
 * - A redirect must be FOLLOWED while carrying any `set-cookie` the previous hop
 *   minted. The token URL answers 303 to a clean `/` and only serves index.html
 *   to a request that presents the cookie, so a probe that stops at the redirect
 *   sees an empty body and would call a healthy harness "not dsh".
 * - A 401 whose body is the harness's own auth notice still counts as dsh: the
 *   service is up and answering, it simply has not been handed a token yet.
 *   Treating that as "not dsh" would make the reuse path reject its own service
 *   and respawn on every connect.
 */
object HttpProbe {

    data class Result(val up: Boolean, val isDsh: Boolean, val needsAuth: Boolean = false)

    fun probe(url: String, timeoutMs: Int = 4000): Result = probe(url, timeoutMs, hops = 3, cookie = null)

    private fun probe(url: String, timeoutMs: Int, hops: Int, cookie: String?): Result {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(url).openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                requestMethod = "GET"
                cookie?.let { setRequestProperty("Cookie", it) }
            }
            val status = connection.responseCode
            val location = connection.getHeaderField("Location")
            if (hops > 0 && status in 300..399 && !location.isNullOrBlank()) {
                val next = runCatching { URI(url).resolve(location).toString() }.getOrNull()
                val carried = mintedCookie(connection) ?: cookie
                if (!next.isNullOrBlank()) return probe(next, timeoutMs, hops - 1, carried)
            }
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val body = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            Result(
                up = true,
                isDsh = body.contains("__DSH_BOOT__") ||
                    (status == 401 && body.contains("dsh web authentication required")),
                needsAuth = status == 401 && body.contains("dsh web authentication required"),
            )
        } catch (_: Exception) {
            Result(up = false, isDsh = false)
        } finally {
            connection?.disconnect()
        }
    }

    private fun mintedCookie(connection: HttpURLConnection): String? {
        val headers = connection.headerFields["Set-Cookie"] ?: return null
        val pairs = headers.mapNotNull { it?.split(";")?.firstOrNull()?.trim() }
            .filter { it.contains("=") }
        return if (pairs.isEmpty()) null else pairs.joinToString("; ")
    }

    /**
     * Whether a LIVE service still accepts a recorded launch token.
     *
     * The token is checkable in a single hop: the service answers 303 to a token
     * it minted and 401 to anything else. Only a decision the service actually
     * made counts; any other status (or no answer at all) returns null, and
     * callers treat null as "leave it alone" — guessing "stale" would restart a
     * healthy service for nothing.
     */
    fun tokenAccepted(url: String, timeoutMs: Int = 4000): Boolean? {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(url).openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                requestMethod = "GET"
            }
            when (val status = connection.responseCode) {
                in 300..399 -> true
                401, 403 -> false
                else -> null
            }
        } catch (_: Exception) {
            null
        } finally {
            connection?.disconnect()
        }
    }

    /**
     * Move a `dsh web` URL onto another loopback port, keeping everything that
     * makes it authenticated (its `token` query).
     *
     * An ssh device reaches the remote service through a local forward, so the
     * URL the remote CLI printed names an authority the WebView never talks to.
     * The token itself is port-agnostic — the service mints a cookie bound to the
     * authority of the request that presents it — so re-hosting it on the forward
     * port yields a URL that authenticates against the local end of the tunnel.
     */
    fun rehostUrl(url: String, port: Int): String {
        if (url.isBlank() || port !in 1..65535) return ""
        return runCatching {
            val parsed = URI(url)
            URI("http", null, "127.0.0.1", port, parsed.path?.ifBlank { "/" } ?: "/", parsed.query, null).toString()
        }.getOrDefault("")
    }
}
