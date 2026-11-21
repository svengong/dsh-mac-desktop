package com.deepseek.harness.android.data

import com.jcraft.jsch.JSch
import com.jcraft.jsch.KeyPair
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.ByteArrayOutputStream

class PrivateKeyImportTest {
    @Test
    fun importsPrivateKeyFromFileContents() {
        val pem = generateKey()
        val imported = readPrivateKeyText(pem.byteInputStream())
        validatePrivateKey(imported, null)
        assertEquals(pem.trim(), imported)
    }

    @Test
    fun rejectsNonPrivateKeysAndOversizedFiles() {
        assertThrows(PrivateKeyImportException::class.java) {
            validatePrivateKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA test", null)
        }
        assertThrows(PrivateKeyImportException::class.java) {
            readPrivateKeyText(ByteArray(64 * 1024 + 1).inputStream())
        }
    }

    @Test
    fun validatesPassphraseIncludingSpaces() {
        val passphrase = " test passphrase "
        val encryptedPem = generateKey(passphrase)
        assertThrows(PrivateKeyImportException::class.java) { validatePrivateKey(encryptedPem, null) }
        assertThrows(PrivateKeyImportException::class.java) { validatePrivateKey(encryptedPem, passphrase.trim()) }
        validatePrivateKey(encryptedPem, passphrase)
    }

    private fun generateKey(passphrase: String? = null): String {
        val key = KeyPair.genKeyPair(JSch(), KeyPair.RSA, 2048)
        try {
            val output = ByteArrayOutputStream()
            key.writePrivateKey(output, passphrase?.toByteArray())
            return output.toString(Charsets.UTF_8.name())
        } finally {
            key.dispose()
        }
    }
}
