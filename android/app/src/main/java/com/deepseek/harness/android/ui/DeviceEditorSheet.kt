package com.deepseek.harness.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.deepseek.harness.android.data.AuthKey
import com.deepseek.harness.android.data.ConnectionMode
import com.deepseek.harness.android.data.Device
import kotlinx.coroutines.launch

/**
 * Add or edit a terminal.
 *
 * Two fields carry unusual weight:
 *
 * - **Remote dsh home** defaults to blank, which means `$HOME/.dsh`. It is
 *   exposed because a shared build box often keeps the harness under a
 *   per-user home, and guessing wrong would adopt — or kill — somebody else's
 *   service.
 * - **Manage the service** is the difference between "this client starts and
 *   stops `dsh web` for me" and "somebody else owns the service and I only want
 *   a tunnel". Unticking it makes every lifecycle step read-only, which is the
 *   safe choice on a production host.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DeviceEditorSheet(
    device: Device?,
    authKeys: List<AuthKey>,
    onDismiss: () -> Unit,
    onSave: (Device) -> Unit,
    onDelete: (String) -> Unit,
    onImportKey: suspend (String, String, String?) -> AuthKey,
    onDeleteKey: (String) -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()

    var name by remember { mutableStateOf(device?.name ?: "") }
    var mode by remember { mutableStateOf(device?.mode ?: ConnectionMode.SSH) }
    var host by remember { mutableStateOf(device?.host ?: "") }
    var port by remember { mutableStateOf((device?.port ?: 22).toString()) }
    var user by remember { mutableStateOf(device?.user ?: "") }
    var remoteHome by remember { mutableStateOf(device?.remoteDshHome ?: "") }
    var manageService by remember { mutableStateOf(device?.manageService ?: true) }
    var url by remember { mutableStateOf(device?.url ?: "") }
    var keyId by remember { mutableStateOf(device?.authKeyId ?: authKeys.firstOrNull()?.id) }
    var showKeyImport by remember { mutableStateOf(false) }

    val keyMenuOpen = remember { mutableStateOf(false) }

    val valid = when (mode) {
        ConnectionMode.SSH -> host.isNotBlank() && (port.toIntOrNull() ?: 0) in 1..65535
        ConnectionMode.URL -> url.isNotBlank() && (url.startsWith("http://") || url.startsWith("https://"))
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            Modifier
                .fillMaxWidth()
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp),
        ) {
            Text(
                if (device == null) "新建终端" else "编辑终端",
                style = MaterialTheme.typography.titleLarge,
            )
            Spacer(Modifier.height(16.dp))

            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                SegmentedButton(
                    selected = mode == ConnectionMode.SSH,
                    onClick = { mode = ConnectionMode.SSH },
                    shape = SegmentedButtonDefaults.itemShape(index = 0, count = 2),
                ) { Text("SSH 远程") }
                SegmentedButton(
                    selected = mode == ConnectionMode.URL,
                    onClick = { mode = ConnectionMode.URL },
                    shape = SegmentedButtonDefaults.itemShape(index = 1, count = 2),
                ) { Text("直接地址") }
            }
            Spacer(Modifier.height(16.dp))

            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text("名称") },
                placeholder = { Text(if (mode == ConnectionMode.SSH) "家里的服务器" else "公司网关") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(12.dp))

            if (mode == ConnectionMode.SSH) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedTextField(
                        value = host,
                        onValueChange = { host = it },
                        label = { Text("主机") },
                        placeholder = { Text("192.168.1.10") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    OutlinedTextField(
                        value = port,
                        onValueChange = { input -> port = input.filter { it.isDigit() } },
                        label = { Text("端口") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.padding(top = 0.dp).widthIn(),
                    )
                }
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = user,
                    onValueChange = { user = it },
                    label = { Text("用户名") },
                    placeholder = { Text("root") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(12.dp))

                Box(Modifier.fillMaxWidth()) {
                    OutlinedTextField(
                        value = authKeys.firstOrNull { it.id == keyId }?.name ?: "未选择密钥",
                        onValueChange = {},
                        readOnly = true,
                        label = { Text("SSH 私钥") },
                        trailingIcon = {
                            IconButton(onClick = { keyMenuOpen.value = !keyMenuOpen.value }) {
                                Icon(Icons.Filled.ArrowDropDown, contentDescription = "选择密钥")
                            }
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { keyMenuOpen.value = true },
                    )
                    DropdownMenu(
                        expanded = keyMenuOpen.value,
                        onDismissRequest = { keyMenuOpen.value = false },
                    ) {
                        authKeys.forEach { key ->
                            DropdownMenuItem(
                                text = { Text(key.name + if (key.hasPassphrase) "（有口令）" else "") },
                                onClick = {
                                    keyId = key.id
                                    keyMenuOpen.value = false
                                },
                            )
                        }
                        HorizontalDivider()
                        DropdownMenuItem(
                            text = { Text("导入新密钥…") },
                            leadingIcon = { Icon(Icons.Filled.Add, contentDescription = null) },
                            onClick = {
                                keyMenuOpen.value = false
                                showKeyImport = true
                            },
                        )
                        if (keyId != null) {
                            DropdownMenuItem(
                                text = { Text("删除当前密钥") },
                                leadingIcon = { Icon(Icons.Filled.Delete, contentDescription = null) },
                                onClick = {
                                    keyId?.let(onDeleteKey)
                                    keyId = null
                                    keyMenuOpen.value = false
                                },
                            )
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))

                OutlinedTextField(
                    value = remoteHome,
                    onValueChange = { remoteHome = it },
                    label = { Text("远端 dsh home（可留空）") },
                    placeholder = { Text("留空 = \$HOME/.dsh") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    "留空即可。仅在远端使用自定义 home 时才需要填写。",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(8.dp))

                Row(
                    Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("托管远端服务", style = MaterialTheme.typography.bodyLarge)
                        Text(
                            "关闭后只建立隧道，不启动或清理远端 dsh web。",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(checked = manageService, onCheckedChange = { manageService = it })
                }
            } else {
                OutlinedTextField(
                    value = url,
                    onValueChange = { url = it },
                    label = { Text("Dsh 地址") },
                    placeholder = { Text("https://harness.example.com/") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    "直接填写能够访问到 DeepSeek Harness 的完整地址；本模式不建立 SSH 隧道。",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Spacer(Modifier.height(24.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                if (device != null) {
                    OutlinedButton(
                        onClick = { onDelete(device.id) },
                        modifier = Modifier.weight(1f),
                    ) { Text("删除") }
                }
                TextButton(onClick = onDismiss, modifier = Modifier.weight(1f)) { Text("取消") }
                Button(
                    enabled = valid,
                    onClick = {
                        onSave(
                            (device ?: Device(name = "", mode = mode)).copy(
                                name = name.ifBlank { host.ifBlank { url } },
                                mode = mode,
                                host = host.trim(),
                                port = port.toIntOrNull() ?: 22,
                                user = user.trim(),
                                remoteDshHome = remoteHome.trim(),
                                manageService = manageService,
                                url = url.trim(),
                                authKeyId = keyId,
                            )
                        )
                    },
                    modifier = Modifier.weight(1f),
                ) { Text("保存并连接") }
            }
        }
    }

    if (showKeyImport) {
        KeyImportDialog(
            onDismiss = { showKeyImport = false },
            onImport = { keyName, pem, pass ->
                scope.launch {
                    val key = onImportKey(keyName, pem, pass)
                    keyId = key.id
                    showKeyImport = false
                }
            },
        )
    }
}

/**
 * Paste an OpenSSH private key.
 *
 * The key is written straight to app-private storage and never shown again, so
 * the dialog only asks for the material, a display name, and an optional
 * passphrase.
 */
@Composable
private fun KeyImportDialog(
    onDismiss: () -> Unit,
    onImport: (String, String, String?) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var pem by remember { mutableStateOf("") }
    var passphrase by remember { mutableStateOf("") }
    val looksLikeKey = pem.contains("PRIVATE KEY")

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("导入 SSH 私钥") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("名称") },
                    placeholder = { Text("home-server") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = pem,
                    onValueChange = { pem = it },
                    label = { Text("私钥内容") },
                    placeholder = { Text("-----BEGIN OPENSSH PRIVATE KEY-----") },
                    minLines = 4,
                    maxLines = 8,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = passphrase,
                    onValueChange = { passphrase = it },
                    label = { Text("口令（可留空）") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    "私钥只保存在本机应用私有目录，不会上传。",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = looksLikeKey && name.isNotBlank(),
                onClick = { onImport(name.trim(), pem.trim(), passphrase.ifBlank { null }) },
            ) { Text("导入") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

private fun Modifier.widthIn() = this.then(Modifier)
