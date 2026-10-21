# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [1.1.0] - 2025-10-20

### 变更

- **桌宠可自由放置**：拖动到桌面任意位置后停在原地，不再自动落回屏幕底部；位置会保存，重启后恢复。自动溜达改为在当前高度水平移动。
- **项目范围改为 Linux-only**：移除 Windows / macOS 构建目标、平台分支、图标与文档；`electron-builder` 只保留 Linux 的 AppImage / deb / rpm / pacman，GitHub Actions 只构建 Linux。
- 新增 Flatpak 打包脚本 `scripts/build-flatpak.sh` 与 `npm run dist:linux:flatpak`，生成单文件 `.flatpak`。
- 移除桌宠右侧的悬浮聊天/设置/隐藏按钮，只保留右键功能菜单；右键桌宠或透明区域即可打开聊天、打招呼、设置、换位置、隐藏、退出。
- 点击穿透默认关闭，设置页仍可手动开启；指针进入桌宠时暂停自动溜达。

## [1.0.3] - 2025-10-20

### 修复

- **点击桌宠没有反应**：把「透明区域可以点穿」改为**默认关闭**，整个桌宠窗口默认接收鼠标，避免依赖 40ms 光标轮询才能点击。配置版本升级到 3，旧配置自动迁移为关闭；需要透明区域点穿时可在设置里重新打开。
- 指针进入桌宠时暂停自动溜达，避免用户瞄准时桌宠自己走开。
- 设置页提示补充：如果开启点穿后点击不灵敏，请关闭该项。

## [1.0.2] - 2025-10-20

### 修复

- **桌宠切换工作区后消失**：Linux 现在真正应用「显示在所有桌面 / 全屏应用之上」（`setVisibleOnAllWorkspaces`）；设置默认开启，`version: 1` 的旧配置会自动迁移为开启。桌宠的 `_NET_WM_DESKTOP` 变为 `-1`（Sticky），切换 GNOME 工作区仍可见。
- **窗口显示后重新应用置顶**：`showInactive()` 后再次调用 `setAlwaysOnTop` + `moveTop()`，避免 Electron 在映射窗口时丢失置顶状态；拖动/漫游/打开设置后仍保持在普通窗口之上。
- **点击穿透兜底**：渲染进程在指针进入桌宠时立即调用 `setInteractive(true)`，主进程同步解除 `setIgnoreMouseEvents`，不再完全依赖 40ms 的全局光标轮询。
- **设置页开关点不动**：开关的 `<input type="checkbox">` 被样式设成 0×0，实际点击落在装饰性的滑块上，所有 toggle 都无法切换。现在 input 铺满整个 switch（`position:absolute; inset:0`），可以直接关闭「显示在所有桌面」「透明区域可以点穿」等选项。
- 设置页提示更新为 Linux。

## [1.0.1] - 2025-10-20

### 修复

- **GNOME / Wayland 下窗口不可见**：Electron 的 `app.commandLine.appendSwitch('ozone-platform', …)` 在 Chromium 初始化之后才执行，导致应用仍然创建原生 Wayland 窗口；原生 Wayland 不允许桌宠自行定位，在这台 GNOME 上窗口也没有正常呈现。
  - 现在启动时会检测 Wayland + `DISPLAY`，并通过真实的命令行参数 `--ozone-platform=x11` **自动重新启动一次**（AppImage、`electron .`、打包二进制均适用）。
  - `npm run dev` / `npm start` 改为 `scripts/dev.mjs` 启动器，通过 electron-vite 的 `--` 转发参数，不再触发额外重启。
  - Linux 桌面入口通过 `linux.executableArgs` 直接带上 `--ozone-platform=x11`。
- 首次启动（没有 `config.json`）自动打开设置窗口；重复启动应用时也会打开设置窗口，避免找不到主界面。
- 桌宠/设置窗口增加 `ready-to-show` 超时兜底显示，GPU/合成器异常时也不会留下不可见窗口。
- Linux 下使用 XWayland 后，全局快捷键可以正常注册（此前在原生 Wayland 下失败）。

### 说明

- GNOME 桌面需要 XWayland（默认已安装）；如果坚持原生 Wayland，可设置 `DESKPET_OZONE_PLATFORM=wayland`，但拖拽、漫游和任意定位会失效。
- 更新后重新 `npm install` 或至少重新 `npm run build` / 重新打包，旧的 AppImage 仍是修复前的行为。

## [1.0.0] - 2025-10-20

首个完整版本。

### 新增

- **抠图工坊**：导入图片、自动去背景、最大连通域保留、矩形/套索圈选、魔术棒、橡皮、羽化、裁剪、反选、撤销/重做、拖拽导入。
- **多桌宠管理**：新建、切换、重命名、复制、删除、导出/导入桌宠包、修改见面台词。
- **内置 SVG 桌宠**「小奶糕」：眨眼、瞳孔跟随鼠标、尾巴摆动、表情、睡眠 Zzz。
- **透明桌宠窗口**：置顶、点击穿透（基于真实命中区域）、拖拽/抛掷/落地弹跳、自动漫游、待机睡眠。
- **键盘鼠标联动**：uiohook 全局按键/点击/滚轮 + 光标轮询，支持打字、回车、Esc、Ctrl/Cmd+S、靠近等触发。
- **动作系统**：13 种触发条件、10 种动画、序列帧、精灵图切分、动作音效/配音、冷却、情绪标记、实时测试、恢复默认。
- **语音**：系统 TTS（音色/语言/语速/音调/音量）、动作台词朗读、Whisper 兼容语音输入。
- **AI**：OpenAI 兼容接口、流式回复、预设（OpenAI/DeepSeek/Moonshot/百炼/Ollama/LM Studio）、可编辑人格、聊天记忆、情绪标记、连接测试。
- **系统集成**：托盘菜单、全局快捷键、单实例、开机自启、记住位置、所有工作区/全屏置顶。
- **工程化**：Electron 44 + electron-vite 6 + Vite 7 + TypeScript 严格模式；`contextIsolation`、来源校验、CSP、自定义资源协议、safeStorage、日志轮转。
- **打包**：Linux AppImage/deb/rpm/pacman；GitHub Actions 自动构建与 tag 发布。
- 文档：README、架构、桌宠包格式、平台差异、贡献与安全说明；SVG 图标与 banner。

### 已知限制

- 原生 Wayland 下无法程序化移动窗口或可靠捕获原生 Wayland 应用键盘；默认走 XWayland。
- 桌宠包导出为文件夹（未内置 zip）。

[1.1.0]: https://github.com/DeskPet/DeskPet/releases/tag/v1.1.0
[1.0.3]: https://github.com/DeskPet/DeskPet/releases/tag/v1.0.3
[1.0.2]: https://github.com/DeskPet/DeskPet/releases/tag/v1.0.2
[1.0.1]: https://github.com/DeskPet/DeskPet/releases/tag/v1.0.1
[1.0.0]: https://github.com/DeskPet/DeskPet/releases/tag/v1.0.0
