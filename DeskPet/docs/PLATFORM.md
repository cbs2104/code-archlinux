# 平台适配说明

DeskPet 目标平台：Windows 10/11、Linux（X11 / XWayland，含 Arch）、macOS 12+。

## 能力矩阵

| 能力 | Windows | macOS | Linux X11 / XWayland | Linux 原生 Wayland |
| --- | --- | --- | --- | --- |
| 透明无边框窗口 | ✅ | ✅ | ✅（需合成器） | ⚠️ 合成器差异 |
| 窗口移动 / 抛掷 | ✅ | ✅ | ✅ | ❌ |
| 始终置顶 | ✅ | ✅ | ✅ | ⚠️ |
| 全局键盘/鼠标事件 | ✅ | ✅ 辅助功能 | ✅ libXtst | ⚠️ 仅 XWayland 应用 |
| 全局快捷键 | ✅ | ✅ | ✅ | ⚠️ 通常不可用 |
| 系统 TTS | ✅ SAPI | ✅ | ✅ speech-dispatcher | 同左 |
| 麦克风 | ✅ | ✅ 授权 | ✅ | ✅ |
| 开机自启 | ✅ 注册表 | ✅ 登录项 | ✅ `~/.config/autostart` | 同左 |
| 打包目标 | NSIS / portable | dmg / zip | AppImage / deb / rpm / pacman | 同左 |

## Linux

### Wayland 与 XWayland

桌宠需要：

1. 透明窗口；
2. 由程序设置窗口位置（漫游、拖拽、抛掷）；
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

### 桌面环境

- KDE Plasma（X11 或 Wayland + XWayland）：透明、置顶、托盘均正常。
- GNOME：Wayland 下同样走 XWayland；托盘图标需要 AppIndicator 扩展（GNOME 默认不显示托盘）。「显示在所有桌面 / 全屏应用之上」默认开启，XWayland 下会设置 `_NET_WM_STATE_STICKY` / `_NET_WM_DESKTOP=-1`，切换工作区后桌宠仍可见；关闭后它只留在原工作区。
- i3 / bspwm 等：建议开启 picom 合成器，否则透明与阴影异常。
- 无托盘实现的 WM：仍可通过快捷键 / 右键桌宠 / `--settings` 启动设置。

## Windows

- 透明窗口、置顶、点击穿透、uiohook、快捷键、托盘均无额外权限。
- 安装包：NSIS（可选安装目录、桌面/开始菜单快捷方式）与 portable。
- 未签名安装包会触发 SmartScreen；正式发布建议配置代码签名证书（`CSC_LINK` / `CSC_KEY_PASSWORD`）。
- 部分安全软件会拦截全局键盘钩子；需将 DeskPet 加入白名单。

## macOS

- 应用以 accessory 方式运行（隐藏 Dock 图标），通过托盘菜单与桌宠交互。
- **辅助功能权限**：首次启用键盘监听时，`systemPreferences.isTrustedAccessibilityClient(true)` 会弹出系统提示；用户需在「系统设置 → 隐私与安全性 → 辅助功能」勾选 DeskPet。未授权时鼠标跟随仍可用，键盘事件无效。
- 麦克风需要在 `NSMicrophoneUsageDescription` 中声明（`electron-builder.yml` 已配置），首次录音系统会询问。
- 全屏应用之上显示：启用「显示在所有桌面 / 全屏应用之上」，使用 `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`。
- 构建：dmg/zip 必须在 macOS 上生成；未签名时用户需右键 →「打开」。正式发布建议使用 Apple Developer ID 与公证（notarize）。

## 打包环境

| 目标 | 推荐构建系统 | 备注 |
| --- | --- | --- |
| Windows | Windows（或 Linux + Wine） | CI 使用 `windows-latest` |
| macOS | macOS | dmg 与签名只能在 macOS 上 |
| Linux AppImage/deb/rpm/pacman | Linux | CI 使用 `ubuntu-latest`；pacman 需要 fakeroot |

CI 中 Linux 只显式构建 AppImage + deb，避免 Ubuntu 缺少 pacman 打包依赖；在 Arch 上执行 `npm run dist:linux` 会构建全部 Linux 目标。

## 图标

- 源文件：`build/icon.svg`
- 已生成：`build/icon.png`（1024）、`build/icon.ico`（256…16）
- macOS：`npm run icons` 在 macOS 上会用 `iconutil` 生成 `icon.icns`；electron-builder 也可以从 PNG 自动转换。
- 托盘使用 `build/icon.png`（开发）或 `process.resourcesPath/icon.png`（打包后，由 `extraResources` 提供）。
