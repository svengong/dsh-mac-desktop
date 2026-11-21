package com.deepseek.harness.android.connection

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionStateTest {
    @Test
    fun reselectingCurrentDeviceReusesReadyAndPendingConnections() {
        val ready = ConnectionState.Ready("kali", "http://127.0.0.1:3000/", 3000, 3080, "")
        val connecting = ConnectionState.Connecting("kali", "正在连接…")

        assertTrue(ready.canReuseFor("kali"))
        assertTrue(connecting.canReuseFor("kali"))
        assertFalse(ready.canReuseFor("ubuntu"))
        assertFalse(connecting.canReuseFor("ubuntu"))
    }

    @Test
    fun inactiveConnectionsCanBeStartedAgain() {
        val inactive = listOf(ConnectionState.Idle, ConnectionState.Stopped, ConnectionState.Failed("offline"))

        inactive.forEach { assertFalse(it.canReuseFor("kali")) }
    }
}
