package com.deepseek.harness.android

import android.app.Application
import com.deepseek.harness.android.data.DeviceStore
import com.deepseek.harness.android.data.SettingsStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Process-wide singletons. The app is a thin shell around one or more
 * "terminals" (devices): nothing here is product logic, only the plumbing that
 * keeps a harness service reachable from a phone or a tablet.
 */
class DshApp : Application() {

    val appScope: CoroutineScope by lazy { CoroutineScope(SupervisorJob() + Dispatchers.IO) }

    lateinit var settings: SettingsStore
        private set
    lateinit var devices: DeviceStore
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this
        settings = SettingsStore(this)
        devices = DeviceStore(this)
        appScope.launch {
            settings.load()
            devices.load()
        }
    }

    companion object {
        lateinit var instance: DshApp
            private set
    }
}
