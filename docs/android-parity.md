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
| 4 | 复用判定：端口探活通过即复用，**version 不一致也复用**（见第 15 条） | `connectSsh` fast path | `connectSsh` 的 existing 分支 |
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
| 15 | **连接动作绝不重启别人正在用的 host**：只有「确认无人服务」才清理+重建；version 不一致只提示、照连 | `connectLocal`/`connectSsh` 的复用快路径 | `connectSsh` 的 existing 分支 |
| 16 | **清理之前先证明「我能起得来」**：node 不可用时直接报错，一个进程都不清 | 不适用（本地模式用 `tools.js` 解析，缺失时连接前即失败） | `RemoteService.checkToolchain()` |

> 第 16 条来自 2026-11 的真机事故。机制要说准，因为修法依赖它：
>
> **不是"zsh 不读 .zshrc"那么简单。** macOS 上用户登录 shell 是 zsh（`dscl . -read
> /Users/<u> UserShell` 可见），但 zsh 的启动文件分四档：
> `.zshenv`（总是读）→ `.zprofile`（登录读）→ `.zshrc`（**交互**才读）→ `.zlogin`。
> 而 `ssh host '<cmd>'` 起的是**非交互登录** shell：读 `.zshenv` 与 `.zprofile`，
> **跳过 `.zshrc`**。本机的 nvm 初始化写在 `~/.zshrc`，所以同一个 `zsh`，
> `zsh -i -l` 能找到 node，`zsh -l` 找不到（实测：前者返回
> `~/.nvm/versions/node/v24.22.1/bin/node`，后者 `NO-NODE`）。
>
> 另外 macOS **没有 `getent`**，`REMOTE_LOGIN_SHELL_PROBE` 会回退到 `$SHELL`，
> 而 sshd 注入的 `$SHELL` 与实际登录 shell 未必一致——本机实测探测结果就是
> `/bin/bash`，而真实登录 shell 是 `/bin/zsh`。这条回退路径本身没错（两端都写的是
> `getent → $SHELL → 固定列表`），但它意味着"探测到的 shell"不能作为
> "PATH 会被正确初始化"的保证。
>
> 于是 `exec node` 报 `node: not found`，服务起不来。而旧顺序是「先全清、再启动」——
> 清完之后启动失败，整个 home 一个 host 都不剩，桌面窗口直接掉线，日志里只看到
> 「清理残留远端 dsh web」。现在启动前先 `command -v node`，失败就报错并给出
> 设置 node 绝对路径 / 改用「只建隧道」的补救办法；同时 `toolchainPrefix()` 补上
> nvm（动态取最新版本目录）、volta、homebrew 与 `/usr/local/bin`，让 macOS 主机
> 不必改 shell profile 也能被连上。

> 第 15 条是 2026-11 的回归修复：此前发现版本与本机运行时不同，就直接落到
> `reapHosts(keepPid = 0)` 再拉起新 host。新 host = 新端口 + 新 launch token，
> 于是**手机一连上本机，桌面窗口就掉到错误页/白屏**（用户报的“连接后本地窗口关闭”）。
> 现行规则：一个 dsh home 仍然只允许一个 host（两个会争 session store 与
> task-board ledger），但**只有「确实没有任何 host 应答」或用户显式点更新/回滚/重置时
> 才允许换掉它**。版本号从“复用门槛”降级为“展示 + 更新决策依据”；Android 端
> 不提供更新入口，因此永远不主动重启 host。
>
> 版本不一致时的日志措辞也定了：`提示：该服务版本 X 与本机运行时 Y 不一致，直接复用、不重启。`
> 令牌失效（单跳 401/403）同样**不再重启**，改用裸地址并在日志里说明——让已连接的
> 其他客户端继续可用，比给本端换一张新票据更重要。

> 第 6、7、8 条是 2026-10 修复「两个客户端同时连同一个远程会留下两个 host」时
> 补齐的：桌面端原本就有 6/7，Android 缺；第 8 条两端都缺，一起补。
> 第 15 条是 2026-11 修复「客户端一连接就重启别人的 host」时补的。

## 2. 有意不同的地方

| 方面 | 桌面 | Android | 原因 |
|---|---|---|---|
| 本地模式 | 有（壳自己起 `dsh web`） | **无** | 手机上跑不了 harness 运行时；只能连远程或直接地址 |
| 进程生命周期 | 壳退出**杀**自管子进程（`before-quit`） | 前台服务持有连接，退出即断 | 桌面是常驻托盘应用；手机由系统管进程 |
| 布局 | 多窗口 + 46px 壳边框 | 单 Activity：手机单栏路由 / 平板双栏 | 屏幕与输入方式不同 |
| 平台进程管理 | POSIX 进程组 / Windows 进程树 | 不适用 | Android 没有子进程模型 |
| 更新 | 完整产物升级管线 | 无 | 客户端自身由用户更新 |
| 版本号 | `package.json#version` | `versionName` 读同一个 `package.json`（`versionCode` 由它推导） | 见 §3「版本号漂移」 |

## 3. 已知的、仍不一致的点

| 现象 | 桌面 | Android | 处理 |
|---|---|---|---|
| 全清路径的扫描不可用 | 只**提示**（`reapRemoteHosts` 仍按记录 pid 兜底） | 同样只提示（`sweepHosts(0)` 报告 note） | 一致 |
| 直接 URL 模式的诊断 | 不适用（无此模式） | 区分「有响应但不是 dsh」/「端口无响应」 | Android 特有 |
| 旋转/尺寸变化是否重载页面 | 不适用（窗口缩放不重建 WebContentsView） | `movableContentOf` 保持同一 WebView | Android 特有 |
| 版本不一致时谁去升级 | 用户显式「更新 → 更新并重启」/「回滚」 | 无入口，只提示 | 有意不同（第 15 条） |
| 版本号漂移 | —— | —— | **已修**：`versionName` 曾硬编码 `0.1.0`，下载的是 `0.10.13` 却显示 0.1.0。现在两者同源，release 工作流用 `aapt2 dump badging` 断言 APK 内版本等于 `package.json` |

## 4. 改动时的检查清单

改远端协议相关代码时，**两端都要过一遍**：

1. 命令字符串是否需要哨兵包裹？（新增远端命令必须走 `remoteRun` / `RemoteShell.run`）
2. 命令体里有没有单引号？（外层已整条单引号包裹）
3. 是否依赖 word splitting？（远端 zsh 不分词，必须 `while read`）
4. 写入文件是否带结尾换行？（哨兵按行解析）
5. 这条路径会不会杀掉别人正在用的服务？（`keepPid` 语义）
6. 扫描失败时，用户能看到原因吗？
7. 这个决定是不是「连接动作」，而它会导致 host 重启吗？（第 15 条：连接只许复用，
   重启只许发生在「无人服务」或用户显式操作时。版本比较不能作为重启理由。）
8. `npm run smoke` 与 `./gradlew :app:assembleDebug` 都要过。
