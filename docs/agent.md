# DSH 桌面壳 Agent 文档

本文档供后续在仓库中工作的编码 Agent / 开发者使用。目标是：**看懂最近一次实现、
不破坏既有边界、按同一套方式继续加固和交付。**

## 1. 项目一句话

Electron macOS 薄壳：主窗口顶部 46px 壳边框，下面是 harness WebContentsView；
每个窗口绑定一个设备 session；更新/构建全部走官方 git/pnpm/`dsh plugin` 命令。

## 2. 最近一次实现清单

| 主题 | 位置 | 关键点 |
|---|---|---|
| 开发态隔离 | `src/main.js#configureUserData` | 未打包时 userData=`~/.dsh-dev`（自动创建）；`DSH_DESKTOP_USER_DATA` 可覆盖 |
| 端口 0 | `src/runtime-store.js`、`src/connection.js` | 本地/远端 `dsh web --port 0`，解析 `dsh web: URL` 回读真实端口 |
| 版本化运行时 | `src/runtime-store.js`、`src/update.js` | staging git worktree build → 原子 `current` → 自动/手动回滚 |
| 转发端口 | `src/ports.js` | 仅 SSH 本地转发使用优先端口 + 顺延 30 + 进程内预留 |
| 安装/构建锁 | `src/runtime-store.js`、`src/update.js` | 本地 `mkdir` 锁；远端 owner+2h stale 锁；clone/build 串行 |
| 窗口状态 | `src/window-manager.js`、`src/main.js` | `window-state.json` 保存 bounds/active-view/last-active，启动恢复 |
| 多窗口加固 | `src/main.js` | 保存后重载同设备所有设置面板；按终端 busy 阻止同设备并发任务；重连定时器不复活已 stop session |
| 退出防护 | `src/main.js#before-quit` | 退出直接 teardown 子进程；staging 与运行服务隔离，杀 build 安全 |
| 日志面板 | `src/ui/settings.html` | 日志在 tab 最后、固定 176px、`updates:get-log` 回填最新 |
| macOS UI | `src/main.js#createBrowserWindow`、`src/ui/shell.css` | hiddenInset + trafficLightPosition；系统字体与浅/深色变量 |
| npm 插件 | `src/components.js`、`src/update-manager.js`、`src/ui/settings.html` | `installSpec` 支持 pnpm `add` 全语法；可直接粘贴完整命令 |
| 终端身份 | `src/settings.js`、`src/connection.js`、`src/main.js` | 远程机器身份用 `~/.dsh/.desktop-machine-id`，设备键归一为 `machine:<id>`，不同 ssh 别名指向同一机器时合并 |
| SSH banner 隔离 | `src/connection.js#remoteRun` | 远程命令用随机 sentinel 包裹，网关登录 banner（`authz success` 等）被隔离在 payload 之外 |
| 加载面板 | `src/main.js`、`src/ui/shell.html`、`src/ui/shell.css` | 连接/加载/构建/更新期间用主窗口内置面板展示 spinner + 状态 + 实时日志，替代独立进度窗口 |
| 移除进度窗口 | `src/dialogs.js`、`src/ui/progress.html` | ProgressDialog 已删除；进度经 `shell:state` / `shell:log` 进加载面板，重试走 `shell:action` |

## 3. 必须遵守的不变量

1. **壳不执行任意用户命令。** 用户组件只有 `npm` 与 `git-preset`；npm 安装必须是
   `node bin.js plugin --profile <profile> add <spec>`，`spec` 作为单个 argv 传入。
2. **壳只杀自管子进程。** 非自管服务只探测、只复用，不 kill。
3. **settings 永远先归一化。** 所有入口都经 `normalizeSettings`，坏数据回退默认。
4. **Web 服务端口必须用 `--port 0`。** 不要重新引入本地/远端 web 端口扫描；只有 SSH
   转发端口使用 `acquireLocalPort()`，停止/失败路径调 `releaseReservedPorts()`。
5. **clone/build 必须过 runtime-store 锁。** 新增任何仓库写入或 pnpm build 路径时，
   先判断是否会被第二个壳实例并发执行。
6. **busy 任务按终端互斥。** 新增任何 pnpm install/build/plugin update 路径前，先经过
   `isSessionBusy()` / `canStartBusyTask()` 语义（或复用 `Updater.runPipeline` /
   `UpdateManager.update*`）；不同终端的构建互不阻塞。
7. **多窗口设置不能有第二事实源。** 连接设置保存后必须 `setupDialog.reload()` 同设备窗口；
   更新状态用 `broadcastSession` 推送。
8. **标题与菜单统一走 `labels.js`。** 不要手写第二份 `DSH-[终端]`。
9. **渲染器保持 sandbox。** 只通过 preload 的窄 API；IPC 返回 JSON-safe 数据。
10. **开发态不要碰生产数据。** 不要绕过 `configureUserData` 或写死
   `~/Library/Application Support/DeepSeek Harness`。
11. **每个功能提交一次 git，并在提交前跑两条 smoke。** 见下。
12. **子进程引用必须做身份校验，禁用无条件覆盖。** `ConnectionManager` 的
    `connectEpoch` 是连接代数：close 处理器与重试定时器先比对代数再动作
    （陈旧回调不得再 spawn 或清引用）；`this.localChild === service.child`
    之类身份检查防止跨代误杀/误清。新增任何子进程回调都按此模式。
13. **退出必须杀光所有子进程。** 所有 spawn 都经 `runner.js` 的进程登记表
    （trackChild），`before-quit` 调 `killActiveChildren()` 组杀；不要让
    在途 git/pnpm 构建在应用退出后继续运行。
14. **超时杀进程必须连进程组一起杀。** `runCommand` 一律 `detached: true`，
    超时用 `process.kill(-pid, 'SIGKILL')`，否则 pnpm/npm 的孙进程会孤儿化。

## 4. 验收命令

```sh
node scripts/smoke.js
DSH_DESKTOP_SMOKE=1 npx electron .
node --check <改动的 .js>
```

UI 改动额外检查：

```sh
python3 - <<'PY'
import re, pathlib
for name in ['settings.html','shell.html']:
    text = pathlib.Path('src/ui/' + name).read_text()
    open('/tmp/%s.js' % name, 'w').write('\n'.join(re.findall(r'<script>(.*?)</script>', text, re.S)))
PY
for f in /tmp/settings.html.js /tmp/shell.html.js; do node --check "$f"; done
```

## 5. 改哪里：速查

- 想加“设备级能力”→ 看 `sessionFor` / `workspace`，不要挂在全局单例。
- 想加端口/服务生命周期 → `connection.js`，复用 `ports.js`。
- 想加可更新组件 → 先读 `components.js` 的归一化，再在 `update-manager.js`
  加 check/update 方法；同时补 `scripts/smoke.js` 的无网络测试。
- 想加设置字段 → `settings.js` 默认值 + 归一化、`settings.html` 表单、
  `main.js#save` 校验，并确认多窗口 reload。
- 想动壳边框 UI → `shell.css` 设计变量 + `shell.html` 栏目；禁止引入在线字体/图标依赖。
- 想改日志 → `ConnectionManager.logRing` 是 300 行 ring；面板晚创建用
  `updates:get-log` 回填，不要只依赖实时 push。

## 6. 常见坑

1. **`dsh plugin` 是 pnpm 转发器。** 相对路径 spec（`.`、`../x`）会被 CLI 锚定到调用目录，
   所以本地安装用 `cwd=repoDir`；远端用登录 shell 路径并保持 `shellQuote`。
2. **pnpm 11 对已写死的精确依赖不会自动升级。** 裸包名必须查 latest 后传
   `pkg@x.y.z`；用户显式写了 tag/range/git spec 则原样转发。
3. **远程命令会被双重单引号包裹。** 内层路径/值仍要用 `shellQuote`/`remotePath`，
   不要手拼裸字符串。
4. **`tcpProbe` 成功 ≠ 端口是 DSH。** 本地复用只认 state.version + `__DSH_BOOT__` 标记。
5. **窗口关闭是隐藏不是销毁。** 清理逻辑要区分 `close`（hide）与 `closed`（quit）。
6. **退出不阻塞构建。** 退出直接 teardown 子进程；staging 目录与运行服务隔离，杀 build 安全，下次启动重建。
7. **设置面板是懒创建且常驻。** 修改共享设置后必须 reload，否则旧 form 会被另一个窗口保存回去。
8. **端口不再暴露给用户。** 内部 `dsh web --port 0`；SSH 本地转发 `localPort` 仅作优先值、占用时顺延，settings 里的 `remotePort` 仅作兼容保留。
9. **dirty 工作区不建 runtime 快照。** staging 只对 clean HEAD 使用 git worktree；
   dirty 构建仍发生在源目录，因此回滚菜单对该模式会提示无上一版本。
10. **serviceVersion ≠ currentVersion。** 状态复用必须用 active runtime 的 `serviceVersion`；
    直接比较源 HEAD 会让回滚后的服务在下一次连接时被误杀重建。
11. **重连会杀旧子进程，close 事件异步到达。** 旧 child 的 `close` 可能在新的
    `spawnLocalService` 之后触发：先比 `connectEpoch` 再清引用/排重试，
    否则新服务会失去跟踪（退出时不杀）或触发双 spawn（两个服务进程）。
12. **30s 端口等待定时器可能跨代触发。** `portTimer` 到期时 `this.localChild`
    可能已属于新一代连接；必须身份校验后再 kill，否则会杀掉健康的新服务。

## 7. 文档同步要求

完成新功能后，更新三份文档：

- `docs/requirements.md`：新增 FR 编号与验收。
- `docs/development.md`：模块/命令/测试/架构变化。
- `docs/agent.md`：本次提交清单、新坑与速查。

最后按功能拆分 git commit；不要把 UI、端口、插件、文档混成一个 commit。
