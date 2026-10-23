package com.deepseek.harness.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.deepseek.harness.android.connection.ConnectionManager
import com.deepseek.harness.android.data.Device
import com.deepseek.harness.android.service.HarnessConnectionService
import com.deepseek.harness.android.ui.DshRoot
import com.deepseek.harness.android.ui.DshTheme
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private lateinit var manager: ConnectionManager

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = application as DshApp
        manager = ConnectionManager(lifecycleScope, app.devices, applicationContext)

        setContent {
            val settings by app.settings.flow.collectAsStateWithLifecycle(initialValue = null)
            val devices by app.devices.devices.collectAsStateWithLifecycle()
            val authKeys by app.devices.authKeys.collectAsStateWithLifecycle()
            val connection by manager.state.collectAsStateWithLifecycle()

            val dark = when (settings?.themeMode) {
                "light" -> false
                "dark" -> true
                else -> androidx.compose.foundation.isSystemInDarkTheme()
            }
            DshTheme(darkTheme = dark) {
                DshRoot(
                    manager = manager,
                    devices = devices,
                    authKeys = authKeys,
                    settings = settings,
                    connection = connection,
                    onSaveDevice = { device -> lifecycleScope.launch { app.devices.upsert(device) } },
                    onDeleteDevice = { id -> lifecycleScope.launch { app.devices.delete(id) } },
                    onTouchDevice = { id -> lifecycleScope.launch { app.devices.markUsed(id) } },
                    onImportKey = { name, pem, pass -> app.devices.importKey(name, pem, pass) },
                    onDeleteKey = { id -> lifecycleScope.launch { app.devices.deleteKey(id) } },
                    onThemeChange = { mode -> lifecycleScope.launch { app.settings.update { it.copy(themeMode = mode) } } },
                    onConnectionChanged = { ready ->
                        if (ready) HarnessConnectionService.start(this) else HarnessConnectionService.stop(this)
                    },
                )
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        if (isFinishing) manager.disconnect(silent = true)
    }
}
