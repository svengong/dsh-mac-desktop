# dsh-desktop

English | [中文](README.zh.md)

A desktop shell for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web app on **macOS, Windows and Linux**, modeled on VS Code Remote Development. Double-click the app icon and the harness web UI is reachable at `http://127.0.0.1:<port>` — from a **local instance** or from a **remote machine over SSH**.

The shell is a **thin wrapper**: it loads a fixed URL and only ever runs git/pnpm on the harness repo. Upgrading the harness never touches the shell — after an update it just reloads the page.

## Platforms

| Platform | Architectures | Installers |
|---|---|---|
| macOS 11+ | Apple Silicon (`arm64`) | `.dmg` |
| Windows 10/11 | `x64`, Windows on ARM (`arm64`) | NSIS `-setup.exe` |
| **Android 8.0+** | `arm64-v8a` | `.apk` (phone portrait + tablet landscape) |

The release workflow publishes exactly that set — one installable artifact per
architecture, with no zip or portable variants and no Intel Mac build. Linux
still builds and runs from the same source tree (see [Quick start](#quick-start))
but is no longer a published target.

Every desktop build is unsigned, so the OS may ask for confirmation on first
launch. The Android client is a separate native app — see
[android/README.md](android/README.md).

## Highlights

- **Silent resident deployment, local or SSH-remote** — connect and the harness **resident daemon (`dsh web`) is deployed and kept up to date automatically**: the shell installs the official npm artifact, starts and restarts the service, and upgrades it to the current version on every reconnect — no shell access, no manual steps. The remote needs **no system toolchain**: a portable node is bootstrapped into `~/.dsh-tools` on the remote automatically.
- **Multi-window, VS Code Remote style** — the first window restores and connects the current terminal; new windows open on the connection page without auto-connecting; each terminal keeps at most one bound window: connecting to an already-open terminal only switches to that window and leaves the current window untouched, while every other action stays in the current window.
- **Update-friendly** — official prebuilt artifacts preferred; versioned runtimes with atomic switch and automatic rollback; updates survive shell quit (detached worker), resume after a crash, and can be safely cancelled when switching terminals.

## Features

- **Local mode**: serves the harness from the official `~/.dsh` by default (the same workspace as a terminal `dsh`), or any isolated directory set in the preferences.
- **SSH remote mode**: pick a host from `~/.ssh/config` (HostName/User/Port/IdentityFile/ProxyJump/Include all apply) or enter `[user@]host[:port]`; keeps the `ssh -N -L` tunnel alive with reconnection, starts/stops the remote service over ssh. Requires passwordless key login.
- **In-shell loading panel**: live status and logs while connecting/building/updating, with retry actions on failure.
- **Tray/status area**: status, pending update count, and update management without opening a window.
- **Native-feeling UI per platform**: macOS traffic lights or Windows caption buttons integrated into a single 46px shell frame; embedded settings panels, light/dark appearance, per-device settings and update sources.
- **Data isolation**: development builds and custom dsh homes stay independent, and the shell's own settings/logs never touch the installed app's data.
- **Startup auto-check**: notifies when updates are available (deduplicated per launch, per device).

## Android (phone and tablet)

`android/` is a native Android client for the same product idea (Kotlin + Compose
+ WebView + JSch) — not the desktop shell running on a phone:

- **SSH remote**: connect to a Linux box from the phone, automatically **reuse or
  start** the remote `dsh web`, forward a loopback port over JSch, and render the
  harness UI through it. It speaks the same protocol as the desktop shell, so the
  two can share one resident service.
- **Direct URL**: paste a URL you can already reach (reverse proxy, LAN). No SSH,
  no managed service.
- **Adaptive layout**: phone portrait is a single column (terminal list ⇄
  full-screen harness); tablet landscape is two panes (persistent terminal rail +
  harness). Decided from the *window* width, so split-screen falls back to one
  column.
- **Background survival**: a foreground service holds the connection so the
  tunnel survives backgrounding; once ready the service is probed every 4s and
  reconnected after two consecutive failures.
- **WebView compatibility shim**: `Promise.withResolvers`, `AbortSignal.any` and
  friends are injected at document start, so Chromium 99+ devices work; anything
  older gets a clear message instead of a blank page.

See [android/README.md](android/README.md).

## Quick start

### macOS

```sh
bash scripts/build.sh
bash scripts/install.sh
open '/Applications/DeepSeek Harness.app'
```

### Windows

```powershell
# builds the x64 AND arm64 installers
powershell -ExecutionPolicy Bypass -File scripts\build-win.ps1

# or one architecture only
npm run dist:win:x64        # dist:win:arm64 for Windows on ARM
```

Then run `dist\dsh-desktop-<version>-windows-<arch>-setup.exe` to install.
The installer is the only Windows artifact published — there is no portable or
zip variant.

### Android

```sh
cd android
./gradlew :app:assembleRelease   # → app/build/outputs/apk/release/app-release.apk
```

Requires JDK 17 and the Android SDK; see [android/README.md](android/README.md).

### Release surface

Each platform ships exactly one installable artifact per supported
architecture:

| Platform | Architectures | Artifact |
|---|---|---|
| macOS | arm64 | `.dmg` |
| Windows | x64, arm64 | `-setup.exe` (NSIS) |
| Android | arm64 | `.apk` |

Pushing a `v*` tag builds and publishes exactly that set; Linux is not
published.

Note the arch spelling differs per format: `${arch}` expands to `x86_64` for
AppImage and `amd64` for deb (`arm64` is `arm64` in both), so an x64 build
produces `…-linux-x86_64.AppImage` and `…-linux-amd64.deb`.

### Any platform (development)

```sh
npm install
npm start
```

First launch opens connection settings: pick **本地** (local) or **SSH 远程** (remote), then **保存并连接**. The first connection installs the official runtime and starts it automatically; routine upgrades go through the **更新** menu afterwards.

> Preconfigure an SSH device for a hands-off first launch on macOS:
>
> ```sh
> bash scripts/install.sh --ssh <your-ssh-alias>
> ```

## Development

```sh
npm run smoke                    # Electron-free module tests (all platforms)
DSH_DESKTOP_SMOKE=1 npx electron .   # macOS/Linux in-app smoke
npx electron .                   # run the shell
```

On Windows use PowerShell and the same commands; `DSH_DESKTOP_SMOKE` works as
`$env:DSH_DESKTOP_SMOKE=1; npx electron .`.

## Documentation

- [Architecture](docs/architecture.md) — module map, ports & processes, resident auto-upgrade, packaging/release.
- [Requirements](docs/requirements.md) — functional requirements, edge cases, acceptance criteria.
- [Development](docs/development.md) — development conventions, testing, release verification.
- [Agent](docs/agent.md) — invariants and pitfalls for coding agents.
- [Roadmap](docs/roadmap.md) — phase overview; mobile (phone-over-SSH to Linux) plan.

## Known limitations

- Builds are unsigned on every platform (macOS Gatekeeper / Windows SmartScreen may ask to confirm on first launch).
- SSH mode requires key-based auth; password prompts cannot work without a terminal.
- The local-mode service log only covers shell-owned processes.
- On Windows the "does this process use my dsh home?" check uses the process command line's runtime path instead of `lsof` open files; when it cannot tell, the shell leaves the process alone.
- Linux packages build and pass CI (AppImage + deb, x64/arm64), but the `titleBarOverlay` caption strip has only been exercised on a build host — real GNOME/KDE desktops are still unverified.
