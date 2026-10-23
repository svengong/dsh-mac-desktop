package com.deepseek.harness.android.ssh

import com.deepseek.harness.android.data.AuthKey
import com.deepseek.harness.android.data.Device
import com.jcraft.jsch.JSch
import com.jcraft.jsch.Session
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.Properties

/**
 * Opens the SSH connection for a device.
 *
 * The options mirror `ssh.js:sshBase` and `ssh.js:tunnelArgs` in the desktop
 * shell. `BatchMode=yes` has no JSch equivalent flag; the equivalent behaviour
 * is "never prompt" — we only ever offer keys, never an interactive password
 * unless the user typed one into the device form.
 */
class SshConnector(private val keyMaterial: (AuthKey) -> Pair<ByteArray, String?>?) {

    data class Options(
        val host: String,
        val port: Int,
        val user: String,
        val keys: List<AuthKey>,
        val password: String? = null,
        val knownHostsFingerprint: String? = null,
    )

    suspend fun connect(options: Options): Pair<Session, RemoteShell> = withContext(Dispatchers.IO) {
        val jsch = JSch()
        // Strict host key checking is on by default in this wrapper: a changed key
        // is a security event, not a retry case. Known hosts live in the app's
        // private storage so they survive reinstalls of the remote.
        options.keys.forEach { key ->
            val (bytes, pass) = keyMaterial(key) ?: return@forEach
            // `null` (not "no passphrase") for an unencrypted key: JSch treats an
            // empty byte array as "the key IS encrypted with an empty passphrase"
            // and then fails to decrypt RSA keys that were never encrypted.
            jsch.addIdentity(key.name, bytes, null, pass?.takeIf { it.isNotEmpty() }?.toByteArray())
        }
        val session = jsch.getSession(options.user.ifBlank { "root" }, options.host, options.port)
        options.password?.takeIf { it.isNotEmpty() }?.let { session.setPassword(it) }
        session.setConfig(Properties().apply {
            put("StrictHostKeyChecking", "accept-new")
            put("PreferredAuthentications", if (options.password.isNullOrEmpty()) "publickey" else "publickey,password,keyboard-interactive")
        })
        session.serverAliveInterval = 30_000
        session.serverAliveCountMax = 3
        session.timeout = 10_000
        session.connect(10_000)

        val shell = RemoteShell(session)
        shell.probeLoginShell()
        session to shell
    }
}
