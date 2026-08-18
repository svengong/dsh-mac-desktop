# 开发计划（Roadmap）

## 1. 项目阶段总览

| 阶段 | 状态 | 说明 |
|---|---|---|
| 桌面壳（macOS）本地 + SSH 远程 | ✅ 已交付 | 静默部署/自动升级驻留程序、多窗口、产物优先更新，e2e 验证通过 |
| 自动发布链路 | ✅ 已交付 | `scripts/release.js` 一键发布 + GitHub Actions 双架构构建 |
| 官方产物渠道 | 🟡 部分可用 | npm 预检已实现；上游 `@deepseek-ai/dsh-frontend` 发布后自动生效 |
| **移动端：手机 SSH 连 Linux** | ⬜ 规划中 | 本文档第 2 节 |

## 2. 移动端：手机通过 SSH 连 Linux

### 2.1 需求背景

外出时用手机访问家中/公司 Linux 服务器上的 DSH harness（Web UI 与 agent），通过 SSH 隧道保证安全——不把 Web 端口暴露到公网，无需登录服务器，与桌面壳「SSH 远程静默部署」的体验一致。

### 2.2 现状基础（可复用资产）

- **Linux 侧机制已就绪且与客户端形态无关**：远端驻留服务（`desktop-web.state.json` + `setsid` 启动）、版本化运行时、免密 SSH——`scripts/e2e-ssh.js` 已真机验证。
- **Web UI 具备基础移动适配**：`index.html` 已有 `viewport` meta；响应式程度（断点/触摸/交互）待 P0 实测。
- **认证模型一致**：SSH 密钥免密登录，与桌面壳相同。

### 2.3 方案对比与选型

| 方案 | 体验 | 成本 | 结论 |
|---|---|---|---|
| A. 手机浏览器 + 第三方 SSH 隧道 app（Termius/Blink/JuiceSSH） | 割裂（两个 app 切换） | 零开发 | **P0 验证用**，不作为交付形态 |
| B. 自研轻量移动壳（Flutter，iOS/Android 单代码库） | 好（隧道 + WebView 一体） | 中 | **主推**，P1 实现 |
| C. 原生双端自研 | 最好 | 高 | 无专门移动团队时不选 |
| D. 服务端 HTTPS 网关（反代 + 认证） | 好 | 中 | 备选；暴露服务到公网，与「通过 SSH」诉求不符 |

**推荐路径：P0 用方案 A 验证可行性 → P1 用方案 B 交付移动壳。**

### 2.4 分阶段计划

#### P0 — 可行性验证（无移动代码）

目标：确认「手机访问 Linux harness」链路成立，产出移动适配问题清单。

1. 用 Termius / Blink 在手机建立 SSH 隧道：手机 `127.0.0.1:3080` → Linux 远端端口（复用现有驻留服务）。
2. 手机浏览器访问 `http://127.0.0.1:3080`，验证：
   - UI 适配：布局/字体/触摸/输入法/滚动；harness 前端是否有 media query 断点；
   - 交互完整性：登录态、agent 对话、文件上传/下载、复制粘贴、长按菜单；
   - 性能与稳定性：首屏耗时、WebSocket 连接（若有）、断线/网络切换后的恢复；
   - 安全性：隧道仅监听 127.0.0.1；页面是否加载外部资源（决定 WebView 策略）。
3. 产出：问题清单 → 决定 P1 功能范围与 WebView 选型。

验收：手机浏览器能完整完成一次 agent 对话（或 UI 适配问题清单全部有解）。

#### P1 — 移动壳 MVP（Flutter）

目标：交付一体化的「SSH 连接 → 隧道 → WebView」移动壳，Linux 侧零改动。

功能范围（刻意收敛）：

1. **SSH 主机管理**：别名 / host / 端口 / 私钥（导入或生成，存系统钥匙串：iOS Keychain / Android Keystore）。
2. **连接**：SSH 免密 → 本地端口转发（手机 127.0.0.1 随机端口）→ WebView 加载；探活 `__DSH_BOOT__` 确认是 DSH 而非别的服务。
3. **复用远端机制（只读部分）**：连接前读取远端 `desktop-web.state.json`——服务在跑且版本匹配 → 直接隧道接入；**P1 不做自动重启/升级**（见 P2）。
4. **断开清理**：隧道关闭、端口释放、WebView 销毁；网络切换自动重连（指数退避）。
5. **前台使用约束**：iOS 后台隧道受系统限制（普通 app 后台挂起），P1 明确「前台使用」；P2 评估 NetworkExtension。

技术要点 / 风险（P1 开始前的 spike）：

- **dart SSH 库成熟度**（ssh2 类库）——必须先 spike：密钥解析（OpenSSH 格式）、端口转发 API、保活；若不达标，评估 native 插件桥接（iOS NMSSH / Android JSch）。
- **WebView 能力差异**：iOS WKWebView / Android WebView 对 harness 前端所用 API 的支持（WebSocket、文件、剪贴板、SharedArrayBuffer 等）——P0 清单驱动。
- **iOS 后台限制**：长时间后台隧道需 NetworkExtension（VPN 级，复杂度陡增）——P1 接受前台使用。

验收：真机（iOS + Android 各一台）SSH 连 ubuntu 服务器 → WebView 展示 harness UI → 完成一次 agent 对话；隧道断开自动重连。

#### P2 — 增强

- 驻留服务自动恢复/升级：移植 `desktop-web.state.json` 探活 + reap + relaunch（连接即自动升级到当前版本，与桌面壳语义一致）。
- 多终端切换与连接记录（复用设备模型：local / ssh:<host> / machine:<id>）。
- 更新可用推送通知（复用组件检查模型）。
- 后台能力评估：iOS NetworkExtension（VPN 隧道）或 Android 前台服务保活。

### 2.5 验证基线

- Linux 侧：`scripts/e2e-ssh.js <ssh-host>` 每次改动后回归（远端构建、自动 relaunch、版本自动升级）。
- 移动侧：真机验收清单（见 P0/P1 验收）；无头环境不可行，需实物测试。

## 3. 其他规划方向（备选，未排期）

- **官方产物通道打通**：上游发布 `@deepseek-ai/dsh-frontend` 后，`artifact.js` 预检自动放行，移动端/桌面端均可纯产物部署。
- **Windows 桌面壳**：当前全部机制为 POSIX 设计（setsid/stat/lsof），需评估 Windows 等价物（任务计划/等价的进程组管理）。

## 4. 计划维护

- 本文件与 [需求文档](requirements.md)、[架构文档](architecture.md) 同步维护；功能落地后把条目移入已交付清单，并更新对应文档。
