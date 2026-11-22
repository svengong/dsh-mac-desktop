# 便携版 node 版本写死：问题与彻底解决方案

> 提案，未实施。范围：`src/node-bootstrap.js`、`src/tools.js`、`src/update.js`、`src/update-worker.js`、`src/connection.js`、`src/main.js`、`scripts/smoke.js`。

## 1. 问题

壳在设备上没有兼容 node 时会下载便携版，版本写死为 `22.19.0`：

| 位置 | 内容 |
|---|---|
| `src/node-bootstrap.js:28` | `PORTABLE_NODE_VERSION = '22.19.0'` |
| `src/update.js:642` | SSH 远端又写死一遍 `'22.19.0'`，没复用常量 |
| `src/tools.js:274` | `engineOk`：`major >= 24 \|\| (major === 22 && minor >= 19)`，与产物真实要求无关 |
| `src/update.js:389`、`src/connection.js:978` | 报错文案「需 22.19+ 或 24+」 |

这个值不是主动选的：它只是 harness 仓库 `engines.node` 的**下限**（由依赖 `@earendil-works/pi-ai` 的 `>=22.19.0` 推出），壳把"下限"当成了"要装的版本"。

**问题已经在发生**：`@deepseek-ai/dsh` 从 `0.2.2-alpha.2` 起声明 `engines.node: ">=24.9.0"`，而壳仍认定 22.19 合格。实测用真实的 22.19 便携版自带 npm 安装这类包，只给 `EBADENGINE` 警告、**退出码 0**，所以 `installNpmArtifact` 会"成功"，错误推迟到运行时才爆。

**四个缺陷**：

- **D1 人肉同步**：常量与 harness engines 之间只有一条注释维系，壳从不读产物的 `engines`。
- **D2 只认"能跑"**：`ensurePortableNode` 的 `isRunnable` 是"任何 `engineOk` 通过的文件"，22.19 一旦落盘就**永远复用**；改常量只帮新设备，老设备不修。
- **D3 错误指向错因**：用户看到的是 npm 安装尾部或"便携版已就位但仍无法运行"，没人想到是版本。
- **D4 下界不触发重解析**：`resolvedTools({refresh:true})` 只重扫，不会带上新的下界规则。

附带一个独立问题：`src/tools.js:341` 的 `childEnv` 把用户 node 目录放在 PATH 首位，pnpm 垫片可能被旧 node 启动并被 pnpm 自己的 engines 拒绝，症状很像"node 版本不对"。

## 2. 方案

原则：**"需要什么 node"只来自产物的 `engines.node`**；写入常量的只作兜底；"够用"是版本比较；已装但不达标必须替换；不达标在**安装前**就以明确文案失败。

```
registry 产物 engines.node ─┐
打包兜底常量 ───────────────┴─▶ resolvePortableNodeVersion ─▶ ensurePortableNode({nodeRange, version})
                                                              填装/替换 → setNodeFloor → 重解析
```

**① 新增 `src/node-engine.js`（纯函数，无新依赖）**

- `parseNodeFloor(spec)`：支持 `>=X.Y.Z`、`^X.Y.Z`、`X.Y.Z`，其余返回 `''`。
- `nodeVersionMeets(v, nodeRange)`：基于 `semver.satisfies(..., {includePrerelease:true})`（与 npm 的 engines 判定一致），替换 `engineOk` 的手写区间。
- `resolvePortableNodeVersion({nodeRange, fetchJson, distFile})`：选出**具体**版本，规则优先级为
  1. **产物接受的最新 LTS 发行版**（其次是产物接受的最新发行版）——没有 node 的机器整台都跑在便携版上，给最新而不是下界。`distFile` 过滤掉该平台没有归档的版本；
  2. 索引不可达 / 无兼容版本时：包内兜底常量 `PORTABLE_NODE_BUNDLED`，不满足区间则明确失败，不"尽力安装"。

  > 不写死"最新版"：最新 LTS 是浮动的，写死仍是同一种病。浮动只发生在**解析时**（有索引时按区间取最新），兜底常量是唯一写死的值。

**② 重写 `ensurePortableNode`**

- 签名改 `{ toolRoot, nodeRange, version, onLine, env }`，删除 `isRunnable`；
- 已装版本满足 `nodeRange` 才复用，否则一律替换；
- 下载解压到 `node.download-<pid>`，`node --version` 自检满足 `nodeRange` 后再 rename 覆盖（Windows 走 `node.new-<pid>` → `node.old-<pid>` → 删除），**失败时旧目录保持可用**（旧实现会留下半装状态）。

**③ 连接链**

- `main.js:793` 的 `startArtifactUpdateIfPossible` 拿到 `query.version` 后，再取该版本发布的 `engines.node`（复用 `src/update-manager.js:30` 的 `fetchJson`；失败退回已装产物的 `package.json` 或常量）；
- `ConnectionManager` 新增 `setNodeFloor(spec)`，`resolvedTools({refresh:true})` 前调用，使 `engineOk` 使用运行时下界；
- 失败文案给足三要素：`产物 v0.2.2-rc.5 要求 node >=24.9.0，当前便携版为 v22.19.0，且未能获取 v24.22.3。请检查网络或手动指定 node 路径。`

**④ SSH 远端**：`update.js:634` 改用同一 floor 比较、同一 `resolvePortableNodeVersion`、已有的 `nodeDistArchive` 生成 URL（不再手拼），替换同样走临时目录 + rename。

## 3. 落地步骤

- **第 0 步（止血）**：常量 → `24.22.3`；`update.js:642` 引用常量；`engineOk` 改 `>=24.9.0` 语义并同步三处文案；smoke 里 4 处 `'22.19.0'` 换常量；`ci.yml:36`/`release.yml:83` 的 `node-version: 22` → 24。只修新设备。
- **第 1 步**：新增 `node-engine.js` + 重写 `ensurePortableNode` + 远端同步 → 修 D2。
- **第 2 步**：产物 engines 推导 + `setNodeFloor` + 新文案 → 修 D1/D4。
- **第 3 步（可选）**：结果缓存（`<dshHome>/cache/node-floors.json`，TTL 一天）、选择结果写入服务日志、支持更宽的 semver 区间。

## 4. 验收

1. 干净设备：装到的 node 满足产物要求，`dsh web` 正常运行。
2. registry 不可达：用兜底常量；仍不满足则在**安装前**报出"要求/现状/动作"。
3. 已装 22.19 的设备重连：便携版**自动替换**，无需用户操作。
4. 远端：同一规则生效，替换失败时旧 `.dsh-tools/node` 仍可用。
5. smoke 覆盖：floor 解析与比较、版本选择、原子替换、失败回滚、`childEnv` PATH。
6. **只改 registry 上产物的 `engines.node` 主版本、壳不改代码即可完成升级** —— 这是"彻底"的判据。

## 5. 可单独修 / 待确认

- `childEnv` 把 `.dsh-tools/node/bin` 前置，让 pnpm 始终由壳选定并验证过的 node 启动；
- `pickNode`（`src/tools.js:307`）兜底 `return candidates[0]` 会把不合格 node 返回而不是空串，建议返回 `''`；
- 待确认：dsh 在 22.19 下的**具体**失败方式（本机未实测）、`nodejs.org/dist/index.json` 的 `lts` 字段边界、Windows rename 回滚（需在 `windows-latest` 跑一次 smoke）。

**风险**：触及 7 个模块但都是"新增函数 + 调用点改签名"；唯一行为变化是存量设备多一次约 30–50 MB 的替换下载，服务日志需写明 `便携版 node 升级：v22.19.0 → v24.22.3（产物要求 >=24.9.0）`。
