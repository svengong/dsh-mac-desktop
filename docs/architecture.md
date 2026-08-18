# 架构与技术细节

本文档承载桌面壳的技术内容：目录布局、模块职责、端口与进程策略、工具链、数据隔离、更新架构、打包发布。产品介绍与快速开始见 [README](../README.md)。

## 1. 设计契约（升级不改壳）

壳只依赖三个稳定产品面：

1. 固定 URL `http://127.0.0.1:<端口>`（Web 应用的服务契约），
2. 仓库入口 `apps/cli/lib/bin.js web --port <n>`（已构建的 CLI 入口），
3. git + pnpm 工具链。

前端产物、插件组合、预设如何变化都不影响壳。壳自身没有运行时自动更新；壳发版走 `scripts/release.js` + GitHub Actions 发布流程（tag `v*` → 双架构构建 → Release）。

## 2. 目录与模块

```
desktop-shell/
├── deepseek-harness/    本地 harness 检出（独立 clone，默认 repoDir，gitignored）
├── src/
│   ├── main.js            main process: lifecycle, workspace frame wiring, IPC handlers
│   ├── settings.js        settings store (userData/settings.json)
│   ├── window-manager.js  window bounds/active-view/last-active persistence
│   ├── runtime-store.js   local/remote service state, URL/port parsing, clone/build locks
│   ├── runtime-layout.js  repo/npm 两种运行时布局解析（bin 查找唯一入口）
│   ├── artifact.js        官方 npm 产物渠道：registry 预检/安装/校验
│   ├── update-worker.js   独立更新执行器（壳退出后继续完成安装）
│   ├── ports.js           SSH local-forward port reservation + TCP probe
│   ├── labels.js          shared DSH-[终端] labels for titles/menus/tray
│   ├── shell-preload.js   preload for the local workspace frame
│   ├── dialogs.js         embedded settings panel
│   ├── components.js      update-component catalog + version/hash helpers
│   ├── update-manager.js  unified check/update logic for all components
│   ├── connection.js      local + ssh connection lifecycle, port-0 service, tunnel, remote service
│   ├── update.js          harness check / update-and-restart pipeline, .dsh-tools pnpm bootstrap
│   ├── runner.js          foreground command runner + detached service spawner + 进程登记表
│   ├── ssh.js             ssh target parsing, quoting, remote-path rendering
│   ├── tools.js           engine-aware node/pnpm discovery + clean child environment
│   └── ui/                shell.html (workspace frame + loading panel), settings.html, shell.css
│
├── build/                 icon.icns, icon.png, iconPressed.png, tray template icons (committed)
└── scripts/               gen-icons.sh, build.sh, install.sh, smoke.js, e2e-local.js, e2e-ssh.js
```

本目录独立于 harness 仓库，保留自己的 npm install，产品依赖图不受影响。

## 3. 数据流与多窗口模型

```text
BrowserWindow (shell.html 边框)
 ├─ harness WebContentsView        ← http://127.0.0.1:<实际端口>
 └─ settings WebContentsView       ← dialog:* / updates:* IPC
        │
        └─ main.js: workspace ── session ── ConnectionManager
                                            ├─ local service (node bin.js web --port 0)
                                            ├─ ssh tunnel (ssh -N -L)
                                            └─ UpdateManager / Updater
```

- `workspaces`：`Map<id, workspace>`，一个 BrowserWindow 一个 workspace。
- `sessions`：`Map<deviceKey, session>`，`deviceKey` 为 `local`、`ssh:<host>` 或归一后的 `machine:<id>`。
- 同设备窗口共享 session；窗口关闭只是隐藏，workspace 持续存活，显式退出时才销毁。
- 窗口切换设备调用 `attachWorkspace`；`local` session 常驻以支持多开。

## 4. 端口与进程策略

1. 本地和远端 `dsh web` 统一使用 `--port 0`；CLI 打印 `dsh web: http://127.0.0.1:<port>`，壳解析后写 state，窗口跟随实际端口。
2. SSH 本地转发不能由 ssh 汇报端口，使用**优先端口 + 顺延 30**：`localPort` 空闲则用，否则 `ports.js` 探测下一个空闲端口；探测→绑定窗口用 `reservePort/releasePort` 括起来。
3. 所有子进程 spawn 都经 `runner.js`：`runCommand`（有界前台命令，`detached: true` 独立进程组，超时组杀 SIGKILL）、`spawnService`（长驻服务，组 SIGTERM 停止）、`spawnDetached`（更新 worker，不注册登记表，壳退出不杀）。
4. **进程登记表**：每个 spawn 自动登记，`before-quit` 调 `killActiveChildren()` 组杀全部——包括在途 git/pnpm 构建与插件安装。
5. 本地 clone、远端 clone、build pipeline 都通过 `runtime-store.js` 的原子目录锁；本地锁 owner 为 `{pid, host, createdAt}`，owner 进程消失即 stale；远端锁 owner JSON 超 2 小时视为 stale。
6. 旧版/残留自管服务通过 `<dshHome>/desktop-web.state.json`（远端 `~/.dsh/desktop-web.state.json`）按 `{pid, port, version}` 回收；版本一致且仍响应 `__DSH_BOOT__` 时复用。

## 5. 连接生命周期与驻留程序自动升级

`connect()` 重置本地引用、杀旧子进程、释放旧预留，然后 `connectLocal/connectSsh`。失败触发 `connect-failed`，main 最多自动重试 2 次（10s/20s）。

**连接时自动升级（reap → launch）**：连接对比 state 记录的 version 与当前 `serviceVersion`。不匹配 → 自动清理旧驻留程序（kill 记录 pid / lsof 兜底）→ 以当前版本重新启动。版本身份：runtime `current` 优先；无 runtime 时 clean 工作区用 git HEAD，**dirty 工作区用已构建 bin 的 mtime**，npm 布局用包版本；所有 token 统一经 `versionToken`。

**两层升级语义**：连接只负责「升级到 current」；「获取新版本」走更新管线（git pull → staging build → 原子切换 → 重启）。runtime 化后 source HEAD 变化不触发连接升级，这是设计行为。

**远端恢复**：state 匹配但服务已死（崩溃/远端重启）时，锁内探活（node fetch + `__DSH_BOOT__`）→ 自动 reap + relaunch，不会建隧道到死端口空等。

## 6. 更新架构（产物优先 + 可恢复 + 生命周期解耦）

1. **官方产物优先**：`artifact.js` 先做 registry 预检（最新版本 + 依赖链完整性），可用时 `npm install --prefix` 装进 `runtime/<version>`（npm 布局），校验后原子切换 `current`；源码构建（git worktree staging）是 fork/离线场景的 fallback。
2. **detached worker 执行**：菜单「更新并重启」与初始化在本地产物可用时由 `update-worker.js` 独立进程执行（`spawnDetached`，壳退出不杀）。壳轮询 `runtime/update-status.json` 推送阶段/日志；`done` 后由壳重启服务（或下次连接按版本不匹配自动重启）。
3. **意图可恢复**：更新前写 `update-pending.json`，正常结束才清除；启动时 `resumePendingUpdate()` 检测残留——worker 还在跑则接管观察，已完成则提示，被打断则询问「继续/放弃」后重跑。
4. **版本化运行时与回滚**：构建在 `<dshHome>/runtime/<version>`（远端 `~/.dsh/runtime/<version>`）staging，成功后原子切换 `current`；新版本启动失败自动回滚 `previous`，更新菜单可手动「回滚 Harness」。

## 7. 数据与进程隔离

- 开发态（`app.isPackaged === false`）userData 固定为 `~/.dsh-dev`（不存在时自动创建），不触碰已安装应用的 `~/Library/Application Support/DeepSeek Harness`；`DSH_DESKTOP_USER_DATA` 可覆盖。
- 本地服务 `DSH_HOME` 默认 `~/.dsh-dev`（或设置里的 dshHome），与终端用户常用 `~/.dsh` 完全分离；首次使用时从 `~/.dsh` 播种 settings/凭据。
- 已安装应用与开发应用使用不同的单实例锁，允许同时运行。
- 本地子进程 `PATH = node 目录 + .dsh-tools + 仓库 node_modules/.bin + 系统基础目录`，与登录环境无关；远程在 `~/.dsh-tools` 做同样的自包含引导。

## 8. 打包与发布

- 产物命名遵循 GitHub Release 约定 `<name>-<version>-<os>-<arch>.<ext>`：`dsh-mac-desktop-0.1.1-macos-arm64.dmg`（`package.json#build.artifactName`）。版本号唯一来源 `package.json#version`。
- `npm run dist`（app 目录）/ `npm run dist:dmg`（DMG+ZIP）/ `npm run dist:publish`（`GH_TOKEN=<token>` 直发 GitHub）。
- 推送 `v*` 标签触发 `.github/workflows/release.yml`：校验标签与版本一致 → 双架构（arm64/x64）构建（`--publish never`，发布交给 action-gh-release）→ 上传 DMG/ZIP/latest-mac.yml → 创建 GitHub Release。
- 产物未签名/未公证（`identity: null`）。

## 9. 相关文档

- [需求文档](requirements.md)：功能需求、边缘场景、验收标准。
- [开发文档](development.md)：开发约定、测试、提交约定、新版本发布验证。
- [Agent 文档](agent.md)：后续编码 Agent 的不变量、速查与常见坑。
