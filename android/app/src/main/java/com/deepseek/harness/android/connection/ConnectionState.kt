package com.deepseek.harness.android.connection

/** What the shell is doing right now, per device. */
sealed interface ConnectionState {
    data object Idle : ConnectionState
    data class Connecting(val step: String) : ConnectionState
    data class Ready(
        val url: String,
        val localPort: Int,
        val remotePort: Int?,
        val detail: String,
    ) : ConnectionState
    data class Failed(val message: String, val hint: String? = null) : ConnectionState
    data object Stopped : ConnectionState
}

/**
 * A connection failure that already knows what the user should check.
 *
 * Throwing this instead of a bare `IllegalStateException` keeps the diagnosis next
 * to the code that made it. A generic hint that only string-matches the message
 * cannot tell "the address is wrong" from "nothing listens on that port" from
 * "the harness refused this authority" — and those need different actions.
 */
class ConnectionFailure(message: String, val hint: String? = null) : Exception(message)

/** One line of the in-app log, mirrored to the log screen. */
data class LogLine(val at: Long, val text: String)

/** Guarded ring buffer, 300 lines like the desktop shell. */
class LogRing(private val capacity: Int = 300) {
    private val items = ArrayDeque<LogLine>()

    @Synchronized
    fun add(text: String) {
        items.addLast(LogLine(System.currentTimeMillis(), text))
        while (items.size > capacity) items.removeFirst()
    }

    @Synchronized
    fun snapshot(): List<LogLine> = items.toList()

    @Synchronized
    fun clear() = items.clear()
}
