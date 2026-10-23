package com.deepseek.harness.android.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Devices and SSH keys, persisted as one small JSON document in the app's
 * private files directory.
 *
 * Deliberately not Room: the whole dataset is a handful of records, and keeping
 * it a plain document makes the file human-inspectable when a connection
 * refuses to work on a phone where no terminal is available.
 */
class DeviceStore(private val context: Context) {

    private companion object {
        /** Written through a constant: a bare escape inside a string literal is rejected. */
        const val NEWLINE = "\n"
    }

    private val file: File get() = File(context.filesDir, "devices.json")
    private val keysDir: File get() = File(context.filesDir, "keys").apply { mkdirs() }

    private val _devices = MutableStateFlow<List<Device>>(emptyList())
    val devices: StateFlow<List<Device>> = _devices.asStateFlow()

    private val _authKeys = MutableStateFlow<List<AuthKey>>(emptyList())
    val authKeys: StateFlow<List<AuthKey>> = _authKeys.asStateFlow()

    suspend fun load() = withContext(Dispatchers.IO) {
        val text = runCatching { file.readText() }.getOrNull()
        if (text.isNullOrBlank()) {
            _devices.value = emptyList()
            _authKeys.value = listOfNotNull(seedKeyIfPresent())
            return@withContext
        }
        val root = runCatching { JSONObject(text) }.getOrNull() ?: JSONObject()
        val devices = root.optJSONArray("devices").toDeviceList()
        val keys = root.optJSONArray("keys").toKeyList().ifEmpty { listOfNotNull(seedKeyIfPresent()) }
        _devices.value = devices
        _authKeys.value = keys
    }

    suspend fun upsert(device: Device) = withContext(Dispatchers.IO) {
        val next = _devices.value.filterNot { it.id == device.id } + device
        _devices.value = next.sortedByDescending { it.lastUsedAt }
        persist()
    }

    suspend fun delete(deviceId: String) = withContext(Dispatchers.IO) {
        _devices.value = _devices.value.filterNot { it.id == deviceId }
        persist()
    }

    suspend fun markUsed(deviceId: String) = withContext(Dispatchers.IO) {
        _devices.value = _devices.value.map {
            if (it.id == deviceId) it.copy(lastUsedAt = System.currentTimeMillis()) else it
        }.sortedByDescending { it.lastUsedAt }
        persist()
    }

    // ── keys ────────────────────────────────────────────────────────────────

    /**
     * Store a private key. The key material never leaves app-private storage and
     * is never rendered back into the UI — only its name and passphrase state
     * are listed.
     */
    suspend fun importKey(name: String, pem: String, passphrase: String?): AuthKey = withContext(Dispatchers.IO) {
        val id = java.util.UUID.randomUUID().toString()
        val target = File(keysDir, "$id.pem")
        target.writeText(pem.trim() + NEWLINE)
        target.setReadable(false, false)
        target.setReadable(true, true)
        val key = AuthKey(id = id, name = name, hasPassphrase = !passphrase.isNullOrEmpty(), importedAt = System.currentTimeMillis())
        _authKeys.value = _authKeys.value + key
        if (!passphrase.isNullOrEmpty()) File(keysDir, "$id.pass").writeText(passphrase)
        persist()
        key
    }

    suspend fun deleteKey(keyId: String) = withContext(Dispatchers.IO) {
        File(keysDir, "$keyId.pem").delete()
        File(keysDir, "$keyId.pass").delete()
        _authKeys.value = _authKeys.value.filterNot { it.id == keyId }
        persist()
    }

    fun keyMaterial(keyId: String): ByteArray? =
        runCatching { File(keysDir, "$keyId.pem").readBytes() }.getOrNull()

    fun keyPassphrase(keyId: String): String? =
        runCatching { File(keysDir, "$keyId.pass").readText().trim() }.getOrNull()

    /**
     * Migration path for people who already use the desktop shell: the device
     * list is importable from a JSON export, but nothing is read from another
     * app's sandbox.
     */
    private fun seedKeyIfPresent(): AuthKey? = null

    private fun persist() {
        val root = JSONObject()
        root.put("version", 1)
        root.put("devices", JSONArray().apply { _devices.value.forEach { put(it.toJson()) } })
        root.put("keys", JSONArray().apply { _authKeys.value.forEach { put(it.toJson()) } })
        file.writeText(root.toString(2))
    }
}

private fun JSONArray?.toDeviceList(): List<Device> {
    if (this == null) return emptyList()
    return (0 until length()).mapNotNull { i ->
        val o = optJSONObject(i) ?: return@mapNotNull null
        runCatching {
            Device(
                id = o.getString("id"),
                name = o.optString("name", "Terminal"),
                mode = runCatching { ConnectionMode.valueOf(o.optString("mode", "SSH")) }.getOrDefault(ConnectionMode.SSH),
                host = o.optString("host", ""),
                port = o.optInt("port", 22),
                user = o.optString("user", ""),
                authKeyId = o.optString("authKeyId", "").takeIf { it.isNotBlank() },
                remoteDshHome = o.optString("remoteDshHome", ""),
                manageService = o.optBoolean("manageService", true),
                url = o.optString("url", ""),
                lastUsedAt = o.optLong("lastUsedAt", 0L),
            )
        }.getOrNull()
    }
}

private fun JSONArray?.toKeyList(): List<AuthKey> {
    if (this == null) return emptyList()
    return (0 until length()).mapNotNull { i ->
        val o = optJSONObject(i) ?: return@mapNotNull null
        runCatching {
            AuthKey(
                id = o.getString("id"),
                name = o.optString("name", "key"),
                hasPassphrase = o.optBoolean("hasPassphrase", false),
                importedAt = o.optLong("importedAt", 0L),
            )
        }.getOrNull()
    }
}

private fun Device.toJson(): JSONObject = JSONObject().apply {
    put("id", id); put("name", name); put("mode", mode.name)
    put("host", host); put("port", port); put("user", user)
    put("authKeyId", authKeyId ?: ""); put("remoteDshHome", remoteDshHome)
    put("manageService", manageService); put("url", url); put("lastUsedAt", lastUsedAt)
}

private fun AuthKey.toJson(): JSONObject = JSONObject().apply {
    put("id", id); put("name", name); put("hasPassphrase", hasPassphrase); put("importedAt", importedAt)
}
