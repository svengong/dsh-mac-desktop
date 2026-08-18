# DSH 桌面壳开发文档

## 1. 快速开始

```sh
# 安装依赖（Electron 35 + electron-builder）
npm install

# 开发模式：userData 固定在 ~/.dsh-desktop，不影响已安装应用
npm start

# Electron-free 模块测试
npm run smoke

# Electron 内冒烟（菜单/托盘/Dock 等）
DSH_DESKTOP_SMOKE=1 npx electron .

# 构建 macOS 应用目录 / DMG
npm run dist
npm run dist:dmg
```

### 1.1 开发态数据隔离

- 开发态（`app.isPackaged === false`）自动执行
  `app.setPath('userData', '~/.dsh-desktop')`，settings.json、logs、单实例锁都在这里。
- 本地服务的 `DSH_HOME` 默认也是 `~/.dsh-desktop`，与用户常规 `~/.dsh` 分离。
- 需要特殊隔离时设置环境变量：

```sh
DSH_DESKTOP_USER_DATA=~/tmp/dsh-shell-dev npm start
```

已打包应用默认仍使用
`~/Library/Application Support/DeepSeek Harness`，除非显式设置该环境变量。

## 2. 目录与模块

```
src/
├── main.js           主进程：userData 隔离、窗口/会话生命周期、IPC、菜单/托盘装配
├── settings.js       设备级设置归一化与原子保存；默认 dshHome
├── window-manager.js 窗口 bounds/active-view/last-active 持久化与恢复
├── runtime-store.js  local/remote runtime state、`dsh web` URL 解析、原子 clone/build 锁
├── ports.js          SSH 本地转发端口的进程内预留与 TCP 探测
├── connection.js     本地服务/SSH 隧道连接、state 复用、服务重置、日志 ring
├── update.js         Harness pipeline：git → pnpm install → build → 重启
├── update-manager.js 组件检查/更新：harness、npm 插件、git preset
├── components.js     组件目录、归一化、npm spec 解析、版本比较/树哈希
├── ssh.js            ssh config 解析、目标解析、quoting、remote path
├── tools.js          node/pnpm 探测（engine 过滤）与干净子进程环境
├── runner.js         runCommand / spawnService（独立进程组）
├── dialogs.js        SetupDialog（嵌入式 WebContentsView）
├── labels.js         全局一致的 DSH-[终端] 标签
├── menu.js / tray.js / windows.js  macOS 菜单、托盘、窗口呈现
└── ui/
    ├── shell.html / shell.css / shell-preload.js   主窗口 46px 壳边框
    └── settings.html / dialog-preload.js           连接/更新嵌入式面板
```

数据流：

```text
BrowserWindow (shell.html 边框)
 ├─ harness WebContentsView        ← http://127.0.0.1:<实际端口>
 └─ settings WebContentsView       ← dialog:* / updates:* IPC
        │
        └─ main.js: workspace ── session ── ConnectionManager
                                            ├─ local service (node bin.js web --port)
                                            ├─ ssh tunnel (ssh -N -L)
                                            └─ UpdateManager / Updater
```

## 3. 多窗口模型

- `workspaces`：`Map<id, workspace>`，一个 BrowserWindow 一个 workspace。
- `sessions`：`Map<deviceKey, session>`。`deviceKey` 为 `local`、`ssh:<host>`，或连接后归一出的 `machine:<id>`（同一远程机器经不同 ssh 别名接入时合并）。
- 同设备窗口共享 session；窗口关闭只是隐藏，workspace 持续存活，显式退出时才销毁。
- 窗口切换设备调用 `attachWorkspace`：旧 SSH session 在最后一个窗口离开后停止；
  `local` session 常驻以支持多开。
- 任何窗口保存连接设置后，主进程重载该设备所有窗口的设置 WebContentsView，
  防止“旧表单被另一个窗口重新保存”。
- `window-manager.js` 持久化 `window-state.json`：bounds、active view、last-active
  workspace/device；启动先恢复 last-active 设备，IPC fallback 不再只靠焦点扫描。

## 4. 端口与冲突策略

### 4.1 规则

1. 本地和远端 `dsh web` 统一使用 `--port 0`；CLI 打印
   `dsh web: http://127.0.0.1:<port>`，壳解析后写入 state。
2. SSH 本地转发不能由 ssh 汇报端口，所以仍使用**优先端口 + 顺延 30**：
   设置中的 `localPort` 空闲则用，否则 `src/ports.js` 探测下一个空闲端口。
3. 转发端口的“探测 → 绑定”窗口用 `reservePort/releasePort` 括起来；停止/连接失败必须
   `releaseReservedPorts()`。
4. 本地 clone、远端 clone、build pipeline 都通过 `runtime-store.js` 的原子目录锁：
   - 本地锁 owner 为 `{pid, host, createdAt}`，owner 进程消失即 stale；
   - 远端锁写 owner JSON，超过 2 小时视为 stale，可被下一实例回收。
5. 旧版/残留自管服务通过 `<dshHome>/desktop-web.state.json`
   （远端 `~/.dsh/desktop-web.state.json`）按 `{pid, port, version}` 回收；版本一致且仍响应
   `__DSH_BOOT__` 标记时复用。
6. 服务重启后如果 URL 端口变化，`onSessionStatus` 会让已打开窗口原地 reload，不抢焦点。

### 4.2 典型场景

| 场景 | 结果 |
|---|---|
| 本地开发版与已安装版都在运行 | web 服务均由 OS 分配端口；转发端口仍自动顺延。 |
| 两个 SSH 窗口同时连不同主机，均配置 3080 本地转发 | 两个本地转发端口由 reservation 串行分配，不会同时选同一个回退口。 |
| 两个窗口连同一 SSH 主机 | 远端服务由 OS 分配端口；clone/build 由远端锁串行化。 |
| 两个壳实例同时 clone/build | 本地 `mkdir` 锁或远端 owner+stale 锁保证串行。 |
| 隧道超时 | 先杀掉本次超时子进程，再进入错误/重试路径。 |

## 5. 连接生命周期

- `connect()` 重置本地引用、杀旧子进程、释放旧预留，然后 `connectLocal/connectSsh`。
- 失败触发 `connect-failed`，main 最多自动重试 2 次（10s/20s）；session 被 stop 后定时器作废。
- ready 后执行一次性启动自动检查（按设备开关）。
- 构建/更新按设备互斥：同一终端的第二次构建/更新、重连、重置后端、保存连接设置被 `isSessionBusy(session)` 拦截；不同终端的构建互不干扰。

## 6. 更新管理

### 6.1 组件模型

`update.components` 按设备保存在 settings 中，Harness 行内置且永远存在。用户行仅两种：

- `npm`：`installSpec` 是 `dsh plugin --profile <profile> add <spec>` 的 spec。
- `git-preset`：`repoUrl/checkoutDir/sourceDir/presetId`。

未知 kind 会在归一化时丢弃，因此 settings.json 永远不能把壳变成任意命令执行器。

### 6.2 Harness staged runtime

- clean 工作区：`git worktree add --detach <dshHome>/runtime/<version> HEAD`，
  在 worktree 里 `pnpm install + build`，成功后原子切换 `current` symlink；
- dirty 工作区：保持旧行为，在源目录构建，不提供回滚快照；
- `runtime/manifest.json` 保存 `current` 与 `previous`，最多保留当前 + 上一版本；
- 新 runtime 启动失败：自动切回 `previous` 并重启旧版本；
- 更新菜单「回滚 Harness…」调用同一套 runtime-store 回滚并重置/重连后端；
- 远端同构：`~/.dsh/runtime/<version>` + `~/.dsh/runtime/current`。

### 6.3 npm 插件 spec

支持 pnpm `add` 全语法：

```text
dsh-example
@scope/pkg@^1.2.3
npm:alias@1
github:owner/repo
git+https://github.com/owner/repo.git#main
file:./hello-plugin
link:../hello-plugin
./hello-plugin.tgz
https://example.com/hello-plugin.tgz
```

更新行为：

- 裸 npm 包：先查 `<registry>/<pkg>/latest`，再执行 `add pkg@<version>`，规避 pnpm 11
  对已写死精确版本不更新的行为。
- 带 tag/range/alias：按原 spec 执行，同时仍从 registry 读取 latest 用于展示。
- git/path/tarball：不查 registry，`updateAvailable=true` 表示“重新执行安装源”。

`registryUrl` 通过 `npm_config_registry` 传给实际 pnpm 安装，版本检查也使用同一 registry。
npm 插件与 Git 预设的实际安装通过 `withComponentLock` 串行化（本地/远端锁），
避免第二个壳实例同时写同一 profile 或预设目录。

## 7. macOS UI 约定

- 主窗口：`titleBarStyle: 'hiddenInset'`、`trafficLightPosition: {x:18,y:15}`，
  壳边框 46px，左侧 84px 避让红黄绿按钮。
- 字体：
  `-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", "PingFang SC", …`
  等宽：`ui-monospace, "SF Mono", SFMono-Regular, Menlo`。
- 颜色：深色 `#1e1e1e/#282828/#f5f5f7` 与 accent `#0a84ff`；浅色
  `#f2f2f7/#ffffff/#1d1d1f` 与 accent `#007aff`；通过 CSS 变量切换。
- 控件：输入框 24px、普通按钮 22px、小按钮 18px、圆角 5–10px、焦点环
  `0 0 0 3px accent-soft`。
- 日志：更新管理 tab 的日志在最后，`.updates-log` 固定 176px，初始回填最近日志并
  `scrollTop = scrollHeight`。
- 动效遵循 `prefers-reduced-motion`。不需要在线字体/图标。

## 8. 测试

```sh
node scripts/smoke.js                    # 纯 Node 模块（设置/ssh/runner/组件/端口）
DSH_DESKTOP_SMOKE=1 npx electron .       # Electron 冒烟（菜单/Dock/actions）
```

新增逻辑时建议至少覆盖：

- `normalizeSettings` / `normalizeUserComponent` / npm spec 解析。
- `findFreePort` + reservation 的跳端口行为。
- `parseDshWebUrl` + 实际启动 `dsh web --port 0` 并回读端口。
- `runtimeStore` local state round-trip、本地锁、local/remote runtime 激活与回滚。
- `WindowManager` 保存/恢复 last-active device 与 bounds。
- ssh quoting、remotePath、tunnelArgs。
- UpdateManager 非网络快照与 preset checkout 路径。

## 9. 提交约定

按功能拆 commit，建议前缀：

- `feat:` 新功能
- `fix:` 边界修复
- `style:` UI/设计系统
- `docs:` 文档
- `test:` smoke 与验收

本次任务对应的提交边界：

1. 开发态 runtime 隔离 + 端口预留。
2. 多窗口并发/重连/退出防护。
3. 更新管理日志位置与固定高度。
4. macOS 壳边框样式。
5. npm 插件安装 spec 兼容。
6. 需求/开发/agent 文档。
