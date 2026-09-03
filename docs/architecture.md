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
│   ├── dialog-preload.js  preload for the embedded settings panel
│   ├── external-open.js   URL classification for harness navigation (main/sub frame)
│   ├── menu.js            application menu
│   ├── tray.js            menu-bar tray (status + terminal actions)
│   ├── windows.js         window presentation helpers
│   ├── device-merge.js    merges one device's settings/update state
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
└── scripts/               gen-icons.sh, build.sh, install.sh, smoke.js, release.js
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

- `workspaces`：`Map<id, workspace>`，一个 BrowserWindow 一个 workspace。窗口可以是未绑定（detached，不持有 session）或已绑定某终端。
- `sessions`：`Map<deviceKey, session>`，`deviceKey` 为 `local`、`ssh:<host>` 或归一后的 `machine:<id>`。
- 同设备窗口共享 session；窗口关闭只是隐藏，workspace 持续存活，显式退出时才销毁。
- 启动/恢复的第一个窗口绑定上次活跃设备并自动连接；显式新建窗口为 detached，默认连接页。每个终端最多一个已绑定窗口；保存已打开终端时仅聚焦已有窗口，当前窗口保持不变。
- 任务进度横幅存在 session 上（`session.progress`），同终端所有已绑定窗口共享；`sessionTask` 给壳工具栏提供检查/更新/构建/重启状态。切离窗口时通过 runner owner 取消该终端任务，释放锁后再停 session。
- 窗口切换设备调用 `attachWorkspace`；`local` session 常驻以支持多开。

### 3.1 harness 视图的导航护栏（`external-open.js` + `main.js`）

壳只在 harness 视图内渲染**一个**页面：服务根 `http://127.0.0.1:<port>/`。导航护栏分主/子框架两套规则（`installHarnessNavigationGuard`）：

- **主框架**（`will-navigate`，用 `isExternalUrl`）：只保留根路径（harness 是 hash 路由，真实应用路由的 `pathname` 恒为 `/`）；其他 loopback 路径、`https:`、`file:` 一律交系统默认浏览器。点 workspace `.html` 就是走这条——服务对这些路径回 404 空页，若不拦会得到一张无法自愈的空白 harness 视图。
- **子框架**（`will-frame-navigate`，用 `isExternalSubFrameUrl`）：子框架属于嵌入它的插件（如 sidebar 文件预览），壳只驱逐真正跨源内容（非 loopback、`file:`），其余让插件自行路由。把主框架规则套到子框架上会劫持插件 UI——预览点击被顶到系统浏览器。

两个关键状态机细节（实测于 Electron 35）：

- 被 `preventDefault()` 的导航不会发出 `did-finish-load`，所以 `harnessReady` 不会自动恢复；`will-navigate` 里必须调 `restoreHarnessAfterBlockedNav()` 从快照恢复。
- `did-start-loading` 对**任意框架**都触发，包括 iframe；只有主框架的 `did-start-navigation`（`isMainFrame`）才代表 harness 文档被替换。在 `did-start-loading` 里清 `harnessReady`，会让任何插件 iframe 加载把 harness 永久打成加载态。

### 3.2 设置面板（`settings.html` + `shell.css`）

- 左侧 176px 定位菜单（更新/连接/外观/日志，全部平铺不折叠），随滚动高亮；内容整体居中（外层 940px、正文 660px）。
- 入口焦点：只有「连接」语义的入口（终端启动器／⌘,／终端徽标／失败页「连接设置」）锚定「连接」；顶栏「设置」等普通入口锚点为 `null`，停在顶部。初始焦点在 boot 状态与 `updates.getState()` 两次渲染都完成后施加。
- 定位目标夹取到最大可滚动位置（底部不留垫层，滚到底就是日志本身）。

## 4. 端口与进程策略

1. 本地和远端 `dsh web` 统一使用 `--port 0`；CLI 打印 `dsh web: http://127.0.0.1:<port>`，壳解析后写 state，窗口跟随实际端口。
2. SSH 本地转发不能由 ssh 汇报端口，使用**优先端口 + 顺延 30**：`localPort` 空闲则用，否则 `ports.js` 探测下一个空闲端口；探测→绑定窗口用 `reservePort/releasePort` 括起来。
3. 所有子进程 spawn 都经 `runner.js`：`runCommand`（有界前台命令，`detached: true` 独立进程组，超时组杀 SIGKILL）、`spawnService`（长驻服务，组 SIGTERM 停止）、`spawnDetached`（更新 worker，不注册登记表，壳退出不杀）。
4. **进程登记表**：每个 spawn 自动登记，`before-quit` 调 `killActiveChildren()` 组杀全部——包括在途 git/pnpm 构建与插件安装。
5. 本地 clone、远端 clone、build pipeline 都通过 `runtime-store.js` 的原子目录锁；本地锁 owner 为 `{pid, host, createdAt}`，owner 进程消失即 stale；远端锁 owner JSON 超 2 小时视为 stale。
6. 旧版/残留自管服务通过 `<dshHome>/desktop-web.state.json`（远端 `~/.dsh/desktop-web.state.json`）按 `{pid, port, version}` 回收；版本一致且仍响应 `__DSH_BOOT__` 时复用。

## 5. 连接生命周期与驻留程序自动升级

`connect()` 重置本地引用、杀旧子进程、释放旧预留，然后 `connectLocal/connectSsh`。失败触发 `connect-failed`，main 最多自动重试 2 次（10s/20s）。

**连接时自动升级（reap → launch）**：连接对比 state 记录的 version 与当前 `serviceVersion`。不匹配 → 自动清理旧驻留程序（kill 记录 pid / lsof 兜底）→ 以当前版本重新启动。版本身份即官方产物的包版本（npm 布局），统一经 `versionToken`。

**两层升级语义**：连接只负责「升级到 current」；「获取新版本」走更新管线（registry 预检 → 下载官方产物 → 原子切换 → 重启）。

**远端恢复**：state 匹配但服务已死（崩溃/远端重启）时，锁内探活（node fetch + `__DSH_BOOT__`）→ 自动 reap + relaunch，不会建隧道到死端口空等。

**无感自动重连（seamless reconnect）**：harness 可能因外部因素重启——插件安装触发进程退出或进程内重载、外部托管服务换端口、远端服务在隧道仍活时崩溃。壳用两层机制兜住，均不打断用户手动操作：

1. **close watcher 发布新端口**：自管本地服务退出时，`spawnLocalService` 的 close watcher 转 `restarting`（壳边框切加载面板）→ 按版本重解析后重启 → 成功后 `setStatus({state:'ready', url: this.url()})` 发布 OS 新分配端口，`onSessionStatus` 据此刷新窗口。此前重启后从不发布新 URL，窗口仍指向死端口，是「必须手动重连」的根因之一。
2. **健康看门狗**：`status.state === 'ready'` 期间每 `HEALTH_INTERVAL_MS`(4s) 探测一次服务 URL，连续 `HEALTH_FAILURE_THRESHOLD`(2) 次失败判定服务已不可用，自动 `connect()` 重连（走既有 reap→launch→ready 流程）。覆盖 close 事件观察不到的进程内重载、外部托管、远端崩溃场景。非 `ready` 态（connecting/restarting/error）看门狗退避，避免与 close watcher / 重连定时器抢跑。

## 6. 更新架构（产物优先 + 可恢复 + 生命周期解耦）

1. **仅官方产物**：`artifact.js` 先做 registry 预检（最新版本 + 依赖链完整性），`npm install --prefix` 装进 `runtime/<version>`（npm 布局），校验后原子切换 `current`。registry 链断则更新失败并给出明确原因，不再回退源码构建。
2. **detached worker 执行**：菜单「更新并重启」与初始化在本地产物可用时由 `update-worker.js` 独立进程执行（`spawnDetached`，壳退出不杀）。壳轮询 `runtime/update-status.json` 推送阶段/日志；`done` 后由壳重启服务（或下次连接按版本不匹配自动重启）。
3. **意图可恢复**：更新前写 `update-pending.json`，正常结束才清除；启动时 `resumePendingUpdate()` 检测残留——worker 还在跑则接管观察，已完成则提示，被打断则询问「继续/放弃」后重跑。
4. **版本化运行时与回滚**：官方产物安装在 `<dshHome>/runtime/<version>`（远端 `~/.dsh/runtime/<version>`），成功后原子切换 `current`；新版本启动失败自动回滚 `previous`，更新菜单可手动「回滚 Harness」。
5. **始终跟踪最新发布**：无用户可选通道。每次检查在 registry 声明的所有 dist-tag（`latest`/`next`/`alpha`/`beta`/`rc`）里取 semver 最高者，由 `resolveChannelVersion()` 纯函数解析；胜出的 tag 仅用于展示。版本比较保留预发布后缀（semver 优先级）。预发布版因此默认可见，插件兼容性由用户负责。详见 [development.md §6.5](./development.md)。

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
