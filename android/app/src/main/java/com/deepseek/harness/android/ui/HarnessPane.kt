package com.deepseek.harness.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Article
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.DarkMode
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.LightMode
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.deepseek.harness.android.connection.ConnectionManager
import com.deepseek.harness.android.connection.ConnectionState
import com.deepseek.harness.android.data.Device

/**
 * Everything to the right of the rail (tablet) or everything on the harness
 * route (phone).
 *
 * The contract is the same on both: the WebView is shown ONLY when the
 * connection is ready AND the page has finished loading; every other state is
 * covered by a shell panel. That is what removes the white flash between "tap a
 * terminal" and "the conversation appears" — a WebView that is mounted early
 * paints its own empty background first.
 */
@Composable
fun HarnessPane(
    manager: ConnectionManager,
    selected: Device?,
    connection: ConnectionState,
    showLog: Boolean,
    onShowLog: (Boolean) -> Unit,
    onReconnect: () -> Unit,
    onAdd: () -> Unit,
    onConnectionChanged: (Boolean) -> Unit,
    maxWidth: Dp,
    modifier: Modifier = Modifier,
    onBackToList: (() -> Unit)? = null,
    topBar: (@Composable () -> Unit)? = null,
) {
    if (showLog) {
        // The log belongs HERE, in the right pane. It used to render a placeholder
        // saying the log lived in the left rail — but the rail only ever holds the
        // toggle, so on a tablet the log was unreachable: tapping "日志" replaced
        // the harness with a sentence pointing at nothing. The phone route stack
        // has always rendered it in place; the two-pane layout now does too.
        LogScreen(manager = manager, onBack = { onShowLog(false) })
        // Returning from the log must land back on the harness, not on a blank pane.
        return
    }
    when (connection) {
        is ConnectionState.Ready -> ReadyPane(
            device = selected,
            state = connection,
            maxWidth = maxWidth,
            modifier = modifier,
            topBar = topBar,
            onConnectionChanged = onConnectionChanged,
        )
        is ConnectionState.Connecting -> ShellPanel(
            modifier = modifier,
            topBar = topBar,
            title = "正在连接",
            subtitle = selected?.name,
        ) {
            Column(
                Modifier.fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp)
                Spacer(Modifier.height(16.dp))
                Text(
                    connection.step,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
            }
        }
        is ConnectionState.Failed -> ShellPanel(
            modifier = modifier,
            topBar = topBar,
            title = "连接失败",
            subtitle = selected?.name,
        ) {
            Column(
                Modifier.fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Icon(
                    Icons.Filled.Error,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.error,
                    modifier = Modifier.size(36.dp),
                )
                Spacer(Modifier.height(14.dp))
                Text(
                    connection.message,
                    style = MaterialTheme.typography.bodyMedium,
                    textAlign = TextAlign.Center,
                )
                connection.hint?.let { hint ->
                    Spacer(Modifier.height(10.dp))
                    Text(
                        hint,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )
                }
                Spacer(Modifier.height(20.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    FilledTonalButton(onClick = onReconnect) { Text("重试") }
                    if (onBackToList != null) TextButton(onClick = onBackToList) { Text("返回终端列表") }
                }
            }
        }
        else -> ShellPanel(
            modifier = modifier,
            topBar = topBar,
            title = if (selected == null) "选择一个终端" else selected.name,
            subtitle = if (selected == null) null else selected.displayTarget(),
        ) {
            Column(
                Modifier.fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Icon(
                    Icons.Filled.Computer,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(40.dp),
                )
                Spacer(Modifier.height(14.dp))
                Text(
                    if (selected == null) "添加一个终端以开始使用 DeepSeek Harness。" else "点击「连接」打开该终端。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(18.dp))
                if (selected == null) {
                    FilledTonalButton(onClick = onAdd) { Text("新建终端") }
                } else {
                    FilledTonalButton(onClick = onReconnect) { Text("连接") }
                }
            }
        }
    }
}

/**
 * Ready state: the page, with the shell's loading cover until it has painted.
 *
 * [onConnectionChanged] is called once per URL so the foreground service tracks
 * the real connection lifetime rather than the user's taps.
 */
@Composable
private fun ReadyPane(
    device: Device?,
    state: ConnectionState.Ready,
    maxWidth: Dp,
    modifier: Modifier,
    topBar: (@Composable () -> Unit)?,
    onConnectionChanged: (Boolean) -> Unit,
) {
    var loading by remember(state.url) { mutableStateOf(true) }
    val context = LocalContext.current
    // Checked once per page load, not per frame: the answer only changes when the
    // user installs a WebView update, which restarts the process anyway.
    val support = remember(state.url) { WebViewSupport.check(context) }

    LaunchedEffect(state.url) { onConnectionChanged(true) }

    Column(modifier.fillMaxSize()) {
        topBar?.invoke()
        if (!support.supported) {
            IncompatibleWebViewPanel(support)
            return@Column
        }
        Box(Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
                HarnessWebView(
                    url = state.url,
                    onLoadingChanged = { loading = it },
                    modifier = Modifier.fillMaxSize().widthIn(max = maxWidth),
                )
            }
            if (loading) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    Column(
                        Modifier.fillMaxSize().padding(32.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center,
                    ) {
                        CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp)
                        Spacer(Modifier.height(16.dp))
                        Text("正在加载页面…", style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        }
    }
}

/**
 * Shown instead of a blank WebView when the platform browser is too old.
 *
 * A blank page is indistinguishable from "the server is down", so the shell
 * states the actual cause and the exact remedy.
 */
@Composable
private fun IncompatibleWebViewPanel(support: WebViewSupport.Verdict) {
    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
        contentColor = MaterialTheme.colorScheme.onBackground,
    ) {
        Box(
            Modifier.fillMaxSize().padding(28.dp),
            contentAlignment = Alignment.Center,
        ) {
        Column(
            Modifier.widthIn(max = 460.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(
                Icons.Filled.Error,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.error,
                modifier = Modifier.size(36.dp),
            )
            Spacer(Modifier.height(14.dp))
            Text("系统 WebView 需要更新", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(10.dp))
            Text(
                support.message.orEmpty(),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            }
        }
    }
}

/** A centred, width-limited panel over the shell background. */
@Composable
private fun ShellPanel(
    modifier: Modifier,
    topBar: (@Composable () -> Unit)?,
    title: String,
    subtitle: String?,
    content: @Composable () -> Unit,
) {
    // Surface, not a `background()` modifier: a bare background paints a colour but
    // leaves the CONTENT colour at the LocalContentColor default (black), so every
    // Text without an explicit colour rendered black-on-black in dark theme. That
    // is invisible on a phone screenshot and obvious on a tablet, which is how it
    // was found.
    Surface(
        modifier = modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
        contentColor = MaterialTheme.colorScheme.onBackground,
    ) {
        Column(Modifier.fillMaxSize()) {
            topBar?.invoke()
            Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                Column(
                    Modifier.widthIn(max = 460.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(title, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
                    subtitle?.let {
                        Spacer(Modifier.height(4.dp))
                        Text(
                            it,
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    Spacer(Modifier.height(24.dp))
                    content()
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PhoneHarnessTopBar(
    device: Device?,
    connection: ConnectionState,
    onBack: () -> Unit,
    onReconnect: () -> Unit,
    onShowLog: () -> Unit,
    onAdd: () -> Unit,
    onThemeChange: (String) -> Unit,
    themeMode: String,
) {
    // The two-pane layout exposes these in the permanent left rail. Single-column
    // has no rail, so without an overflow menu on the phone there was simply no
    // way to add a terminal or change the theme there - the features existed and
    // were unreachable.
    var menuOpen by remember { mutableStateOf(false) }
    TopAppBar(
        navigationIcon = {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
            }
        },
        title = {
            Column {
                Text(
                    device?.name ?: "DeepSeek Harness",
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    when (connection) {
                        is ConnectionState.Ready -> connection.detail
                        is ConnectionState.Connecting -> connection.step
                        is ConnectionState.Failed -> "连接失败"
                        else -> "未连接"
                    },
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        },
        actions = {
            IconButton(onClick = onShowLog) {
                Icon(Icons.Filled.Article, contentDescription = "日志")
            }
            IconButton(onClick = onReconnect) {
                Icon(Icons.Filled.Refresh, contentDescription = "重新连接")
            }
            Box {
                IconButton(onClick = { menuOpen = true }) {
                    Icon(Icons.Filled.MoreVert, contentDescription = "更多")
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    DropdownMenuItem(
                        text = { Text("新建终端") },
                        leadingIcon = { Icon(Icons.Filled.Add, contentDescription = null) },
                        onClick = {
                            menuOpen = false
                            onAdd()
                        },
                    )
                    DropdownMenuItem(
                        text = { Text(if (themeMode == "dark") "浅色主题" else "深色主题") },
                        leadingIcon = {
                            Icon(
                                if (themeMode == "dark") Icons.Filled.LightMode else Icons.Filled.DarkMode,
                                contentDescription = null,
                            )
                        },
                        onClick = {
                            menuOpen = false
                            onThemeChange(
                                when (themeMode) {
                                    "system" -> "dark"
                                    "dark" -> "light"
                                    else -> "system"
                                }
                            )
                        },
                    )
                }
            }
        },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
    )
}
