package com.deepseek.harness.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.deepseek.harness.android.connection.ConnectionManager
import com.deepseek.harness.android.connection.LogLine
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The connection log.
 *
 * It is not decoration: on a phone there is no terminal to inspect, so this is
 * the only place a failing SSH handshake, a missing runtime, or a service that
 * refused to announce a port can be diagnosed at all. Lines are selectable so
 * they can be pasted into an issue.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LogScreen(manager: ConnectionManager, onBack: () -> Unit) {
    var lines by remember { mutableStateOf<List<LogLine>>(emptyList()) }
    val listState = rememberLazyListState()

    LaunchedEffect(Unit) {
        // Poll rather than observe: the ring buffer is a plain synchronized list
        // shared with worker threads, and a 1s refresh is plenty for a log.
        while (true) {
            val snapshot = manager.log.snapshot()
            if (snapshot.size != lines.size) {
                lines = snapshot
                if (snapshot.isNotEmpty()) listState.animateScrollToItem(snapshot.lastIndex)
            }
            kotlinx.coroutines.delay(700)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
                title = { Text("连接日志", style = MaterialTheme.typography.titleMedium) },
                actions = {
                    TextButton(onClick = { manager.log.clear(); lines = emptyList() }) { Text("清空") }
                },
            )
        },
    ) { padding ->
        if (lines.isEmpty()) {
            Column(Modifier.fillMaxSize().padding(padding).padding(24.dp)) {
                Text("还没有日志。连接一个终端后，这里会显示每一步的过程。", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                items(lines) { line ->
                    SelectionContainer {
                        Column(Modifier.fillMaxWidth()) {
                            Text(
                                time(line.at),
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(
                                line.text,
                                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                            )
                            HorizontalDivider(Modifier.padding(top = 6.dp), color = MaterialTheme.colorScheme.outline.copy(alpha = 0.2f))
                        }
                    }
                }
            }
        }
    }
}

private fun time(at: Long): String = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(at))
