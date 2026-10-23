package com.deepseek.harness.android.ssh

import org.json.JSONObject

/**
 * The remote `dsh web` service: adopt it when it is healthy, otherwise clear the
 * deck and launch a fresh one.
 *
 * Every command string below mirrors the desktop shell's remote protocol
 * (`connection.js` / `runtime-store.js`), because the remote side is the SAME
 * service. Where a step only exists to work around a shell quirk (zsh not
 * word-splitting, sentinel markers, the trailing newline in the state file) the
 * original reason is preserved — those bugs are easy to reintroduce.
 */
class RemoteService(private val shell: RemoteShell, private val homeExpression: String) {

    data class State(val pid: Int, val port: Int, val version: String, val url: String)
    data class LaunchResult(val port: Int, val pid: Int, val url: String)

    fun statePath(): String = "${homeExpression}/desktop-web.state.json"
    private fun pidPath(): String = "${homeExpression}/desktop-web.pid"
    private fun portPath(): String = "${homeExpression}/desktop-web.port"
    private fun logPath(): String = "${homeExpression}/desktop-web.log"
    private fun runtimeDir(): String = "${homeExpression}/runtime"

    // ── state file ──────────────────────────────────────────────────────────

    suspend fun readState(): State? {
        val result = shell.run("cat ${statePath()} 2>/dev/null || echo __none__", timeoutMs = 15_000)
        for (line in result.lines) {
            val trimmed = line.trim()
            if (!trimmed.startsWith("{")) continue
            parseState(trimmed)?.let { return it }
        }
        return null
    }

    private fun parseState(text: String): State? = runCatching {
        val o = JSONObject(text)
        val pid = o.getInt("pid")
        val port = o.getInt("port")
        val version = o.getString("version")
        if (port !in 1..65535) return null
        State(pid = pid, port = port, version = version, url = o.optString("url", ""))
    }.getOrNull()

    /**
     * Write the state file. The trailing newline is LOAD-BEARING: the remote
     * command is wrapped in sentinel markers and parsed per line, so a file
     * without one fuses the JSON with the END marker and every later read fails.
     */
    suspend fun writeState(state: State): Boolean {
        val json = "{\"pid\":${state.pid},\"port\":${state.port},\"version\":\"${Shell.safeVersion(state.version)}\",\"url\":\"${Shell.safeUrl(state.url)}\"}"
        val result = shell.run(
            "mkdir -p ${homeExpression} && printf '%s\\n' ${Shell.quote(json)} > ${statePath()} && cat ${statePath()}",
            timeoutMs = 15_000,
        )
        if (result.code != 0) return false
        return result.lines.any { it.trim() == json }
    }

    suspend fun removeState() {
        shell.run("rm -f ${pidPath()} ${statePath()} ${portPath()} 2>/dev/null || true", timeoutMs = 15_000)
    }

    // ── versions ────────────────────────────────────────────────────────────

    /** Version token of the active runtime (`manifest.json#current`), or "unknown". */
    suspend fun activeVersion(): String {
        val text = shell.run("cat ${runtimeDir()}/manifest.json 2>/dev/null || echo __none__", timeoutMs = 15_000)
            .lines.joinToString("").trim()
        val token = runCatching {
            val start = text.indexOf('{')
            val end = text.lastIndexOf('}')
            if (start < 0 || end <= start) "" else JSONObject(text.substring(start, end + 1)).optString("current", "")
        }.getOrDefault("")
        return token.ifBlank { "unknown" }
    }

    /** Whether a runtime with an executable CLI is actually present. */
    suspend fun hasRuntime(): Boolean {
        val probe = "if [ -f ${runtimeDir()}/current/apps/cli/lib/bin.js ] || " +
            "[ -f ${runtimeDir()}/current/node_modules/@deepseek-ai/dsh/lib/bin.js ]; then echo bin-ok; else echo bin-missing; fi"
        return shell.run(probe, timeoutMs = 20_000).contains("bin-ok")
    }

    // ── probing ─────────────────────────────────────────────────────────────

    /**
     * Ask the REMOTE HOST whether the recorded port answers as dsh. Probing
     * through the tunnel would cost a full tunnel setup for a service that is
     * already dead, and would surface ssh's "Connection refused" instead of a
     * clean fall-through.
     *
     * `case` rather than `grep`: the login shell is zsh on many hosts, and a
     * pipeline's exit status is not something to depend on.
     */
    suspend fun probePort(port: Int): Boolean {
        if (port !in 1..65535) return false
        val probe = "body=\$(curl -sL --max-time 5 http://127.0.0.1:${port}/ 2>/dev/null); " +
            "case \"\$body\" in *__DSH_BOOT__*|*\"dsh web authentication required\"*) echo 1 ;; *) echo 0 ;; esac"
        return shell.run(probe, timeoutMs = 20_000).lines.any { it.trim() == "1" }
    }

    // ── lifecycle ───────────────────────────────────────────────────────────

    suspend fun pidAlive(pid: Int): Boolean {
        if (pid <= 0) return false
        return shell.run("kill -0 ${pid} 2>/dev/null && echo alive || echo dead", timeoutMs = 15_000)
            .lines.any { it.trim() == "alive" }
    }

    /**
     * Kill every `dsh web` host over THIS dsh home except [keepPid].
     *
     * Confined by `usesHome` so a colleague's instance on a shared box is never
     * touched, and restricted to processes whose command starts with `node` — a
     * `bash -c "… bin.js web …"` wrapper shares the command line but killing it
     * takes down a launcher, not a host.
     */
    suspend fun sweepHosts(keepPid: Int = 0): Int {
        val scan = "ps ax -o pid=,command= 2>/dev/null | grep -E \"bin\\.js +web\" | grep -v grep | " +
            "grep -E \"^[[:space:]]*[0-9]+[[:space:]]+([^[:space:]]*/)?node([0-9.]*)?[[:space:]]\" | " +
            "sed -E \"s/^[[:space:]]*([0-9]+).*/\\1/\" | while read p; do " +
            "uses=\$(lsof -Fn -p \$p 2>/dev/null | grep -c \"^n${homeExpression}/\"); " +
            "echo \"\$p|\$uses\"; done"
        val result = shell.run(scan, timeoutMs = 30_000)
        val pids = result.lines.mapNotNull { line ->
            val parts = line.trim().split("|")
            if (parts.size != 2) return@mapNotNull null
            val pid = parts[0].toIntOrNull() ?: return@mapNotNull null
            val usesHome = parts[1].toIntOrNull() ?: 0
            if (usesHome > 0 && pid != keepPid && pid > 0) pid else null
        }
        if (pids.isEmpty()) return 0
        return killPids(pids)
    }

    /**
     * Signal pids and wait for them to go: sample liveness, TERM, poll up to ~5s
     * for the task-board ledger to be released, then KILL stragglers.
     *
     * The pid list is interpolated LITERALLY and matched with `case`: zsh does
     * not word-split an unquoted variable, so `for p in $alive` runs once with
     * the whole list as one argument — the kill then no-ops while still
     * reporting success.
     */
    suspend fun killPids(pids: List<Int>): Int {
        val list = pids.filter { it > 0 }.joinToString(" ")
        if (list.isEmpty()) return 0
        fun killSnippet(signal: String) =
            "for p in ${list}; do case \" \$alive \" in *\" \$p \"*) ${signal} ;; esac; done"
        val kill = "alive=\"\"; for p in ${list}; do if kill -0 \$p 2>/dev/null; then alive=\"\$alive \$p\"; fi; done; " +
            "echo \"ALIVE\$alive\"; ${killSnippet("kill \$p 2>/dev/null")}; " +
            "for i in 1 2 3 4 5 6 7 8 9 10; do left=0; for p in ${list}; do " +
            "case \" \$alive \" in *\" \$p \"*) if kill -0 \$p 2>/dev/null; then left=1; fi ;; esac; done; " +
            "if [ \$left -eq 0 ]; then break; fi; sleep 0.5; done; " +
            "${killSnippet("kill -9 \$p 2>/dev/null")}; sleep 0.5"
        val result = shell.run(kill, timeoutMs = 30_000)
        val reported = result.lines.firstOrNull { it.trim().startsWith("ALIVE") }
            ?.trim()?.removePrefix("ALIVE")?.trim().orEmpty()
        return reported.split(Regex("\\s+")).mapNotNull { it.toIntOrNull() }.count { it > 0 }
    }

    /**
     * Start `dsh web` detached with `--port 0` and read back the announced port.
     *
     * `\$\$` plus `exec`: the pid file must record the REAL node process, so the
     * launch shell writes its own pid and is then replaced by node in place.
     * Writing `\$!` instead records the `setsid` wrapper, which exits
     * immediately on most Linux setups — the wait loop below then declares a
     * healthy service dead.
     *
     * No `--no-open`: on the remote the harness sees SSH_CONNECTION and skips
     * the browser handoff by itself, and passing the flag would abort an older
     * runtime with "unknown option".
     */
    suspend fun launch(): LaunchResult {
        val version = activeVersion()
        val runNode = "export DSH_HOME=${homeValue()}; cd ${runtimeDir()}/current && " +
            "BIN=apps/cli/lib/bin.js; [ -f \"\$BIN\" ] || BIN=node_modules/@deepseek-ai/dsh/lib/bin.js; " +
            "echo \$\$ > ${pidPath()}; exec node \"\$BIN\" web --port 0 > ${portPath()} 2>> ${logPath()} < /dev/null"
        val startCommand = "if command -v setsid >/dev/null 2>&1; then " +
            "setsid sh -c ${Shell.quote(runNode)} </dev/null >/dev/null 2>&1 & " +
            "else nohup sh -c ${Shell.quote(runNode)} >/dev/null 2>&1 </dev/null & fi"
        val start = shell.run(
            "${toolchainPrefix()} mkdir -p ${homeExpression}; rm -f ${portPath()} ${pidPath()}; ${startCommand}",
            timeoutMs = 30_000,
        )
        if (start.code != 0) throw IllegalStateException("远程服务启动失败：" + start.lines.joinToString("\n"))

        // Crash detection only fires once the pid file EXISTS (the service has
        // already exec'd node) AND that pid is dead, so a launcher that exits
        // early can never be mistaken for a crashed service.
        val wait = "for i in \$(seq 1 150); do " +
            "line=\$(head -1 ${portPath()} 2>/dev/null | tr -d '\\r'); " +
            "case \"\$line\" in \"dsh web: \"*) echo \"\$line\"; exit 0 ;; esac; " +
            "pid=\$(cat ${pidPath()} 2>/dev/null || true); " +
            "if [ -n \"\$pid\" ] && ! kill -0 \"\$pid\" 2>/dev/null; then echo service-exited; " +
            "tail -n 20 ${logPath()} 2>/dev/null; exit 1; fi; sleep 0.2; done; echo port-timeout; exit 1"
        val waitResult = shell.run(wait, timeoutMs = 60_000)
        val announced = waitResult.lines.firstNotNullOfOrNull { parseAnnounced(it) }
            ?: throw IllegalStateException("远程服务未报告监听端口：" + waitResult.lines.takeLast(6).joinToString("\n"))
        val pid = shell.run("cat ${pidPath()} 2>/dev/null || echo 0", timeoutMs = 15_000)
            .first().toIntOrNull() ?: 0
        if (pid <= 0) throw IllegalStateException("远程服务 pid 读取失败。")
        writeState(State(pid = pid, port = announced.first, version = version, url = announced.second))
        return LaunchResult(port = announced.first, pid = pid, url = announced.second)
    }

    /** `dsh web: http://127.0.0.1:<port>/?token=…` → (port, url). */
    private fun parseAnnounced(line: String): Pair<Int, String>? {
        val match = Regex("^dsh web:\\s+(https?://\\S+)").find(line.trim()) ?: return null
        val url = match.groupValues[1]
        val port = runCatching { java.net.URI(url).port }.getOrNull() ?: return null
        if (port !in 1..65535) return null
        return port to url
    }

    /**
     * The harness home as a shell expression. `dsh` resolves its own home from
     * \`$DSH_HOME\`, falling back to \`$HOME/.dsh\`; the launcher exports it so a
     * custom home (a shared build box, a per-project harness) is honoured by the
     * service as well as by this client.
     */
    private fun homeValue(): String = homeExpression

    /** The portable node/pnpm the desktop shell provisions on the remote. */
    private fun toolchainPrefix(): String =
        "export DSH_LEFTHOOK_ALLOW_HOOKS_PATH_OVERRIDE=1; " +
            "export PATH=\"\$HOME\"/.dsh-tools/node/bin:\"\$HOME\"/.dsh-tools/node_modules/.bin:\"\$PATH\";"
}
