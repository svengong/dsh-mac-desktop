package com.deepseek.harness.android.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Article
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.DarkMode
import androidx.compose.material.icons.filled.LightMode
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Language
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.deepseek.harness.android.connection.ConnectionManager
import com.deepseek.harness.android.connection.ConnectionState
import com.deepseek.harness.android.data.AppSettings
import com.deepseek.harness.android.data.AuthKey
import com.deepseek.harness.android.data.ConnectionMode
import com.deepseek.harness.android.data.Device

/**
 * The shell's whole surface.
 *
 * Two layouts share one state machine so nothing can drift between them:
 *
 * - [TwoPaneLayout] — tablet landscape: navigation rail + harness, side by side.
 *   Switching terminals keeps the WebView on screen; only its URL changes.
 * - [OnePaneLayout] — phone portrait: a single route stack (terminals → harness,
 *   or terminals → editor). The harness takes the whole screen because every
 *   pixel of a phone belongs to the conversation.
 */
@Composable
fun DshRoot(
    manager: ConnectionManager,
    devices: List<Device>,
    authKeys: List<AuthKey>,
    settings: AppSettings?,
    connection: ConnectionState,
    onSaveDevice: (Device) -> Unit,
    onDeleteDevice: (String) -> Unit,
    onTouchDevice: (String) -> Unit,
    onImportKey: suspend (String, String, String?) -> AuthKey,
    onDeleteKey: (String) -> Unit,
    onThemeChange: (String) -> Unit,
    onConnectionChanged: (Boolean) -> Unit,
) {
    val form = FormFactor.current()
    var selectedId by rememberSaveable { mutableStateOf(settings?.lastDeviceId) }
    var showLog by rememberSaveable { mutableStateOf(false) }
    var editorTarget by remember { mutableStateOf<Device?>(null) }
    var showEditor by rememberSaveable { mutableStateOf(false) }

    val selected = devices.firstOrNull { it.id == selectedId } ?: devices.firstOrNull()

    // Auto-connect the last used terminal once, so opening the app resumes work
    // instead of showing a launcher. Only in two-pane mode: on a phone the user
    // must see the list first, and an automatic connection would hide it behind
    // a loading screen.
    var autoConnected by rememberSaveable { mutableStateOf(false) }
    if (!autoConnected && form.isTwoPane && selected != null && connection is ConnectionState.Idle) {
        autoConnected = true
        onTouchDevice(selected.id)
        manager.connect(selected)
    }

    if (form.isTwoPane) {
        TwoPaneLayout(
            manager = manager,
            devices = devices,
            selected = selected,
            connection = connection,
            showLog = showLog,
            onShowLog = { showLog = it },
            onSelect = { device ->
                selectedId = device.id
                onTouchDevice(device.id)
                manager.connect(device)
            },
            onAdd = { editorTarget = null; showEditor = true },
            onEdit = { editorTarget = it; showEditor = true },
            onReconnect = { selected?.let(manager::connect) },
            onThemeChange = onThemeChange,
            themeMode = settings?.themeMode ?: "system",
            onConnectionChanged = onConnectionChanged,
        )
    } else {
        OnePaneLayout(
            manager = manager,
            devices = devices,
            selected = selected,
            connection = connection,
            showLog = showLog,
            onShowLog = { showLog = it },
            onSelect = { device ->
                selectedId = device.id
                onTouchDevice(device.id)
                manager.connect(device)
            },
            onAdd = { editorTarget = null; showEditor = true },
            onEdit = { editorTarget = it; showEditor = true },
            onReconnect = { selected?.let(manager::connect) },
            onThemeChange = onThemeChange,
            themeMode = settings?.themeMode ?: "system",
            onConnectionChanged = onConnectionChanged,
        )
    }

    if (showEditor) {
        DeviceEditorSheet(
            device = editorTarget,
            authKeys = authKeys,
            onDismiss = { showEditor = false },
            onSave = { device ->
                onSaveDevice(device)
                selectedId = device.id
                showEditor = false
                manager.connect(device)
            },
            onDelete = { id -> onDeleteDevice(id); showEditor = false },
            onImportKey = onImportKey,
            onDeleteKey = onDeleteKey,
        )
    }
}

// ── two-pane (tablet landscape) ─────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TwoPaneLayout(
    manager: ConnectionManager,
    devices: List<Device>,
    selected: Device?,
    connection: ConnectionState,
    showLog: Boolean,
    onShowLog: (Boolean) -> Unit,
    onSelect: (Device) -> Unit,
    onAdd: () -> Unit,
    onEdit: (Device) -> Unit,
    onReconnect: () -> Unit,
    onThemeChange: (String) -> Unit,
    themeMode: String,
    onConnectionChanged: (Boolean) -> Unit,
) {
    val form = FormFactor.current()
    Row(Modifier.fillMaxSize()) {
        Surface(
            modifier = Modifier.width(form.railWidth).fillMaxHeight(),
            color = MaterialTheme.colorScheme.surface,
            tonalElevation = 1.dp,
        ) {
            Column(Modifier.fillMaxHeight()) {
                RailHeader(devices.size, onAdd)
                HorizontalDivider()
                LazyColumn(Modifier.weight(1f)) {
                    items(devices, key = { it.id }) { device ->
                        DeviceRailItem(
                            device = device,
                            selected = device.id == selected?.id,
                            status = if (device.id == selected?.id) connection else ConnectionState.Idle,
                            onClick = { onSelect(device) },
                            onEdit = { onEdit(device) },
                        )
                    }
                }
                HorizontalDivider()
                RailFooter(
                    showLog = showLog,
                    onShowLog = onShowLog,
                    onAdd = onAdd,
                    onReconnect = onReconnect,
                    reconnectEnabled = selected != null,
                    onThemeChange = onThemeChange,
                    themeMode = themeMode,
                )
            }
        }
        HorizontalDivider(
            modifier = Modifier.fillMaxHeight().width(1.dp),
            color = MaterialTheme.colorScheme.outline.copy(alpha = 0.4f),
        )
        Box(Modifier.weight(1f).fillMaxHeight()) {
            HarnessPane(
                manager = manager,
                selected = selected,
                connection = connection,
                showLog = showLog,
                onShowLog = onShowLog,
                onReconnect = onReconnect,
                onAdd = onAdd,
                onConnectionChanged = onConnectionChanged,
                maxWidth = form.contentMaxWidth,
                modifier = Modifier.fillMaxSize(),
            )
        }
    }
}

@Composable
private fun RailHeader(count: Int, onAdd: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 18.dp, bottom = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text("终端", style = MaterialTheme.typography.titleMedium)
            Text(
                if (count == 0) "还没有终端" else "$count 个终端",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        IconButton(onClick = onAdd) {
            Icon(Icons.Filled.Add, contentDescription = "新建终端")
        }
    }
}

@Composable
private fun DeviceRailItem(
    device: Device,
    selected: Boolean,
    status: ConnectionState,
    onClick: () -> Unit,
    onEdit: () -> Unit,
) {
    NavigationDrawerItem(
        selected = selected,
        onClick = onClick,
        label = {
            Column {
                Text(device.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    device.displayTarget(),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        },
        icon = { Icon(iconFor(device), contentDescription = null) },
        badge = { StatusDot(status) },
        modifier = Modifier.padding(horizontal = 8.dp),
    )
}

@Composable
private fun RailFooter(
    showLog: Boolean,
    onShowLog: (Boolean) -> Unit,
    onAdd: () -> Unit,
    onReconnect: () -> Unit,
    reconnectEnabled: Boolean,
    onThemeChange: (String) -> Unit,
    themeMode: String,
) {
    Column(Modifier.padding(8.dp)) {
        NavigationDrawerItem(
            selected = showLog,
            onClick = { onShowLog(!showLog) },
            label = { Text(if (showLog) "返回连接" else "日志") },
            icon = { Icon(if (showLog) Icons.Filled.Computer else Icons.Filled.Article, contentDescription = null) },
        )
        NavigationDrawerItem(
            selected = false,
            onClick = onAdd,
            label = { Text("新建终端") },
            icon = { Icon(Icons.Filled.Add, contentDescription = null) },
        )
        NavigationDrawerItem(
            selected = false,
            onClick = { if (reconnectEnabled) onReconnect() },
            label = { Text("重新连接") },
            icon = { Icon(Icons.Filled.Refresh, contentDescription = null) },
        )
        NavigationDrawerItem(
            selected = false,
            onClick = { onThemeChange(nextTheme(themeMode)) },
            label = { Text(themeLabel(themeMode)) },
            icon = { Icon(Icons.Filled.DarkMode, contentDescription = null) },
        )
    }
}

// ── one-pane (phone portrait) ───────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OnePaneLayout(
    manager: ConnectionManager,
    devices: List<Device>,
    selected: Device?,
    connection: ConnectionState,
    showLog: Boolean,
    onShowLog: (Boolean) -> Unit,
    onSelect: (Device) -> Unit,
    onAdd: () -> Unit,
    onEdit: (Device) -> Unit,
    onReconnect: () -> Unit,
    onThemeChange: (String) -> Unit,
    themeMode: String,
    onConnectionChanged: (Boolean) -> Unit,
) {
    // Which of the two phone routes is showing. A connection to a terminal is
    // what puts the user on the harness route; disconnecting returns to the list
    // so they are never stranded on an empty page.
    var route by rememberSaveable { mutableStateOf(if (connection is ConnectionState.Ready) Route.Harness else Route.Terminals) }
    if (connection is ConnectionState.Ready && route == Route.Terminals && devices.isNotEmpty()) {
        // Keep the user where they are; only auto-advance on an explicit select.
    }

    AnimatedContent(
        targetState = if (showLog) Route.Log else route,
        transitionSpec = { fadeIn(tween(160)) togetherWith fadeOut(tween(120)) },
        label = "phone-route",
    ) { current ->
        when (current) {
            Route.Log -> LogScreen(manager = manager, onBack = { onShowLog(false) })
            Route.Terminals -> TerminalsScreen(
                devices = devices,
                selected = selected,
                connection = connection,
                themeMode = themeMode,
                onSelect = { device ->
                    onSelect(device)
                    route = Route.Harness
                },
                onAdd = onAdd,
                onEdit = onEdit,
                onShowLog = { onShowLog(true) },
                onThemeChange = onThemeChange,
            )
            Route.Harness -> HarnessPane(
                manager = manager,
                selected = selected,
                connection = connection,
                showLog = false,
                onShowLog = onShowLog,
                onReconnect = onReconnect,
                onAdd = onAdd,
                onConnectionChanged = onConnectionChanged,
                maxWidth = FormFactor.current().contentMaxWidth,
                modifier = Modifier.fillMaxSize(),
                onBackToList = { route = Route.Terminals },
                topBar = {
                    PhoneHarnessTopBar(
                        device = selected,
                        connection = connection,
                        onBack = { route = Route.Terminals },
                        onReconnect = onReconnect,
                        onShowLog = { onShowLog(true) },
                    )
                },
            )
        }
    }
}

private enum class Route { Terminals, Harness, Log }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TerminalsScreen(
    devices: List<Device>,
    selected: Device?,
    connection: ConnectionState,
    themeMode: String,
    onSelect: (Device) -> Unit,
    onAdd: () -> Unit,
    onEdit: (Device) -> Unit,
    onShowLog: () -> Unit,
    onThemeChange: (String) -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("DeepSeek Harness", style = MaterialTheme.typography.titleMedium)
                        Text(
                            if (devices.isEmpty()) "选择一个终端开始" else "${devices.size} 个终端",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                actions = {
                    IconButton(onClick = { onThemeChange(nextTheme(themeMode)) }) {
                        Icon(
                            if (isDark(themeMode)) Icons.Filled.LightMode else Icons.Filled.DarkMode,
                            contentDescription = "切换主题",
                        )
                    }
                    IconButton(onClick = onShowLog) {
                        Icon(Icons.Filled.Article, contentDescription = "日志")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background,
                ),
            )
        },
        // The empty state already offers the action; showing both would put two
        // identical buttons on one screen.
        floatingActionButton = if (devices.isEmpty()) {
            {}
        } else {
            {
                androidx.compose.material3.ExtendedFloatingActionButton(
                    onClick = onAdd,
                    icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                    text = { Text("新建终端") },
                )
            }
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        if (devices.isEmpty()) {
            EmptyState(
                modifier = Modifier.fillMaxSize().padding(padding).padding(32.dp),
                onAdd = onAdd,
            )
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(
                    start = 16.dp, end = 16.dp, top = 8.dp, bottom = 96.dp,
                ),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(devices, key = { it.id }) { device ->
                    DeviceCard(
                        device = device,
                        selected = device.id == selected?.id,
                        status = if (device.id == selected?.id) connection else null,
                        onClick = { onSelect(device) },
                        onEdit = { onEdit(device) },
                    )
                }
            }
        }
    }
}

@Composable
private fun EmptyState(modifier: Modifier = Modifier, onAdd: () -> Unit) {
    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(
            Icons.Filled.Computer,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.height(56.dp),
        )
        Spacer(Modifier.height(16.dp))
        Text("还没有终端", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(8.dp))
        Text(
            "添加一台运行 DeepSeek Harness 的机器：用 SSH 连过去，客户端会自动复用或启动远端服务；也可以直接填一个能访问到的地址。",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
        Spacer(Modifier.height(20.dp))
        FilledTonalButton(onClick = onAdd) { Text("新建终端") }
    }
}

@Composable
private fun DeviceCard(
    device: Device,
    selected: Boolean,
    status: ConnectionState?,
    onClick: () -> Unit,
    onEdit: () -> Unit,
) {
    Card(
        onClick = onClick,
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (selected) MaterialTheme.colorScheme.primaryContainer
            else MaterialTheme.colorScheme.surface,
        ),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(iconFor(device), contentDescription = null, tint = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(device.name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(2.dp))
                Text(
                    device.displayTarget(),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (status != null && status !is ConnectionState.Idle) {
                    Spacer(Modifier.height(6.dp))
                    StatusLine(status)
                }
            }
            IconButton(onClick = onEdit) {
                Icon(Icons.Filled.Settings, contentDescription = "编辑")
            }
        }
    }
}

@Composable
private fun StatusLine(status: ConnectionState) {
    val text = when (status) {
        is ConnectionState.Connecting -> status.step
        is ConnectionState.Ready -> status.detail
        is ConnectionState.Failed -> "连接失败"
        ConnectionState.Stopped -> "已断开"
        ConnectionState.Idle -> ""
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        StatusDot(status)
        Spacer(Modifier.width(6.dp))
        Text(
            text,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun StatusDot(status: ConnectionState) {
    val color = when (status) {
        is ConnectionState.Ready -> androidx.compose.ui.graphics.Color(0xFF2E9E5B)
        is ConnectionState.Connecting -> MaterialTheme.colorScheme.primary
        is ConnectionState.Failed -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.outline
    }
    if (status is ConnectionState.Connecting) {
        CircularProgressIndicator(modifier = Modifier.height(12.dp).width(12.dp), strokeWidth = 2.dp, color = color)
    } else {
        Surface(color = color, shape = RoundedCornerShape(50), modifier = Modifier.height(8.dp).width(8.dp)) {}
    }
}

private fun iconFor(device: Device): ImageVector =
    if (device.mode == ConnectionMode.SSH) Icons.Filled.Cloud else Icons.Filled.Link

private fun isDark(mode: String): Boolean = mode == "dark"

private fun nextTheme(mode: String): String = when (mode) {
    "system" -> "dark"
    "dark" -> "light"
    else -> "system"
}

private fun themeLabel(mode: String): String = when (mode) {
    "light" -> "浅色主题"
    "dark" -> "深色主题"
    else -> "跟随系统"
}
