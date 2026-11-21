package com.deepseek.harness.android.data

import com.jcraft.jsch.JSch
import com.jcraft.jsch.KeyPair
import java.io.ByteArrayOutputStream
import java.io.InputStream

internal class PrivateKeyImportException(message: String) : IllegalArgumentException(message)

private const val MAX_PRIVATE_KEY_BYTES = 64 * 1024

/** Document providers may omit the file size, so enforce the limit while reading. */
internal fun readPrivateKeyText(input: InputStream): String {
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(4096)
    while (true) {
        val count = input.read(buffer)
        if (count == -1) break
        if (output.size() + count > MAX_PRIVATE_KEY_BYTES) {
            throw PrivateKeyImportException("私钥文件不能超过 64 KiB。")
        }
        output.write(buffer, 0, count)
    }
    return output.toString(Charsets.UTF_8.name()).removePrefix("\uFEFF").trim()
}

/** Check that the same SSH library used for connections can open the key. */
internal fun validatePrivateKey(pem: String, passphrase: String?) {
    val material = (pem.trim() + "\n").toByteArray()
    try {
        val key = try {
            KeyPair.load(JSch(), material, null)
        } catch (_: Exception) {
            throw PrivateKeyImportException("无法识别 SSH 私钥，请选择 OpenSSH 或 PEM 私钥文件。")
        }
        try {
            if (key.isEncrypted) {
                if (passphrase.isNullOrEmpty()) throw PrivateKeyImportException("该私钥已加密，请输入口令。")
                val secret = passphrase.toByteArray()
                try {
                    if (!key.decrypt(secret)) throw PrivateKeyImportException("私钥口令错误。")
                } finally {
                    secret.fill(0)
                }
            }
        } finally {
            key.dispose()
        }
    } finally {
        material.fill(0)
    }
}
