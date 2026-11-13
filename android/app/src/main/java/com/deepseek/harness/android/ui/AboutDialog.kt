package com.deepseek.harness.android.ui

import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.deepseek.harness.android.BuildConfig

/**
 * 关于: this client's own build identity.
 *
 * `BuildConfig.VERSION_NAME` is read from the same package.json as the desktop
 * shell (see app/build.gradle.kts), so the number here matches the release page
 * and the desktop 设置 → 关于. The WebView row is included because it is the one
 * device property that decides whether the harness page can render at all.
 *
 * Deliberately no "check for updates": the Android client has no update
 * pipeline and is updated by the user (docs/android-parity.md).
 */
@Composable
fun AboutDialog(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val webView = remember { WebViewSupport.check(context) }
    val rows = remember(webView) {
        listOf(
            "应用" to "DeepSeek Harness",
            "版本" to "v${BuildConfig.VERSION_NAME}（${BuildConfig.VERSION_CODE}）",
            "系统" to "Android ${Build.VERSION.RELEASE}（API ${Build.VERSION.SDK_INT}）",
            "设备" to "${Build.MANUFACTURER} ${Build.MODEL}",
            "WebView" to when {
                webView.majorVersion <= 0 -> "不可用"
                webView.supported -> "${webView.majorVersion}"
                else -> "${webView.majorVersion}（低于 ${WebViewSupport.MIN_MAJOR}，需更新）"
            },
            "项目主页" to "github.com/svengong/dsh-mac-desktop",
        )
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("关于") },
        text = {
            SelectionContainer {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    rows.forEach { (label, value) ->
                        Row(Modifier.fillMaxWidth()) {
                            Text(
                                label,
                                modifier = Modifier.width(72.dp),
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(
                                value,
                                style = MaterialTheme.typography.bodyMedium,
                                fontFamily = FontFamily.Monospace,
                            )
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
        dismissButton = {
            TextButton(onClick = {
                clipboard.setText(AnnotatedString(rows.joinToString("\n") { (k, v) -> "$k：$v" }))
            }) { Text("复制") }
        },
    )
}
