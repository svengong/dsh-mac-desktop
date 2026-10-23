package com.deepseek.harness.android.ssh

import com.jcraft.jsch.ChannelExec
import com.jcraft.jsch.Session
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.util.UUID

/** Result of one remote command. [lines] are already stripped of CR and banners. */
data class RemoteResult(
    val code: Int,
    val lines: List<String>,
    val raw: String,
) {
    fun first(): String = lines.firstOrNull()?.trim().orEmpty()
    fun contains(token: String): Boolean = lines.any { it.trim() == token }
}

/**
 * A login-shell command runner over one SSH [Session].
 *
 * Two behaviours are copies of the desktop shell on purpose, because the remote
 * side is the SAME `dsh web` service and it is picky about both:
 *
 * 1. **Login shell**: commands run through `<loginShell> -l -c '<cmd>'` so the
 *    PATH the user's profile sets up (nvm/fnm/homebrew) is in effect. Running a
 *    non-login shell is how the harness silently exits 0 with no output — the
 *    "service flashes and dies" bug.
 * 2. **Payload markers**: ssh gateways print banners (`authz success`) before
 *    the command runs. Every parse would have to skip unknown lines, so instead
 *    the command is wrapped in random markers and only the payload between them
 *    is returned.
 */
class RemoteShell(private val session: Session) {

    @Volatile
    var loginShell: String = "/bin/sh"
        private set

    val beginMarker: String = "__DSH_PAYLOAD_BEGIN_" + UUID.randomUUID().toString().replace("-", "") + "__"
    val endMarker: String = "__DSH_PAYLOAD_END_" + UUID.randomUUID().toString().replace("-", "") + "__"

    /** Resolve the account's real login shell once per connection. */
    suspend fun probeLoginShell(): String = withContext(Dispatchers.IO) {
        val probe = "c=\$(getent passwd \"\$(id -un)\" 2>/dev/null | cut -d: -f7); " +
            "[ -n \"\$c\" ] || c=\${SHELL:-}; " +
            "for s in \"\$c\" /bin/bash /usr/bin/bash /bin/zsh /usr/bin/zsh /bin/sh; do " +
            "case \"\$s\" in \"\"|*/nologin|*/false) continue ;; esac; [ -x \"\$s\" ] || continue; " +
            "case \"\${s##*/}\" in bash|zsh|sh|dash|ksh|ksh93|mksh|ash) printf '%s\\n' \"\$s\"; exit 0 ;; esac; done; " +
            "printf '%s\\n' /bin/sh"
        val result = runRaw(probe, timeoutMs = 15_000)
        val accepted = listOf("bash", "zsh", "sh", "dash", "ksh", "ksh93", "mksh", "ash")
        loginShell = result.lines
            .map { it.trim() }
            .firstOrNull { line -> line.startsWith("/") && line.substringAfterLast('/') in accepted }
            ?: "/bin/sh"
        loginShell
    }

    /** Run [inner] through the login shell and return only its payload lines. */
    suspend fun run(inner: String, timeoutMs: Int = 30_000): RemoteResult = withContext(Dispatchers.IO) {
        val wrapped = "echo $beginMarker; ( $inner ); __dsh_rc=\$?; echo $endMarker; exit \$__dsh_rc"
        val command = "$loginShell -l -c ${Shell.quote(wrapped)}"
        val raw = runRaw(command, timeoutMs)
        raw.copy(lines = Payload.extract(raw.raw, beginMarker, endMarker))
    }

    private fun runRaw(command: String, timeoutMs: Int): RemoteResult {
        val channel = session.openChannel("exec") as ChannelExec
        channel.setCommand(command)
        val out = ByteArrayOutputStream()
        val err = ByteArrayOutputStream()
        channel.setOutputStream(out)
        channel.setErrStream(err)
        var code = -1
        try {
            channel.connect(timeoutMs)
            val deadline = System.currentTimeMillis() + timeoutMs
            while (!channel.isClosed && System.currentTimeMillis() < deadline) Thread.sleep(40)
            if (!channel.isClosed) {
                channel.disconnect()
                return RemoteResult(-1, emptyList(), "timeout after ${timeoutMs}ms")
            }
            code = channel.exitStatus
        } finally {
            channel.disconnect()
        }
        val text = out.toString(Charsets.UTF_8.name())
        val errText = err.toString(Charsets.UTF_8.name())
        val combined = if (errText.isBlank()) text else text + errText
        val lines = combined.split("\n").map { it.removeSuffix("\r") }
        return RemoteResult(code, lines, combined)
    }
}

/** Remote-shell string helpers, mirrored from the desktop shell's ssh.js. */
object Shell {
    /** Single-quote a value for a POSIX shell; a quote becomes close-escape-open. */
    fun quote(value: String): String = "'" + value.replace("'", "'\\''") + "'"

    /** `~/x` must be expanded BY THE REMOTE SHELL, so it cannot be quoted away. */
    fun remotePath(dir: String): String =
        if (dir.startsWith("~/")) "\"\$HOME\"/" + quote(dir.removePrefix("~/")) else quote(dir)

    fun expandDshHome(configured: String): String =
        if (configured.isBlank()) "\"\$HOME\"/.dsh" else remotePath(configured)

    /** Keep a version/url safe for embedding in a double-quoted printf argument. */
    fun safeVersion(value: String): String = value.filter { it.isLetterOrDigit() || it in "._-" }.take(64)
    fun safeUrl(value: String): String =
        value.filter { it.isLetterOrDigit() || it in "._~:/?#@!&*+,;=%-" }.take(512)
}

/**
 * Extract the payload between two markers.
 *
 * Matched as a SUBSTRING, not per line: a command whose output has no trailing
 * newline fuses with the END marker, and whole-line matching would drop it.
 */
object Payload {
    fun extract(raw: String, begin: String, end: String): List<String> {
        val beginPos = raw.indexOf(begin)
        if (beginPos < 0) return raw.split("\n").map { it.removeSuffix("\r") }.filter { it.isNotBlank() }
        val afterBegin = raw.substring(beginPos + begin.length)
        val endPos = afterBegin.indexOf(end)
        val payload = if (endPos >= 0) afterBegin.substring(0, endPos) else afterBegin
        return payload.split("\n")
            .map { it.removeSuffix("\r") }
            .dropWhile { it.isEmpty() }
            .dropLastWhile { it.isEmpty() }
    }
}
