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
| 版本化运行时 | `src/runtime-store.js`、`src/update.js` | 官方产物 npm install → 原子 `current` → 自动/手动回滚 |
| 转发端口 | `src/ports.js` | 仅 SSH 本地转发使用优先端口 + 顺延 30 + 进程内预留 |
| 安装锁 | `src/runtime-store.js`、`src/update.js` | 本地 `mkdir` 锁；远端 owner+2h stale 锁；产物安装串行 |
| 窗口状态 | `src/window-manager.js`、`src/main.js` | `window-state.json` 保存 bounds/active-view/last-active，启动恢复 |
| 多窗口加固 | `src/main.js` | 保存后重载同设备所有设置面板；按终端 busy 阻止同设备并发任务；重连定时器不复活已 stop session |
| 退出防护 | `src/main.js#before-quit` | 退出直接 teardown 子进程；staging 与运行服务隔离，杀安装安全 |
| 日志面板 | `src/ui/settings.html` | 日志在 tab 最后、固定 176px、`updates:get-log` 回填最新 |
| macOS UI | `src/main.js#createBrowserWindow`、`src/ui/shell.css` | hiddenInset + trafficLightPosition；系统字体与浅/深色变量 |
| npm 插件 | `src/components.js`、`src/update-manager.js`、`src/ui/settings.html` | `installSpec` 支持 pnpm `add` 全语法；可直接粘贴完整命令 |
| 终端身份 | `src/settings.js`、`src/connection.js`、`src/main.js` | 远程机器身份用 `~/.dsh/.desktop-machine-id`，设备键归一为 `machine:<id>`，不同 ssh 别名指向同一机器时合并 |
| SSH banner 隔离 | `src/connection.js#remoteRun` | 远程命令用随机 sentinel 包裹，网关登录 banner（`authz success` 等）被隔离在 payload 之外 |
| 加载面板 | `src/main.js`、`src/ui/shell.html`、`src/ui/shell.css` | 连接/加载/构建/更新期间用主窗口内置面板展示 spinner + 状态 + 实时日志，替代独立进度窗口 |
| 移除进度窗口 | `src/dialogs.js`、`src/ui/progress.html` | ProgressDialog 已删除；进度经 `shell:state` / `shell:log` 进加载面板，重试走 `shell:action` |
| 无感自动重连 | `src/connection.js` | close watcher 重启后发布新端口 `ready`；`ready` 态每 4s 健康探测，连续 2 次失败自动 `connect()`（`startHealthMonitor`/`healthTick`/`HEALTH_INTERVAL_MS`/`HEALTH_FAILURE_THRESHOLD`），覆盖插件安装/进程内重载/外部托管/远端崩溃 |
| 设置定位菜单 | `src/ui/settings.html`、`src/ui/shell.css` | 左侧 176px 菜单只**定位**分区（更新/连接/外观/日志，全部平铺不折叠），随滚动高亮；内容整体居中（外层 940px、正文 660px）；有可用更新时「更新」带橙点 |
| 设置入口焦点 | `src/main.js#setWorkspaceView`、`src/dialogs.js`、`src/ui/settings.html` | 只有「连接」语义的入口（终端启动器／⌘,／终端徽标／失败页「连接设置」）才锚定到「连接」；顶栏「设置」等普通入口锚点为 `null`，面板停在顶部。初始焦点在 boot 状态与 `updates.getState()` **两次渲染都完成后**才施加，否则偏移量按旧布局计算会落空 |

## 3. 必须遵守的不变量

1. **壳不执行任意用户命令。** 用户组件只有 `npm` 与 `git-preset`；npm 安装必须是
   `node bin.js plugin --profile <profile> add <spec>`，`spec` 作为单个 argv 传入。
2. **壳只杀自管子进程。** 非自管服务只探测、只复用，不 kill。
3. **settings 永远先归一化。** 所有入口都经 `normalizeSettings`，坏数据回退默认。
4. **Web 服务端口必须用 `--port 0`。** 不要重新引入本地/远端 web 端口扫描；只有 SSH
   转发端口使用 `acquireLocalPort()`，停止/失败路径调 `releaseReservedPorts()`。
5. **产物安装必须过 runtime-store 锁。** 新增任何运行时写入或产物安装路径时，
   先判断是否会被第二个壳实例并发执行。
6. **busy 任务按终端互斥。** 新增任何产物安装/plugin update 路径前，先经过
   `isSessionBusy()` / `canStartBusyTask()` 语义（或复用 `Updater.runPipeline` /
   `UpdateManager.update*`）；不同终端的安装互不阻塞。
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
15. **仅官方产物，无源码构建。** 更新只走 `artifact.js` 预检（registry 最新版 +
    依赖链完整性）→ `installNpmArtifact` 安装 → `activateLocalRuntime` 原子切换；
    链断/安装失败直接报错并说明原因，不回退源码构建。新增安装路径必须复用这套
    原语，不要自造第三套。
16. **更新意图必须可恢复。**
17. **连接时自动升级驻留程序是核心契约。** 连接对比 state.version 与
   serviceVersion，不匹配自动 reap + relaunch；但「获取新版本」只走更新管线——
   版本只在更新管线里变更。改版本语义前先读
   `development.md`「10. 新版本发布约定」。 开始更新前写 `update-pending.json`，正常结束才清除；
    被打断（退出/崩溃）后启动时 `resumePendingUpdate()` 询问继续/放弃。detached
    worker（`update-worker.js`）不注册进进程登记表，壳退出不杀它；壳通过
    `runtime/update-status.json` 观察，`done` 后重启服务，下次连接按版本不匹配兜底。

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
6. **退出不阻塞安装。** 退出直接 teardown 子进程；staging 目录与运行服务隔离，杀安装安全，下次启动重建。
7. **设置面板是懒创建且常驻。** 修改共享设置后必须 reload，否则旧 form 会被另一个窗口保存回去。
8. **端口不再暴露给用户。** 内部 `dsh web --port 0`；SSH 本地转发 `localPort` 仅作优先值、占用时顺延，settings 里的 `remotePort` 仅作兼容保留。
9. **官方产物安装失败会回滚。** 新产物启动失败自动切回 `previous` 并重启旧版本；
   无上一版本（首次安装）时则报错并保留失败目录待重试。
10. **serviceVersion ≠ currentVersion。** 状态复用必须用 active runtime 的 `serviceVersion`；
    直接比较包版本之外的东西会让回滚后的服务在下一次连接时被误杀重建。
11. **运行时布局不再只有仓库形状。** bin 查找必须走 `runtime-layout.js`
    （repo 布局 `apps/cli/lib/bin.js`；npm 布局 `node_modules/@deepseek-ai/dsh/lib/bin.js`），
    直接拼 `apps/cli/lib/bin.js` 会漏掉官方产物运行时。
12. **重连会杀旧子进程，close 事件异步到达。** 旧 child 的 `close` 可能在新的
    `spawnLocalService` 之后触发：先比 `connectEpoch` 再清引用/排重试，
    否则新服务会失去跟踪（退出时不杀）或触发双 spawn（两个服务进程）。
13. **30s 端口等待定时器可能跨代触发。** `portTimer` 到期时 `this.localChild`
    可能已属于新一代连接；必须身份校验后再 kill，否则会杀掉健康的新服务。
14. **远端命令的 stat 必须 GNU 优先。** `stat -c %Y`（GNU/Linux）先试，
    `stat -f %m`（BSD/macOS）兜底；反序时 GNU 的 `-f %m` 会把文件系统信息块
    打到 stdout 污染 lines[0]。
15. **远端 state 文件必须带换行结尾。** `writeRemoteState` 的 printf 缺 `\n`
    会让 `cat` 输出与 remoteRun 的 END marker 粘连，payload 隔离失效导致
    state 读取返回 null（历史潜伏缺陷）。`extractPayload` 按子串匹配 marker
    做纵深防御，新增无换行输出的远端命令前先想清楚 marker 行为。
16. **版本只在更新管线里变更，连接不触发升级。** `serviceVersion` 在
    manifest.current 有效时返回它；只有「获取新版本」（更新管线）才会切换
    current，连接只负责「升级到 current」。
17. **服务重启后必须发布新端口 `ready`，否则窗口卡死在死端口。** `--port 0` 重启
    可能换端口；close watcher / 隧道重连 / 健康看门狗恢复成功后都要
    `setStatus({state:'ready', url: this.url()})`，`onSessionStatus` 才能据此
    刷新窗口。只更新 `localPort` 而不发 status，窗口仍指向旧 URL。
18. **健康看门狗只跑在 `ready` 态，且要连败计数防抖。** 非 ready
    （connecting/restarting/error）退避，避免与 close watcher、`onSessionConnectFailed`
    重试、更新流水线抢跑造成双重连/无限重连。

## 7. 文档同步要求

完成新功能后，更新三份文档：

- `docs/requirements.md`：新增 FR 编号与验收。
- `docs/development.md`：模块/命令/测试/架构变化。
- `docs/agent.md`：本次提交清单、新坑与速查。

最后按功能拆分 git commit；不要把 UI、端口、插件、文档混成一个 commit。
