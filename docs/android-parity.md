# 三端一致性（macOS / Windows / Linux · Android）

> 同一套**远端协议**，三个客户端。本文档只记录「三者必须一致的行为」与「有意不同
> 的地方」，避免下次改动时把一个端的修复漏到另一个端。
>
> 代码归属：桌面三平台共用 `src/`（Electron）；Android 是 `android/`（Kotlin）。
> 平台差异（进程组 vs 进程树、路径、窗口 chrome）不在此列，见 [architecture.md](architecture.md)。

## 1. 必须一致的核心行为

| # | 行为 | 桌面（`src/connection.js`） | Android（`connection/ConnectionManager.kt`、`ssh/RemoteService.kt`） |
|---|---|---|---|
| 1 | 登录 shell 探测：`getent passwd` 第 7 列 → `$SHELL` → 固定列表 | `REMOTE_LOGIN_SHELL_PROBE` | `RemoteShell.probeLoginShell()` |
| 2 | 远端命令用**哨兵包裹**，只取载荷 | `remoteRun` + `extractPayload` | `RemoteShell.run` + `Payload.extract` |
| 3 | state 文件 `{pid,port,version,url}`，写入**必须带结尾换行** | `runtimeStore.writeRemoteState` | `RemoteService.writeState` |
| 4 | 复用判定：version 相等 **且** 端口探活通过 | `connectSsh` fast path | `connectSsh` 的 existing 分支 |
| 5 | 令牌失效（单跳 401/403）→ 重启换新令牌 | `tokenAccepted` | `HttpProbe.tokenAccepted` |
| 6 | **启动前等对端**（6×1s），有人先建好就跟随 | `awaitPeerService` | `RemoteService.awaitPeerService` |
| 7 | 健康连接后**清理多余 host**（state 里的 pid 除外） | `reapStrayRemoteHosts` | `ConnectionManager.reapStrays` |
| 8 | 清理前**确认扫描可用**，不可用要**说出来** | `parseRemoteHostScan` → `psAvailable` | `RemoteService.sweepScript` → `SweepResult.scanAvailable` |
| 9 | 全清路径（`keepPid=0`）只用于「确认无人服务、准备重启」 | `reapRemoteHosts` | `sweepHosts(keepPid = 0)` |
| 10 | 清理范围限定**本 home**（`usesHome`），绝不误杀他人 | `reapLocalHosts`/`reapRemoteHosts` | `sweepScript` 的 `lsof … ^n$HOME/.dsh/` |
| 11 | 只杀命令以 `node` 开头的进程（不杀 `bash -c` 包装器） | `REMOTE_HOST_SCAN` 的 grep | `remote_sweep.sh` 的 grep |
| 12 | 本地端口转发由 JSch/ssh 自己分配并回报 | `ports.findFreePort` + `ssh -L` | `setPortForwardingL(host, 0, …)` |
| 13 | 就绪后健康看门狗，连续失败自动重连 | `HEALTH_INTERVAL_MS`/`THRESHOLD` | 同左（4s / 2 次） |
| 14 | 只加载回环转发地址，其余 URL 交系统浏览器 | `external-open.js` | `HarnessWebView.handleUrl` |

> 第 6、7、8 条是 2026-10 修复「两个客户端同时连同一个远程会留下两个 host」时
> 补齐的：桌面端原本就有 6/7，Android 缺；第 8 条两端都缺，一起补。

## 2. 有意不同的地方

| 方面 | 桌面 | Android | 原因 |
|---|---|---|---|
| 本地模式 | 有（壳自己起 `dsh web`） | **无** | 手机上跑不了 harness 运行时；只能连远程或直接地址 |
| 进程生命周期 | 壳退出**杀**自管子进程（`before-quit`） | 前台服务持有连接，退出即断 | 桌面是常驻托盘应用；手机由系统管进程 |
| 布局 | 多窗口 + 46px 壳边框 | 单 Activity：手机单栏路由 / 平板双栏 | 屏幕与输入方式不同 |
| 平台进程管理 | POSIX 进程组 / Windows 进程树 | 不适用 | Android 没有子进程模型 |
| 更新 | 完整产物升级管线 | 无 | 客户端自身由用户更新 |

## 3. 已知的、仍不一致的点

| 现象 | 桌面 | Android | 处理 |
|---|---|---|---|
| 全清路径的扫描不可用 | 只**提示**（`reapRemoteHosts` 仍按记录 pid 兜底） | 同样只提示（`sweepHosts(0)` 报告 note） | 一致 |
| 直接 URL 模式的诊断 | 不适用（无此模式） | 区分「有响应但不是 dsh」/「端口无响应」 | Android 特有 |
| 旋转/尺寸变化是否重载页面 | 不适用（窗口缩放不重建 WebContentsView） | `movableContentOf` 保持同一 WebView | Android 特有 |

## 4. 改动时的检查清单

改远端协议相关代码时，**两端都要过一遍**：

1. 命令字符串是否需要哨兵包裹？（新增远端命令必须走 `remoteRun` / `RemoteShell.run`）
2. 命令体里有没有单引号？（外层已整条单引号包裹）
3. 是否依赖 word splitting？（远端 zsh 不分词，必须 `while read`）
4. 写入文件是否带结尾换行？（哨兵按行解析）
5. 这条路径会不会杀掉别人正在用的服务？（`keepPid` 语义）
6. 扫描失败时，用户能看到原因吗？
7. `npm run smoke` 与 `./gradlew :app:assembleDebug` 都要过。
