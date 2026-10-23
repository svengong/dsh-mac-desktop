package com.deepseek.harness.android.data

import java.util.UUID

/** How a terminal is reached. Only two modes exist, mirroring the desktop shell. */
enum class ConnectionMode { SSH, URL }

/**
 * One terminal = one place the harness runs.
 *
 * - [ConnectionMode.SSH]: this app opens an SSH connection, makes sure a
 *   `dsh web` service is running there, and forwards a local loopback port to
 *   it. The WebView then talks to 127.0.0.1 on the phone.
 * - [ConnectionMode.URL]: the user pastes a URL they can already reach
 *   (reverse proxy, LAN address, an already-tunnelled port). No SSH, no managed
 *   service — adopt-or-nothing.
 */
data class Device(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
    val mode: ConnectionMode,
    // SSH
    val host: String = "",
    val port: Int = 22,
    val user: String = "",
    val authKeyId: String? = null,
    val remoteDshHome: String = "",     // blank -> "$HOME/.dsh"
    val manageService: Boolean = true,  // false = only tunnel, never start/stop
    // URL
    val url: String = "",
    // UI
    val lastUsedAt: Long = 0L,
) {
    val isSsh: Boolean get() = mode == ConnectionMode.SSH
    fun displayTarget(): String = when (mode) {
        ConnectionMode.SSH -> if (user.isBlank()) "$host:$port" else "$user@$host:$port"
        ConnectionMode.URL -> url
    }
}

/** An SSH private key held in the app's private storage. */
data class AuthKey(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
    val hasPassphrase: Boolean = false,
    val importedAt: Long = 0L,
)
