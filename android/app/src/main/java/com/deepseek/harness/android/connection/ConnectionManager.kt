package com.deepseek.harness.android.connection

import com.deepseek.harness.android.data.AuthKey
import com.deepseek.harness.android.data.ConnectionMode
import com.deepseek.harness.android.data.Device
import com.deepseek.harness.android.data.DeviceStore
import com.deepseek.harness.android.net.HttpProbe
import com.deepseek.harness.android.ssh.LocalNet
import com.deepseek.harness.android.ssh.RemoteService
import com.deepseek.harness.android.ssh.RemoteShell
import com.deepseek.harness.android.ssh.Shell
import com.deepseek.harness.android.ssh.SshConnector
import com.jcraft.jsch.Session
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Owns one device connection: SSH session, port forward, the remote service it
 * adopts or launches, and the health watchdog.
 *
 * Two behavioural rules are inherited from the desktop shell because they are
 * what makes a reconnect invisible to the user:
 *
 * 1. **Adopt before launching.** A healthy service whose version matches the
 *    active runtime is reused. Launching unconditionally would churn the remote
 *    and invalidate every launch token, so every reconnect would open an
 *    unauthenticated page.
 * 2. **Republish after restart.** A restarted service is started with
 *    `--port 0`, so it comes back on a NEW port; the ready state must carry the
 *    new URL, or a window would sit on a dead endpoint forever.
 */
class ConnectionManager(
    private val scope: CoroutineScope,
    private val store: DeviceStore,
) {
    private val _state = MutableStateFlow<ConnectionState>(ConnectionState.Idle)
    val state: StateFlow<ConnectionState> = _state.asStateFlow()

    val log = LogRing()

    @Volatile private var session: Session? = null
    @Volatile private var localPort: Int = 0

    /** Bumped on every connect/stop; stale callbacks compare against it. */
    @Volatile private var epoch: Int = 0
    private var healthJob: Job? = null
    private var connectJob: Job? = null

    private fun emit(text: String) = log.add(text)

    fun connect(target: Device) {
        disconnect(silent = true)
        epoch += 1
        val myEpoch = epoch
        _state.value = ConnectionState.Connecting("正在连接…")
        // Dispatchers.IO is load-bearing: this body opens sockets (the TCP probe
        // that waits for the forward, and the HTTP probes). On the Main dispatcher
        // Android throws NetworkOnMainThreadException, the probe swallows it as
        // "not up", and every tunnel looks like it timed out even though JSch had
        // already bound the local port.
        connectJob = scope.launch(Dispatchers.IO) {
            try {
                when (target.mode) {
                    ConnectionMode.SSH -> connectSsh(target, myEpoch)
                    ConnectionMode.URL -> connectUrl(target)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (epoch != myEpoch) return@launch
                teardownQuietly()
                val message = error.message ?: error.toString()
                emit("连接失败：$message")
                _state.value = ConnectionState.Failed(message, hintFor(error))
            }
        }
    }

    fun disconnect(silent: Boolean = false) {
        epoch += 1
        healthJob?.cancel()
        healthJob = null
        connectJob?.cancel()
        connectJob = null
        teardownQuietly()
        if (!silent) {
            emit("已断开")
            _state.value = ConnectionState.Stopped
        }
    }

    private fun teardownQuietly() {
        runCatching { session?.disconnect() }
        session = null
        localPort = 0
    }

    // ── ssh mode ────────────────────────────────────────────────────────────

    private suspend fun connectSsh(target: Device, myEpoch: Int) {
        _state.value = ConnectionState.Connecting("正在建立 SSH 连接…")
        emit("连接 SSH ${target.displayTarget()} …")

        val keys = store.authKeys.value.filter { it.id == target.authKeyId }
            .ifEmpty { store.authKeys.value }
        val connector = SshConnector { key: AuthKey ->
            store.keyMaterial(key.id)?.let { bytes -> bytes to store.keyPassphrase(key.id) }
        }
        val (newSession, shell) = connector.connect(
            SshConnector.Options(
                host = target.host,
                port = target.port,
                user = target.user,
                keys = keys,
            )
        )
        if (epoch != myEpoch) {
            runCatching { newSession.disconnect() }
            return
        }
        session = newSession
        emit("SSH 已连接（登录 shell：${shell.loginShell}）")

        if (!target.manageService) {
            // Tunnel-only: the user runs the service themselves.
            _state.value = ConnectionState.Connecting("正在探测已有服务…")
            val state = RemoteService(shell, homeFor(target)).readState()
                ?: throw IllegalStateException("远端没有可复用的服务，且已关闭「托管服务」。请先在桌面端启动，或重新开启托管。")
            openTunnel(target, shell, state.port, state.url, myEpoch)
            return
        }

        val service = RemoteService(shell, homeFor(target))
        _state.value = ConnectionState.Connecting("正在检查远端运行时…")
        if (!service.hasRuntime()) {
            throw IllegalStateException("远端缺少 DSH 运行时（~/.dsh/runtime/current）。请先用桌面端连接一次以完成安装。")
        }
        val activeVersion = service.activeVersion()
        emit("远端运行时版本：$activeVersion")

        _state.value = ConnectionState.Connecting("正在检查已有服务…")
        val existing = service.readState()
        if (existing != null && existing.version == activeVersion && service.probePort(existing.port)) {
            _state.value = ConnectionState.Connecting("正在复用已有服务…")
            val verdict = openTunnel(target, shell, existing.port, existing.url, myEpoch)
            // A recorded token is only good while the service that minted it is
            // still answering; a rejected token means restart for a fresh one.
            if (verdict != false) {
                emit("复用远端 dsh web（端口 ${existing.port}）")
                return
            }
            emit("启动令牌已失效，重启远端服务以获取新的认证 URL…")
            teardownQuietly()
        } else if (existing != null && existing.version != activeVersion) {
            emit("远端服务版本不符（${existing.version} ≠ $activeVersion），重启…")
        } else if (existing != null) {
            emit("远端服务已退出（端口 ${existing.port}），自动重启…")
        }

        _state.value = ConnectionState.Connecting("正在清理残留服务…")
        val swept = service.sweepHosts(keepPid = 0)
        if (swept > 0) {
            emit("清理残留远端 dsh web（$swept 个）")
            delay(2000)
        }

        _state.value = ConnectionState.Connecting("正在启动远端服务…")
        val launched = service.launch()
        emit("远端 dsh web 已监听端口 ${launched.port}")
        if (epoch != myEpoch) return
        openTunnel(target, shell, launched.port, launched.url, myEpoch)
    }

    /**
     * Open the local forward and declare ready.
     *
     * Returns the token verdict when a token URL was supplied (true accepted /
     * false rejected / null unknown), or null when there was no token to judge.
     */
    private suspend fun openTunnel(
        target: Device,
        shell: RemoteShell,
        remotePort: Int,
        announcedUrl: String,
        myEpoch: Int,
    ): Boolean? {
        _state.value = ConnectionState.Connecting("正在建立本地转发…")
        val active = session ?: throw IllegalStateException("SSH 会话已断开，无法建立转发。")
        // Ask JSch to bind a free loopback port itself and report which one it
        // got. Probing for a free port and then binding it is a race, and the
        // fixed (host, lport, rhost, rport) overload fails outright when that
        // port was taken in between.
        val port = active.setPortForwardingL("127.0.0.1", 0, "127.0.0.1", remotePort)
        localPort = port
        emit("隧道 127.0.0.1:$port → ${target.host}:$remotePort")
        if (!LocalNet.awaitTcp(port, timeoutMs = 15_000)) {
            throw IllegalStateException("隧道建立超时（本地端口 $port 未就绪）。请检查 SSH 配置后重试。")
        }
        val webUrl = HttpProbe.rehostUrl(announcedUrl, port).ifBlank { "http://127.0.0.1:$port/" }
        val verdict = if (announcedUrl.isNotBlank()) HttpProbe.tokenAccepted(webUrl) else null
        val probe = HttpProbe.probe(webUrl)
        if (epoch != myEpoch) return verdict
        if (!probe.up) {
            throw IllegalStateException("隧道已建立，但本地端口没有响应。")
        }
        _state.value = ConnectionState.Ready(
            url = webUrl,
            localPort = port,
            remotePort = remotePort,
            detail = "已连接（${target.name}，隧道转发）",
        )
        startHealthMonitor(target, myEpoch)
        return verdict
    }

    // ── url mode ────────────────────────────────────────────────────────────

    private suspend fun connectUrl(target: Device) {
        _state.value = ConnectionState.Connecting("正在连接…")
        val url = target.url.trim().let { if (it.endsWith("/")) it else "$it/" }
        val probe = HttpProbe.probe(url)
        if (!probe.isDsh) {
            throw IllegalStateException(
                if (probe.up) "该地址有响应，但它不是 DeepSeek Harness。"
                else "无法连接到 ${target.url}。请检查地址、网络或反向代理。"
            )
        }
        emit("已连接 ${target.url}")
        _state.value = ConnectionState.Ready(
            url = url,
            localPort = 0,
            remotePort = null,
            detail = "已连接（${target.name}）",
        )
    }

    // ── health ──────────────────────────────────────────────────────────────

    /**
     * Poll the service while ready, and reconnect after two consecutive
     * failures.
     *
     * There is no close event to listen to on the remote side (the service is
     * detached on purpose so it survives a dropped connection), so this is the
     * only way to notice an in-place restart — exactly the case where the port
     * changes and the WebView would otherwise sit on a dead endpoint.
     */
    private fun startHealthMonitor(target: Device, myEpoch: Int) {
        healthJob?.cancel()
        healthJob = scope.launch(Dispatchers.IO) {
            var failures = 0
            while (isActive && epoch == myEpoch) {
                delay(HEALTH_INTERVAL_MS)
                if (epoch != myEpoch) return@launch
                if (_state.value !is ConnectionState.Ready) return@launch
                val ready = _state.value as ConnectionState.Ready
                val probe = HttpProbe.probe(ready.url, timeoutMs = 3000)
                if (probe.up) {
                    failures = 0
                } else {
                    failures += 1
                    emit("健康检查失败（$failures/$HEALTH_FAILURE_THRESHOLD）")
                    if (failures >= HEALTH_FAILURE_THRESHOLD) {
                        emit("服务不可用，正在自动重连…")
                        connect(target)
                        return@launch
                    }
                }
            }
        }
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private fun homeFor(target: Device): String = Shell.expandDshHome(target.remoteDshHome)

    private fun hintFor(error: Exception): String? {
        val message = (error.message ?: "").lowercase()
        return when {
            "auth" in message || "userauth" in message ->
                "认证失败：确认已导入对应私钥，且远端 ~/.ssh/authorized_keys 中包含该公钥。"
            "timeout" in message || "timed out" in message ->
                "连接超时：确认手机与主机网络可达，或已连接 VPN。"
            "hostkey" in message || "host key" in message ->
                "主机密钥校验失败。若非预期，请勿继续连接。"
            else -> null
        }
    }

    companion object {
        const val PREFERRED_LOCAL_PORT = 3080
        const val HEALTH_INTERVAL_MS = 4000L
        const val HEALTH_FAILURE_THRESHOLD = 2
    }
}
