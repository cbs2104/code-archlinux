# Linux 平台适配说明

DeskPet 只面向 **Linux**（X11 / XWayland，含 Arch、Debian、Fedora 等）。

## 能力矩阵

| 能力 | Linux X11 / XWayland | Linux 原生 Wayland |
| --- | --- | --- |
| 透明无边框窗口 | ✅（需合成器） | ⚠️ 合成器差异 |
| 窗口移动 / 自由拖放 | ✅ | ❌ |
| 始终置顶 | ✅ | ⚠️ |
| 全局键盘/鼠标事件 | ✅ libXtst | ⚠️ 仅 XWayland 应用 |
| 全局快捷键 | ✅ | ⚠️ 通常不可用 |
| 系统 TTS | ✅ speech-dispatcher | 同左 |
| 麦克风 | ✅ | ✅ |
| 开机自启 | ✅ `~/.config/autostart` | 同左 |
| 打包目标 | AppImage / deb / rpm / pacman / Flatpak | 同左 |

## Linux

### Wayland 与 XWayland

桌宠需要：

1. 透明窗口；
2. 由程序设置窗口位置（自由拖动、漫游）；
3. 读取全局键鼠（uiohook/libuiohook 基于 X11）；
4. 全局快捷键。

原生 Wayland 禁止客户端自行定位窗口，全局输入也有协议限制。因此应用默认运行在 **XWayland**：

- `npm run dev` / `npm start` 使用 `scripts/dev.mjs`，通过 electron-vite 的 `--` 把 `--ozone-platform=x11` 作为真实 Electron CLI 参数传入。
- Linux 桌面入口由 `linux.executableArgs` 带上 `--ozone-platform=x11`。
- 直接运行 `electron .`、未安装的二进制或 AppImage 时，主进程检测到 Wayland + `DISPLAY` 且没有该参数，会以 `--ozone-platform=x11` 通过 `spawn` 自动重启一次。

必须放在启动命令行：`app.commandLine.appendSwitch('ozone-platform', 'x11')` 在 Chromium/Ozone 初始化之后执行，**不能**改变当前进程的窗口后端。此前正是这个原因导致 GNOME 下创建了不可见/无法定位的原生 Wayland 窗口。

如果坚持原生 Wayland：

```bash
DESKPET_OZONE_PLATFORM=wayland npm run dev
```

此时窗口位置由合成器决定，拖拽/自动漫游会失效；设置页会显示输入监听警告（`sessionType: wayland`）。不推荐用于桌宠。

### 依赖（Arch）

```bash
sudo pacman -S --needed libxtst speech-dispatcher
```

- `libxtst`：libuiohook 的 X11 依赖；
- `speech-dispatcher`（或 `espeak-ng`）：系统 TTS；
- 文件选择、麦克风等走 Chromium 自带实现，无需额外包；
- 构建 pacman 包需要 `fakeroot`，且 electron-builder 的 fpm 自带 Ruby 依赖 `libcrypt.so.1`；在 Arch 上请安装 `libxcrypt-compat`，否则使用 `npm run dist:linux:appimage`。
- AppImage 需要 `fakeroot`、`libarchive-tools`（或 `binutils`）。

### Flatpak

```bash
flatpak install --user flathub org.gnome.Platform//50
npm run dist:linux:flatpak
flatpak install --user release/DeskPet-<version>-x86_64.flatpak
flatpak run com.deskpet.app
```

- 使用 `org.gnome.Platform/x86_64/50` 运行库，不需要 `flatpak-builder`；
- 权限：X11/XWayland、`ipc`、PulseAudio、GPU、网络、`home`、自动启动目录、通知、StatusNotifier 托盘、门户；
- 沙箱内 Electron 使用 `--no-sandbox`，由 Flatpak 提供外层隔离；
- 数据目录：`~/.var/app/com.deskpet.app/config/DeskPet/`。

### 桌面环境

- KDE Plasma（X11 或 Wayland + XWayland）：透明、置顶、托盘均正常。
- GNOME：Wayland 下同样走 XWayland；托盘图标需要 AppIndicator 扩展（GNOME 默认不显示托盘）。「显示在所有桌面 / 全屏应用之上」默认开启，XWayland 下会设置 `_NET_WM_STATE_STICKY` / `_NET_WM_DESKTOP=-1`，切换工作区后桌宠仍可见；关闭后它只留在原工作区。
- i3 / bspwm 等：建议开启 picom 合成器，否则透明与阴影异常。
- 无托盘实现的 WM：仍可通过快捷键 / 右键桌宠 / `--settings` 启动设置。

## 打包环境

| 目标 | 推荐构建系统 | 备注 |
| --- | --- | --- |
| AppImage / deb / rpm / pacman | Linux | CI 使用 `ubuntu-latest`；pacman 需要 fakeroot |

CI 中 Linux 只显式构建 AppImage + deb，避免 Ubuntu 缺少 pacman 打包依赖；在 Arch 上执行 `npm run dist:linux` 会构建全部 Linux 目标。

## 图标

- 源文件：`build/icon.svg`
- 已生成：`build/icon.png`（1024）
- 托盘使用 `build/icon.png`（开发）或 `process.resourcesPath/icon.png`（打包后，由 `extraResources` 提供）。
