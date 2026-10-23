package com.deepseek.harness.android.ssh

import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket

/** Loopback helpers: a free local forward port and a TCP liveness probe. */
object LocalNet {

    /** First free loopback port at or after [preferred]; scans the same span as `ports.js`. */
    fun findFreePort(preferred: Int, span: Int = 30): Int {
        for (port in preferred until preferred + span) {
            if (isFree(port)) return port
        }
        return ServerSocket(0, 0, java.net.InetAddress.getByName("127.0.0.1")).use { it.localPort }
    }

    fun isFree(port: Int): Boolean = try {
        ServerSocket(port, 0, java.net.InetAddress.getByName("127.0.0.1")).use { true }
    } catch (_: Exception) {
        false
    }

    /** Whether something accepts TCP on 127.0.0.1:[port] right now. */
    fun tcpProbe(port: Int, timeoutMs: Int = 700): Boolean = try {
        Socket().use { it.connect(InetSocketAddress("127.0.0.1", port), timeoutMs) }
        true
    } catch (_: Exception) {
        false
    }

    /** Poll until [port] accepts, or the deadline passes. */
    suspend fun awaitTcp(port: Int, timeoutMs: Long, stepMs: Long = 200): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (tcpProbe(port)) return true
            kotlinx.coroutines.delay(stepMs)
        }
        return false
    }
}
