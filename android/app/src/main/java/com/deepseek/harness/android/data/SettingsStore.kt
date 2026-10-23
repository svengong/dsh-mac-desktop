package com.deepseek.harness.android.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.settingsDataStore by preferencesDataStore(name = "dsh-settings")

/** UX preferences only — connection state lives in [Device]. */
data class AppSettings(
    val themeMode: String = "system",       // system | light | dark
    val keepScreenOn: Boolean = true,
    val lastDeviceId: String? = null,
    val tabletRailLocked: Boolean = true,
    val fontScale: Float = 1.0f,
)

class SettingsStore(private val context: Context) {

    private object Keys {
        val theme = stringPreferencesKey("theme")
        val keepScreenOn = booleanPreferencesKey("keep_screen_on")
        val lastDeviceId = stringPreferencesKey("last_device")
        val railLocked = booleanPreferencesKey("rail_locked")
        val fontScale = floatPreferencesKey("font_scale")
    }

    val flow: Flow<AppSettings> = context.settingsDataStore.data.map { p ->
        AppSettings(
            themeMode = p[Keys.theme] ?: "system",
            keepScreenOn = p[Keys.keepScreenOn] ?: true,
            lastDeviceId = p[Keys.lastDeviceId],
            tabletRailLocked = p[Keys.railLocked] ?: true,
            fontScale = p[Keys.fontScale] ?: 1.0f,
        )
    }

    suspend fun load(): AppSettings = flow.first()

    suspend fun update(block: (AppSettings) -> AppSettings) {
        val current = flow.first()
        val next = block(current)
        context.settingsDataStore.edit { p ->
            p[Keys.theme] = next.themeMode
            p[Keys.keepScreenOn] = next.keepScreenOn
            next.lastDeviceId?.let { p[Keys.lastDeviceId] = it }
            p[Keys.railLocked] = next.tabletRailLocked
            p[Keys.fontScale] = next.fontScale
        }
    }
}
