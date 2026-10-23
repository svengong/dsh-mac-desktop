# dsh-desktop SSH 远程协议（Android/Kotlin 复刻稿）

> 只记录 `src/` 中**已存在**的行为，每条命令都可对照源码核对；引用写作 `文件:函数`。
> 远端命令一律是"本地 ssh 进程把整条字符串交给远端登录 shell"执行：`ssh <opts> <target> '<command>'`。

## 1. SSH 连接参数、认证、保活、隧道

**目标解析**（`ssh.js:parseTarget`）：alias 原样交给 OpenSSH（由 `~/.ssh/config` 决定 HostName/User/Port/IdentityFile/ProxyJump）；自定义串 `[user@]host[:port]` 用**最后一个** `@` 切 user，**最后一个** `:` 之后必须全为数字否则整串非法（IPv6 字面量不支持，`ssh.js:parseTarget` 注释）。

**基础选项**（`ssh.js:sshBase`，所有 ssh 调用共用）：

```
-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new
# 自定义目标带端口时追加： -p <port>
```

- `BatchMode=yes`：禁止交互口令（没配免密就立刻失败，不挂起）；`accept-new`：首次记录 host key，**变了**仍拒绝。
- 执行远端命令（`ssh.js:sshCommandArgs`）：`ssh <base opts> <remote> <remoteCommand>`，stdio 是管道 ⇒ 不申请 TTY。
- 连通性探测（`connection.js:connectSsh`）：远端命令 `echo dsh-ok`，退出码非 0 ⇒ 连接失败。

**隧道**（`ssh.js:tunnelArgs`，`connection.js:startTunnel`）：

```
ssh -N -L <localPort>:127.0.0.1:<remotePort> \
    -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new \
    [-p <port>] <remote>
```

- 本地端口：`ports.js:findFreePort`，从 `settings.ssh.localPort`（默认 3080）起最多 +30，逐个 `127.0.0.1:<p>` TCP connect 探测；`reservePort` 防同壳内抢占。
- 隧道就绪：15s 内本地端口可 connect，每 300ms 轮询（`connection.js:startTunnel`）；成功后写本地隧道 state `{pid,localPort,remotePort}`。
- 断开重连：`TUNNEL_RETRIES=5`，第 n 次延迟 `2000*n` ms，**重新申请本地端口**再建隧道（`connection.js:startTunnel` close watcher）。
- JSch 对照：`setTimeout(10000)`、`setServerAliveInterval(30000)`、`setServerAliveCountMax(3)`、`setPortForwardingL("127.0.0.1", localPort, "127.0.0.1", remotePort)`；`ExitOnForwardFailure` 对应"绑定失败必须报错，不能静默继续"。

## 2. 远端状态文件与 dsh home

远端 home **硬编码为 `$HOME/.dsh`**（`runtime-store.js:REMOTE_*` 常量；`settings.local.dshHome` 只在本地模式使用）：

| 用途 | 远端路径（shell 字面量） |
|---|---|
| 服务状态 | `"$HOME"/.dsh/desktop-web.state.json` |
| pid 文件 | `"$HOME"/.dsh/desktop-web.pid` |
| 端口公告 | `"$HOME"/.dsh/desktop-web.port` |
| 服务日志 | `"$HOME"/.dsh/desktop-web.log` |
| 终端身份 | `"$HOME"/.dsh/.desktop-machine-id`（UUID，首次连接创建，之后只读） |
| 运行时根 | `"$HOME"/.dsh/runtime`（`current` 符号链接 + `manifest.json` + `<token>/`） |
| 构建锁 | `"$HOME"/.dsh/locks/desktop-shell/<lockName>` |

**state JSON schema**（`runtime-store.js:isValidState`）：
`{"pid":<int>,"port":<int>,"version":"<str>","url":"<str>"}` —— `pid`/`port` 必须是整数、`version` 必须是字符串才有效；`url` 可选（旧文件没有）。`version` 是运行时版本 token：`connection.js:serviceVersion` 返回 `~/.dsh/runtime/manifest.json` 的 `current`（`versionToken()` 已去掉冒号，形如 `npm0.2.1-rc.2`），没有可用运行时为 `unknown`；复用要求它与当前版本**字符串相等**。

**写入**（`runtime-store.js:writeRemoteState`）：

```sh
printf '{"pid":%s,"port":%s,"version":"%s","url":"%s"}\n' "<pid>" "<port>" "<ver>" "<url>" > "$HOME"/.dsh/desktop-web.state.json && cat "$HOME"/.dsh/desktop-web.state.json
```

- 末位 `\n` **是必需的**：远端命令被 sentinel 标记包裹、按行解析，无换行会把 JSON 与 END 标记粘在同一行（源码注释明确写 "Trailing \n is load-bearing"）。
- `version` 先按 `[^a-zA-Z0-9._-]` 过滤、截 64 字符；`url` 按 `[^A-Za-z0-9._~:/?#@!&*+,;=%-]` 过滤、截 512 字符（`safeVersion`/`safeUrl`）——因为要放进**双引号**的 printf 参数，`$`、反引号、`"` 会被展开/截断。
- 写后必须 `cat` 回读并比对 `pid`/`port`/`url`，不一致算失败。

**读取**（`runtime-store.js:readRemoteState`）：`cat "$HOME"/.dsh/desktop-web.state.json 2>/dev/null || echo __none__`。删除（`removeRemoteState`）：`rm -f "$HOME"/.dsh/desktop-web.pid "$HOME"/.dsh/desktop-web.state.json "$HOME"/.dsh/desktop-web.port 2>/dev/null || true`。

## 3. 远端命令全集（逐条可抄）

所有 `inner` 都经 `connection.js:remoteRun` 包裹后再交给登录 shell：

```
echo <PAYLOAD_BEGIN>; ( <inner> ); __dsh_rc=$?; echo <PAYLOAD_END>; exit $__dsh_rc
# 完整形式： <loginShell> -l -c '<上面这行，整体单引号转义>'
```

**(a) 判定已有服务是否健康**（`connection.js:connectSsh`）：先 `readRemoteState`，要求 `state.version` 与 `serviceVersion(settings)` **字符串相等**（ssh 模式下后者就是远端 `~/.dsh/runtime/manifest.json` 的 `current`，且 `current/` 下 bin 必须存在，否则 `unknown`），再做 (b)。两者都过才复用；否则进入 (c)/(d)。版本不符而端口能答 ⇒ 说明是旧版/其他 shell 启的实例，按 (c) 清掉重启（Android 客户端可直接复用这条规则：读 `manifest.json` 的 `current` 与 `state.version` 比对）。

**(b) 端口探活（在远端执行）**（`connection.js:remoteProbePort`）：

```sh
body=$(curl -sL --max-time 5 http://127.0.0.1:<port>/ 2>/dev/null); case "$body" in *__DSH_BOOT__*|*"dsh web authentication required"*) echo 1 ;; *) echo 0 ;; esac
```

必须是 `curl -sL`（跟随 303 并把 set-cookie 带回），且 401 认证提示也算"活着"；用 `case` 而不是 `grep -c`（远端登录 shell 常是 zsh，不能依赖管道退出码）。

**(c) 清理/停掉旧服务**（`connection.js:killRemotePids` / `reapRemoteHosts`；按 pid/端口定点清理的 `reapRemoteService` 保留但当前无调用点）：

```sh
kill -0 <pid> 2>/dev/null && echo alive || echo dead      # 存活判定
kill <pid> 2>/dev/null || true                            # 有状态 pid 时直接 TERM
lsof -t -iTCP:<port> -sTCP:LISTEN 2>/dev/null | head -1 || echo 0   # pid 失效时按端口找 LISTEN 者
```

批量清理（`killRemotePids`，一次往返：先采样存活 → `kill` → 每 0.5s 轮询最多 10 次 → `kill -9` → `sleep 0.5`）：

```sh
alive=""; for p in <pids...>; do if kill -0 $p 2>/dev/null; then alive="$alive $p"; fi; done; echo "ALIVE$alive";
for p in <pids...>; do case " $alive " in *" $p "*) kill $p 2>/dev/null ;; esac; done;
for i in 1 2 3 4 5 6 7 8 9 10; do left=0; for p in <pids...>; do case " $alive " in *" $p "*) if kill -0 $p 2>/dev/null; then left=1; fi ;; esac; done; if [ $left -eq 0 ]; then break; fi; sleep 0.5; done;
for p in <pids...>; do case " $alive " in *" $p "*) kill -9 $p 2>/dev/null ;; esac; done; sleep 0.5
```

全机扫描候选（`connection.js:REMOTE_HOST_SCAN`，输出 `pid|是否占用本 home|监听端口`）：

```sh
ps ax -o pid=,command= 2>/dev/null | grep -E "bin\.js +web" | grep -v grep | grep -E "^[[:space:]]*[0-9]+[[:space:]]+([^[:space:]]*/)?node([0-9.]*)?[[:space:]]" | sed -E "s/^[[:space:]]*([0-9]+).*/\1/" | while read p; do uses=$(lsof -Fn -p $p 2>/dev/null | grep -c "^n$HOME/.dsh/"); ports=$(lsof -nP -a -p $p -iTCP -sTCP:LISTEN 2>/dev/null | grep -oE "(127\.0\.0\.1|\[::1\]):[0-9]+" | sed -E "s/.*:([0-9]+)$/\1/" | tr "\n" "," | sed "s/,$//"); echo "$p|$uses|$ports"; done
```

规则：只认 `*node`（`node` 才是真 host，`bash -c "…bin.js web…"` 是包装器，杀掉只会干掉外壳）；只有 `usesHome>0` 才算"我们的"；复用路径用 `keepPid` 保留 state 里记的 host（`reapStrayRemoteHosts`），非复用路径清空本 home 的全部 host（`reapRemoteHosts`）。**只在真的杀到进程时** 才 `sleep 2000`（`if (reaped > 0) await sleep(2000)`）。**注意**：扫描依赖 `ps`/`lsof`，扫描为空时 `reapRemoteHosts` 会退回只杀 state 里记录的 pid。

**(d) 后台启动新服务**（`connection.js:launchRemoteService`）：

```sh
# 先清场（同一次连接）：
<toolchainPrefix> mkdir -p "$HOME"/.dsh; rm -f "$HOME"/.dsh/desktop-web.port "$HOME"/.dsh/desktop-web.pid;
# runNode（注意 $$ 与 exec：pid 文件记录的是真正的 node 进程）：
cd <dir> && BIN=apps/cli/lib/bin.js; [ -f "$BIN" ] || BIN=node_modules/@deepseek-ai/dsh/lib/bin.js;
echo $$ > "$HOME"/.dsh/desktop-web.pid; exec node "$BIN" web --port <0|port> > "$HOME"/.dsh/desktop-web.port 2>> "$HOME"/.dsh/desktop-web.log < /dev/null
# 脱壳（二选一，按 setsid 是否存在）：
if command -v setsid >/dev/null 2>&1; then setsid sh -c '<runNode 单引号转义>' </dev/null >/dev/null 2>&1 &
else nohup sh -c '<runNode 单引号转义>' >/dev/null 2>&1 </dev/null & fi
```

- `<dir>` 是 `connection.js:remoteServiceDir` 的结果：优先 `"$HOME"/.dsh/runtime/current`（activate 后的产物），否则 `remotePath(settings.ssh.remoteRepoDir)`（默认 `"$HOME"/'deepseek-harness'`）。
- `<toolchainPrefix>` = `export DSH_LEFTHOOK_ALLOW_HOOKS_PATH_OVERRIDE=1; export PATH="$HOME"/.dsh-tools/node/bin:"$HOME"/.dsh-tools/node_modules/.bin:"$PATH";`（`ssh.js:remoteToolchainPrefix`）。
- 端口实参：三个调用点（`connection.js:connectSsh`、`restartRemoteService`、`startRemoteService`）全部传 `0`，由 OS 选端口，靠 (e) 回读。stdout 重定向到 `.port`（会被覆盖），stderr 追加到 `.log`。
- **远端不加 `--no-open`**：`--no-open` 只在本地服务里按版本门控（`NO_OPEN_MIN_VERSION='0.1.1-rc.1'`，`connection.js:supportsNoOpen/webArgs`）；远端进程看到 `SSH_CONNECTION/SSH_TTY` 自己跳过开浏览器，加 flag 反而会让老版本 `unknown option` 退出。
- 远端**不用** `service-guard.js`：该守卫（`service-guard.js:main`，stdout 打 `__DSH_SERVICE_PID__:<pid>`，每 1000ms 轮询父 pid）只服务本地 `spawnService({watchParent:true})`（`runner.js:spawnService`）。远端服务因此**故意**在 ssh 断开后继续存活，这正是"下次可复用"的前提。

**(e) 读回公告 URL 并取端口**（`connection.js:launchRemoteService` 等待段）：

```sh
for i in $(seq 1 150); do line=$(tr -d '\r' < "$HOME"/.dsh/desktop-web.port 2>/dev/null | head -1); case "$line" in "dsh web: "*) echo "$line"; exit 0 ;; esac; pid=$(cat "$HOME"/.dsh/desktop-web.pid 2>/dev/null || true); if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then echo service-exited; tail -n 20 "$HOME"/.dsh/desktop-web.log 2>/dev/null; exit 1; fi; sleep 0.2; done; echo port-timeout; exit 1
```

- 总预算 150×0.2s=30s（外层 ssh 超时 60s）。崩溃判定只在 **pid 文件已存在** 且该 pid 已死时成立，避免把"还没 exec"误判为崩溃。
- 解析（`runtime-store.js:parseDshWebUrl`）：正则 `^dsh web:\s+(https?:\/\/\S+)`，随后 `new URL()` 取 `port`，必须 1–65535 ⇒ `{url, port, host}`；行尾 ` (LAN: …)` 由 `\S+` 自然截断。**公告串要原样保留**（可能带 token 查询参数）。
- 读 pid：`cat "$HOME"/.dsh/desktop-web.pid 2>/dev/null || echo 0`；无效则报错，state 不写。

## 4. 启动令牌 URL、303/cookie、401，以及"重宿"

- 服务启动后打印一行 `dsh web: <url>`（`connection.js:launchRemoteService` 用 `parseDshWebUrl` 消费）。0.1.2-alpha 起该 URL 形如 `http://127.0.0.1:<port>/?token=<opaque>`；更旧的版本只有裸 URL（无 token，也就没有 §4 的 401 门）。token **只对签发它的那个进程有效**，服务重启必换。
- 无 token/cookie 请求 `/`：`401` + 正文含 `dsh web authentication required`（`connection.js:probeOnce`）；带正确 token：`303` 重定向到 `/` 并 `set-cookie`（cookie 绑定**请求的 authority**）。
- 因此探活要"跟随重定向并携带上一跳的 set-cookie"（`connection.js:probeOnce`，最多 3 跳，只把 `set-cookie` 的 `k=v` 部分拼进 `cookie`）。
- 判定 token 是否仍被这个活着的服务承认（`connection.js:tokenAccepted`）：单跳 GET，`3xx ⇒ true`，`401/403 ⇒ false`，其它/超时/错误 ⇒ `null`（**不动它**，不要猜"失效"）。
- **重宿**（`connection.js:rehostUrl`）：把公告 URL 的 `protocol` 改为 `http:`、`hostname` 改为 `127.0.0.1`、`port` 改为本地转发端口，**path/search 原样保留**（token 与端口无关，cookie 绑定的是浏览器实际访问的 authority）。交出条件（`connection.js:url`）：公告 URL 的端口必须等于浏览器实际到达的端口（ssh 模式即 `this.localPort`）。重宿按定义使二者相等；重宿失败（URL 非法）或端口不符时退回裸 `http://127.0.0.1:<localPort>`。

## 5. 登录 shell / PATH / sentinel / 换行坑

- **登录 shell 探测**（`connection.js:REMOTE_LOGIN_SHELL_PROBE`，单次往返）：取 `getent passwd "$(id -un)"` 的第 7 列（sshd 真正会执行的 shell），退回 `$SHELL`，再依次试 `/bin/bash /usr/bin/bash /bin/zsh /usr/bin/zsh /bin/sh`，只接受 `bash|zsh|sh|dash|ksh|ksh93|mksh|ash`，输出绝对路径；解析失败/超时 ⇒ `/bin/sh`（`connection.js:parseRemoteLoginShell`），每次连接解析一次并缓存。
- **为什么必须 `-l -c`**：不读 login profile 就拿不到 brew/nvm/fnm 写进 `PATH` 的 node。历史事故（源码注释）：shell 真实登录 shell 是 bash，但机器装了 zsh 就优先用 zsh，zsh 不读 `~/.bashrc` ⇒ `node` 落到系统 v22.11.0 ⇒ `import.meta.main` 不存在 ⇒ CLI 静默 exit 0 无输出，表现为"服务一闪就死"。不要"哪个存在用哪个"。
- **sentinel 载荷隔离**（解析函数另需防"被当成字符串逐字符遍历"：`parseRemoteHostScan`/`parseRemoteProbe` 显式接受 string|string[]，因为空结果意味着"没有要清理的 host"，会放跑孤儿）：`remoteRun` 在命令前后各打一行随机 `__DSH_PAYLOAD_BEGIN_<uuid>__ / __DSH_PAYLOAD_END_<uuid>__`，只保留之间内容 —— 网关/登录 shell 会先喷 `authz success` 这类横幅。`extractPayload` **按子串**匹配而非整行：无换行的输出会和 END 标记粘在同一行，必须切开；找不到 END 时回退原始行（隔离降级，不丢数据）。
- **换行/printf 坑**：state 写入末尾 `\n` 必需（见 §2）；`runner.js:linePump` 专门有 `flush()` 处理"末行无换行"（`printf … > f` 后 `cat f`）；端口文件读取用 `tr -d '\r' | head -1` 防 CRLF；pid 用 `$$ + exec`（`$!` 会记下 setsid 包装器 pid，包装器退出后就被误判为服务已死）。
- **引号与分词坑**：整条远端命令由 `shellQuote` 包在单引号里（`'` → `'\''`），所以命令体内**不能出现单引号**（探活因此用 `case`/`"…"`）；zsh 不对未加引号的变量做分词，`for p in $alive` 只会跑一次 ⇒ 一律用**字面 pid 列表** + `case " $alive "` 判成员。远端路径渲染：`~/x` ⇒ `"$HOME"/'x'`（`ssh.js:remotePath`）。

## 6. 最小远端运行时布局与官方产物安装

- 两种布局（`runtime-layout.js:runtimeLayout`），查找顺序固定：
  1. repo 布局 `<dir>/apps/cli/lib/bin.js`
  2. npm 布局 `<dir>/node_modules/@deepseek-ai/dsh/lib/bin.js`（`NPM_PACKAGE='@deepseek-ai/dsh'`）
- Android 只需这两条 `test -f` 就能定位 bin：

```sh
if test -f <dir>/apps/cli/lib/bin.js || test -f <dir>/node_modules/@deepseek-ai/dsh/lib/bin.js; then echo bin-ok; else echo bin-missing; fi
```

- 生效运行时目录（`runtime-store.js:remoteActiveRuntimeDir`）：`if [ -f "$HOME"/.dsh/runtime/current/apps/cli/lib/bin.js ] || [ -f "$HOME"/.dsh/runtime/current/node_modules/@deepseek-ai/dsh/lib/bin.js ]; then echo "$HOME"/.dsh/runtime/current; else echo __none__; fi`。
- 版本 token：`versionToken("npm:<v>")` 去掉非法字符 ⇒ `npm0.2.1-rc.2`，目录 `~/.dsh/runtime/npm0.2.1-rc.2`；根清单 `~/.dsh/runtime/manifest.json` = `{"current":"<token>","previous":"<token>"}`（`readRemoteRootManifest` / `activateRemoteRuntime`：`cd "$HOME"/.dsh/runtime && ln -sfn <token> current && printf '{"current":"%s","previous":"%s"}' "<token>" "<prev>" > manifest.json`，切换前必须 bin 存在，切换后保留 current+previous 并清理其余版本）。
- **官方产物安装**（`update.js:remoteArtifactPipeline`）：版本来自 `https://registry.npmjs.org/@deepseek-ai/dsh` 的 `dist-tags`，候选 `latest,next,alpha,beta,rc` 取 semver 最大者（`artifact.js:resolveChannelVersion`），然后：

```sh
rm -rf <versionDir> && mkdir -p <versionDir> && <toolchainPrefix> cd <versionDir> && \
  npm install --prefix <versionDir> --no-audit --no-fund --registry <registry> @deepseek-ai/dsh@<version>
# registry 缺省 https://registry.npmjs.org（去掉末尾 /）；校验：
if test -f <versionDir>/node_modules/@deepseek-ai/dsh/lib/bin.js; then echo ok; else echo missing; fi
```

- 自包含工具链（`update.js:ensureRemoteToolchain`）：`<prefix> node --version` 必须满足 `^22.19 || >=24`（`tools.js:engineOk`），否则 `uname -m` 定架构后 `set -e; mkdir -p "$HOME"/.dsh-tools/node "$HOME"/.dsh-tools/tmp; curl -fsSL https://nodejs.org/dist/v22.19.0/node-v22.19.0-linux-<arm64|x64>.tar.gz -o "$HOME"/.dsh-tools/tmp/node.tar.gz; tar -xzf … --strip-components=1 -C "$HOME"/.dsh-tools/node; rm -f …; "$HOME"/.dsh-tools/node/bin/node --version;`；`<prefix> npm install --prefix "$HOME"/.dsh-tools pnpm@<version>`（版本取远端 `package.json` 的 `packageManager`，缺省 `11.7.0`）；最后 `publishRemotePnpm`：`D="$HOME"/.dsh-tools; if [ ! -d "$D"/node/bin ] || [ -e "$D"/node/bin/pnpm ] || [ ! -e "$D"/node_modules/.bin/pnpm ]; then exit 0; fi; ln -s ../../node_modules/.bin/pnpm "$D"/node/bin/pnpm; echo linked;`。
- 安装/切换期间持远端目录锁（`runtime-store.js:withRemoteLock`）：`mkdir` 原子锁 + `owner.json`，2 小时视为陈旧，陈旧回收必须 `mv` 到私有 tombstone 再 `rm -rf`（防两个等待者互相删锁）。

## 7. Android（Kotlin/JSch）最小 adopt-or-launch 序列

1. **连 ssh**：`setTimeout(10000)`、`setServerAliveInterval(30000)`、`setServerAliveCountMax(3)`；跑 `echo dsh-ok`，非 0 即失败（对应 `BatchMode`：没有可用密钥/口令就必须立刻报错）。
2. **探登录 shell**（一次，结果缓存）：执行 `REMOTE_LOGIN_SHELL_PROBE`（§5 原串），取输出首个绝对路径，失败用 `/bin/sh`。
3. **读 state**：`cat "$HOME"/.dsh/desktop-web.state.json 2>/dev/null || echo __none__`；解析并校验（§2）。
4. **adopt 判定**：先过 (a) 的版本门（`state.version` == `manifest.json` 的 `current`，且 `~/.dsh/runtime/current` 下 bin 存在），再执行 (b) 探活该 port（返回 `1` 才算活着）⇒ 建本地转发 `localPort → 127.0.0.1:<remotePort>`，把 `rehostUrl(state.url, localPort)` 交给 WebView。**注意**：只按 (b) 的 `1` 就报 ready 不够——remoteRun 里那段 curl 已经跟随重定向并带上 cookie，客户端必须做同样的事（见 §4），否则 303 的空响应体读不到 `__DSH_BOOT__`。
   - 再单跳 GET 该重宿 URL（`connection.js:tokenAccepted`）：**3xx ⇒ token 仍有效**；**401/403 ⇒ token 已被新进程作废**，跳到第 5 步重启换 token；其它状态/超时/异常 ⇒ `null`，**不判断、不重启**（继续用裸 URL，浏览器可能已有 cookie）。
5. **launch**：`kill` 掉 state 里 pid（若 `kill -0` 活）→ 跑 §3(c) 的 `REMOTE_HOST_SCAN`，对所有 `usesHome>0` 的 pid 执行 §3(c) 的批量 kill → `sleep 2000` → 执行 (d) 的 `setsid/nohup` 启动 → 执行 (e) 等待循环拿到 `dsh web:` 行 → 读 pid 文件 → **写回 state（§2 printf，务必带 `\n`）**。
6. **建隧道 + 重宿**：`rehostUrl(announced, localPort)`；判定就绪用 `GET`（跟随重定向、带 set-cookie），命中 `__DSH_BOOT__` 或 `401 + dsh web authentication required` 都算"服务活着"（后者只说明需要 token）。
7. **运行期看护**：`ready` 状态下每 4000ms 探一次，连续 2 次 `!up || !isDsh` ⇒ 整链重连（`connection.js:startHealthMonitor/healthTick`）；隧道断开按 `2000*n` 重试 5 次并换本地端口。服务自身退出：本地壳重试 3 次（`1000*n` ms），远端没有 close 事件可听，只能靠健康检查。

**必须处理的失败模式**

| 现象 | 判定依据 | 对策 |
|---|---|---|
| ssh 认证/网络/host key 失败 | `echo dsh-ok` 退出码非 0 | 报错，不自动重试（`BatchMode` 语义）；key 变更必须由用户核对 |
| 无运行时 | `bin-missing` / state 无 version | 走 §6 安装，或提示"需在桌面端更新" |
| 端口未公告 | `service-exited` / `port-timeout` | 读 `desktop-web.log` 尾部 20 行报错；不要复用旧 port |
| 端口被非 DSH 占用 | 探活返回 `0` | 不可 adopt；按 (c) 清理后重启 |
| token 失效 | 单跳 GET 得 401/403 | 重启服务换新 token（§7.5） |
| 一个 home 上两个 host | 扫描出现 `usesHome>0` 且 `pid != keepPid` | 保留 state 记的那个，其余 `kill`（否则抢 session store/task-board 锁） |
| 远端缺 `lsof`/`curl`/`setsid` | 命令空输出/非 0 | 退化到"只按 state pid 杀"、用 `nohup` 兜底；探活用 HTTP 客户端代替 curl |

## 8. 常量速查

`PROBE_INTERVAL_MS=750`、`READY_TIMEOUT_MS=90000`、`SERVICE_RETRIES=3`、`TUNNEL_RETRIES=5`、`HEALTH_INTERVAL_MS=4000`、`HEALTH_FAILURE_THRESHOLD=2`、`PEER_WAIT_ATTEMPTS=6`/`PEER_WAIT_INTERVAL_MS=1000`（`connection.js` 顶部）；`REMOTE_LOCK_STALE_MS=2h`、`LOCK_RETRY_MS=250`（`runtime-store.js`）；`NO_OPEN_MIN_VERSION='0.1.1-rc.1'`（本地启动门控）；`PORT_SCAN_SPAN=30`（`ports.js`）。
