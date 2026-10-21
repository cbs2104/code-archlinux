![DeskPet banner](docs/assets/banner.svg)

# DeskPet · 桌面小搭档

一个用 **Electron + TypeScript** 写的 **Linux 桌宠**：把任意图片里的角色抠出来放到桌面上，让它对键盘、鼠标、AI 回复做出反应，支持自定义序列帧动作、音效、系统语音，并通过 AppImage / Flatpak / deb / rpm / pacman 运行在 Linux 上。

> 不是玩具 demo：包含完整的抠图工坊、动作编辑器、全局输入监听、AI 流式对话、语音合成/识别、托盘、单实例、配置持久化、Linux 打包配置与 GitHub Actions。
>
> **平台范围**：只维护 Linux（X11 / XWayland）；Windows / macOS 的构建目标、平台分支和文档已移除。
>
> **GitHub 提示**：把 `DeskPet/` 作为仓库根目录（或把其中的 `.github/` 移到仓库根）推送到 GitHub，即可使用内置 Actions。若仓库地址/名称不同，请同步替换 `package.json` 的 `homepage`、README 与「关于」页里的 `https://github.com/DeskPet/DeskPet`。

---

## 目录

- [功能](#功能)
- [截图与界面](#截图与界面)
- [快速开始](#快速开始)
- [使用指南](#使用指南)
- [接入 AI](#接入-ai)
- [语音与自定义配音](#语音与自定义配音)
- [键盘--鼠标联动](#键盘--鼠标联动)
- [打包](#打包)
- [版本产物保留](#版本产物保留)
- [项目结构](#项目结构)
- [数据与隐私](#数据与隐私)
- [Linux 平台说明与已知限制](#linux-平台说明与已知限制)
- [常见问题](#常见问题)
- [贡献与许可](#贡献与许可)

---

## 功能

### 自定义桌宠形象

- **导入图片 → 用户圈选 → 自动抠图**：
  - 自动抠图：从四边识别背景色并去除，只保留最大的主体；
  - 矩形选框 / 套索：圈出目标后「保留选区」「删除选区」「裁剪到选区」「反选保留」；
  - 魔术棒按颜色去背景（可调容差）、橡皮手动修补、羽化边缘、裁剪透明空白；
  - 撤销 / 重做 / 还原原图；支持拖拽图片进窗口。
- 保存为透明 PNG（最长边 1024px），可新建多个桌宠并随时切换。
- 内置一只由 SVG 实时绘制的小猫「小奶糕」：会眨眼、瞳孔跟随鼠标、尾巴摆动、睡眠 Zzz、切换表情，不依赖任何外部素材。

### 桌面行为

- 透明、无边框、置顶窗口；以 Linux `toolbar` 窗口类型运行，不会出现在任务栏/分页器，也不会被最小化成普通应用窗口。默认整个窗口接收鼠标，可在设置里开启「透明区域可以点穿」。
- **可以拖动到桌面任意位置并停在那里**，松手后 60 秒内不会自动溜达；如果开启自动溜达，会在当前高度水平走动。
- 待机一段时间会睡觉，键盘/鼠标一动就醒。
- 智能体始终在屏幕内，跑丢了可从托盘或设置里「回到右下角」。
- 系统托盘：显示/隐藏、打招呼、聊天、设置、重置位置、开机自启、退出。
- 单实例、记住位置、开机自启（写入 `~/.config/autostart/deskpet.desktop`，登录后直接显示桌宠）。

### 键盘 / 鼠标联动

通过 [`uiohook-napi`](https://github.com/SnodsMe/uiohook-napi)（N-API 预编译，无需 electron-rebuild）读取**全局**输入事件类型：

- 打字、回车、Esc、Ctrl+S、鼠标点击、滚轮；
- 鼠标靠近打招呼、眼睛跟随鼠标；
- 每个事件都可以在「动作与声音」里绑定任意动作；
- 只统计事件类型和数量，**不记录输入内容**（隐私友好）。

### 动作、序列帧与音效

- 可视化动作编辑器：触发条件、动画效果、时长、冷却、气泡台词、情绪标记。
- **自定义动作**：导入多张序列帧图片，或导入精灵图并按行列自动切分（自动跳过全透明格）。
- 每个动作可绑定 MP3/WAV/OGG/M4A 等音效作为角色配音。
- 触发条件：单击/双击桌宠、被拖动、落地、打字、回车、Esc、保存快捷键、滚轮、鼠标靠近、离开电脑、AI 回复、仅手动。
- 动作可以在设置里实时「在桌面上测试」。
- 一键恢复内置默认动作；动作随桌宠包导出/导入。

### AI 伙伴

- 任意 **OpenAI 兼容** 接口：OpenAI、DeepSeek、Moonshot、阿里云百炼（通义）、Ollama、LM Studio、自定义。
- 流式输出（SSE）逐字显示；可关闭流式。
- 桌宠人格提示词可编辑，自动附加名字与当前时间；回复里的 `[[happy]]` 等情绪标记会切换表情并被隐藏。
- 聊天窗口集成在桌宠窗口内，不额外弹一个大窗口。
- 支持 **Whisper 兼容语音识别**：聊天窗口点 🎤 录音 → `/audio/transcriptions` → 自动填入输入框。
- AI 与聊天记录默认关闭/本地保存；API Key 在系统支持时用 `safeStorage` 加密后落盘。

### 语音

- 系统 TTS：选择系统音色、语言、语速、音调、音量，朗读 AI 回复或动作台词。
- 每个动作可以用自定义音频做角色配音，音量独立。
- 语音输入按钮复用 AI 的 Whisper 设置。

### 工程化

- Electron 44 + Vite 7 + electron-vite 6 + 严格 TypeScript。
- 主进程 / preload / 渲染进程分离，`contextIsolation: true`、`nodeIntegration: false`，所有 IPC 校验来源。
- 自定义 `deskpet://` 协议安全提供桌宠资源，路径穿越防护。
- Linux `electron-builder` 配置：AppImage / deb / rpm / **pacman**（Arch），另有 Flatpak 打包脚本。
- GitHub Actions 自动类型检查、构建和 Linux 打包。

---

## 截图与界面

| 位置 | 说明 |
| --- | --- |
| 桌面 | 透明桌宠 + 气泡对话 + 右键功能菜单 |
| 聊天面板 | 桌宠窗口向上展开，深色玻璃面板、流式回复、语音输入 |
| 设置窗口 | 侧边栏 7 个页面：我的桌宠 / 抠图工坊 / 动作与声音 / 语音 / 互动与快捷键 / AI 伙伴 / 关于 |
| 托盘菜单 | 显示隐藏、聊天、打招呼、设置、回右下角、开机自启、退出 |

> 仓库没有放真实截图，避免二进制截图文件。banner 是纯 SVG；运行 `npm run dev` 即可看到界面。

---

## 快速开始

### 环境要求

- Node.js **20.19+**（推荐 22 或 24 LTS）
- npm 10+（项目包含 `package-lock.json`，CI 使用 `npm ci`）
- **Linux**（Arch / Debian / Fedora 等），X11 或带 XWayland 的 Wayland 桌面
- 建议安装 `libxtst`（全局输入）与 `speech-dispatcher`（TTS）

### 开发运行

```bash
cd DeskPet
npm install
npm run dev
# 或者启动时同时打开设置窗口：
npm run dev -- --settings
```

`npm run dev` 会启动 Vite + Electron 并打开桌宠窗口；**首次启动（没有 `config.json`）会自动打开设置窗口**。

> 如果你的 npm 版本默认阻止安装脚本，导致 Electron 可执行文件没有下载，可以运行 `npx electron --version` 触发下载，或执行 `npm rebuild electron`。`uiohook-napi` 自带 Linux 预编译 N-API 二进制，不需要 `electron-rebuild`。
>
> **GNOME / Wayland 用户**：请使用 `npm run dev`（内置启动器会把 `--ozone-platform=x11` 作为真实命令行参数传给 Electron）。如果直接运行 `electron .` 或 AppImage，程序会自动用 XWayland 重新启动一次。详见[常见问题](#看不到桌宠或设置窗口)。

### 构建（不打包安装程序）

```bash
npm run typecheck   # 主进程 + 渲染进程严格类型检查
npm run build       # 输出到 out/
npm start           # 预览生产构建
```

### 常用启动参数

| 参数 | 作用 |
| --- | --- |
| `--hidden` / `--start-hidden` | 启动时不显示桌宠（只留在托盘/设置）；**开机自启不附加此参数** |
| `--settings` / `--open-settings` | 启动时直接打开设置窗口 |
| `DESKPET_OZONE_PLATFORM=x11` | Linux 强制使用 XWayland（Wayland 会话有 DISPLAY 时的默认行为） |
| `DESKPET_OZONE_PLATFORM=wayland` | Linux 不自动重启，直接使用原生 Wayland（拖拽/漫游/精确定位会失效；不推荐） |

`--ozone-platform=x11` 会由启动器/桌面入口传入；直接运行 `electron .` 或 AppImage 时会由主进程自动带参数重启一次。

---

## 使用指南

### 1. 把图片里的角色变成桌宠

1. 双击托盘图标或右键桌宠 →「设置…」，进入 **抠图工坊**。
2. 点「选择图片」（也可以直接把图片拖进编辑区）。支持 PNG / JPG / WebP / GIF / BMP，超大图会先缩到 1400px 再处理。
3. 点 **🪄 自动抠图**：
   - 从四边采样背景色并向内泛洪去除；
   - 只保留面积最大的不透明主体；
   - 自动裁掉透明边。
4. 如果边缘不干净：
   - **魔术棒**：点背景，按容差继续去色；
   - **橡皮**：手动擦掉残渣；
   - **矩形 / 套索**：圈出多余部分 →「删除选区」；圈出目标 →「保留选区」；「反选保留」用于反过来操作；
   - **羽化边缘**：让边缘更柔和。
5. 右边预览会实时显示将要保存的尺寸；点 **创建新桌宠**，取名即可。
6. 想换掉已有自定义桌宠的形象：在「替换已有桌宠的形象」里选目标，再点按钮；动作和语音会保留。内置「小奶糕」是程序绘制的，不能替换。

> 抠图结果会保存为透明 PNG，最长边 1024px；原始图片不会上传到任何服务器。

### 2. 管理桌宠

「我的桌宠」页面：

- 卡片列表切换当前桌宠；缩略图直接预览。
- 修改见面台词；重命名、导出、复制、删除。
- 调整大小（50%–140%）、不透明度、置顶、所有工作区可见、点击穿透、自动溜达、溜达速度。
- 「回到右下角」可以把跑丢的桌宠找回来。
- 导出会生成一个包含 `pet.json`、`sprite.png`、`frames/`、`sounds/` 的文件夹，可打包分享。

### 3. 自定义动作（动图 / 配音）

进入 **动作与声音**，选择要编辑的桌宠：

1. 左侧列表是动作；开关控制是否启用，点击行进入编辑。
2. 常用字段：
   - **触发方式**：什么时候播放（点击、打字、Esc、AI 回复…）。
   - **动画效果**：蹦跳 / 跳跃 / 转圈 / 摇头 / 点头 / 晃动 / 挥手 / 压扁 / 漂浮。
   - **动画时长 / 冷却时间**：防止疯狂触发。
   - **气泡台词**：会显示在桌宠头上（可同时 TTS 朗读）。
   - **情绪标记**：`happy` / `sad` / `think` / `sleepy` / `love`，切换表情。
3. **序列帧**：
   - 「导入帧图片」多选帧，按文件名顺序加入；
   - 或「从精灵图切分」：选择图片 → 输入行列数 → 自动切分并跳过全透明格；
   - 「帧间隔」控制播放速度。
4. **音效 / 配音**：选择音频文件并试听，保存后会复制到桌宠包内。
5. 点「在桌面上测试」立即预览，点「保存动作」持久化。
6. 「恢复默认动作」可以随时回到内置动作集。

> 帧图建议使用等尺寸、透明背景 PNG；每帧过大会增加桌宠包体积（单文件上限 25MB，帧数上限 80）。

### 4. 桌面交互

- **左键单击**：打招呼（默认动作）。
- **双击**：转圈抗议。
- **拖动**：拎起来放到桌面任意位置，松手后停在原地（60 秒内不自动溜达）；位置会保存，重启后保留。
- **右键**：菜单（聊天 / 打招呼 / 设置 / 换个位置 / 隐藏 / 退出）。
- **右键**：在桌宠或透明区域右键，打开功能菜单（聊天 / 打招呼 / 设置 / 换位置 / 隐藏 / 退出）；不再显示右侧悬浮按钮。
- **托盘**：显示/隐藏、打招呼、聊天、设置、回右下角、开机自启、退出。
- **聊天面板**：桌宠窗口向上展开；Enter 发送、Shift+Enter 换行、Esc 收起；发送中按钮变成停止。
- 输入框右侧的 🎤 需要先在 AI 设置里启用语音识别。

### 5. 快捷键

默认：

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl + Alt + Shift + P` | 显示 / 隐藏桌宠 |
| `Ctrl + Alt + Shift + K` | 打开聊天 |
| 双击桌宠 | 双击动作 |
| 右键桌宠 | 右键菜单 |
| `Esc`（聊天中） | 收起聊天 |

可在「互动与快捷键」里修改。应用默认通过 XWayland 运行，`globalShortcut` 可以正常注册；若组合被其他程序占用，设置页会显示 ✗。

---

## 接入 AI

设置 → **AI 伙伴**：

1. 打开「启用 AI 聊天」。
2. 选择服务预设，或手动填写：
   - **Base URL**：必须能拼接出 `${baseUrl}/chat/completions`（通常以 `/v1` 结尾）。
   - **API Key**：本地模型可留空。
   - **模型名称**。
3. 点「测试连接」验证。
4. 右键桌宠 →「和我聊天」。

内置预设：

| 预设 | Base URL | 默认模型 |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 阿里云百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Ollama（本地） | `http://127.0.0.1:11434/v1` | `qwen2.5:7b` |
| LM Studio（本地） | `http://127.0.0.1:1234/v1` | `local-model` |
| 自定义 | 任意兼容接口 | 任意 |

Ollama 示例：

```bash
ollama serve
ollama pull qwen2.5:7b
# 然后在 DeskPet 里选「Ollama（本地）」，测试连接即可
```

语音识别（可选）：

- 开启「启用语音识别」，模型填 `whisper-1`（或服务商支持的模型）。
- 聊天窗口点 🎤 开始录音，再点一次结束，最长 30 秒；识别结果会追加到输入框。
- 并非所有 OpenAI 兼容服务都实现了 `/audio/transcriptions`，不支持时关闭开关即可，不影响文字聊天。

人格提示词：

- 可以在「桌宠人格」里修改，程序会再附加当前桌宠名字和时间。
- 若模型在回复末尾输出 `[[happy]]`，桌宠会切到开心表情，聊天记录里不会显示该标记。
- 修改后点「保存人格」；「恢复默认人格」会恢复内置提示词。

---

## 语音与自定义配音

两种“说话”方式可以同时使用：

1. **系统 TTS**（设置 → 语音）
   - 选择系统音色；需要 `speech-dispatcher` 或 `espeak-ng`。
   - 控制语速、音调、音量，以及是否朗读 AI 回复 / 动作台词。
   - 「试听」使用当前设置朗读输入框文本。
2. **动作音效 / 自定义配音**（设置 → 动作与声音）
   - 为每个动作选择音频文件，例如录好的角色语音、8-bit 音效。
   - 音量由「语音 → 动作音效音量」控制。
   - 这比系统 TTS 更接近角色配音。

> 音频会复制进桌宠包，因此导出分享时一起带走。支持 MP3 / WAV / OGG / M4A / AAC / FLAC / WebM，单文件上限 20MB。

---

## 键盘 / 鼠标联动

默认开启（设置 → 互动与快捷键）。事件到动作的映射：

| 事件 | 默认动作 |
| --- | --- |
| 你打字 | 点头 + 偶尔说「在忙呀？我陪着你」 |
| 鼠标点击 | 看过来 + 轻微弹一下 |
| 滚轮 | 晃动 |
| 回车 | 点头 |
| Esc | 摇头 + 「要逃跑吗？」 |
| Ctrl + S | 蹦跳 + 「保存好啦！」 |
| 鼠标靠近 | 挥手打招呼 |
| 离开电脑 N 分钟 | 睡觉（Zzz），任意输入唤醒 |
| AI 回复 | 开心蹦跳 + 情绪表情 |

- 可在动作编辑器里改触发条件、台词、音效、动画，或直接禁用。
- 鼠标位置由主进程轮询系统光标（Linux/X11），用于眼睛跟随和「靠近」检测。
- 键盘事件只读取按键类别（字母/数字/回车/Esc/S 等），不会拼出你输入的文字。
- 关闭「启用键盘 / 鼠标联动」后，待机睡眠与鼠标跟随也会停止。

Linux 平台限制见 [docs/PLATFORM.md](docs/PLATFORM.md)。

---

## 打包

打包使用 [electron-builder](https://www.electron.build/)。图标由 `build/icon.svg` 生成（`build/icon.png` 已提交）。

### 本地打包

```bash
npm run pack:dir     # 只生成未压缩目录，用于检查
npm run dist         # Linux 全部目标
npm run dist:linux   # Linux：AppImage + deb + rpm + pacman
npm run dist:linux:appimage  # 只构建 AppImage（Arch 上最省事）
npm run dist:linux:flatpak   # 只构建 Flatpak
npm run dist:linux:pacman    # 只构建 pacman 包
```

产物输出到 `release/`，并自动归档到 `release/<version>/`：

| 目标 | 说明 |
| --- | --- |
| AppImage（x64） | 免安装，直接运行 |
| Flatpak（x64） | 单文件 `.flatpak` 包 |
| deb / rpm（x64） | Debian / Fedora 系安装包 |
| **pacman**（x64） | Arch Linux 原生包 |

> AppImage 需要 `fakeroot`、`libarchive-tools` 等；pacman/deb/rpm 目标使用 electron-builder 的 fpm，Arch 上构建 pacman 包需要额外安装 **`libxcrypt-compat`**（fpm 自带的 Ruby 依赖 `libcrypt.so.1`），否则请使用 `npm run dist:linux:appimage`。

### 版本产物保留

`release/` 不会因为构建新版本而清理旧版本。上面的打包命令结束后会自动执行 `scripts/preserve-release.mjs`：

```text
release/
  DeskPet-1.1.1-x86_64.AppImage
  DeskPet-1.1.1-x86_64.flatpak
  1.1.0/
    DeskPet-1.1.0-x86_64.AppImage
    DeskPet-1.1.0-x86_64.flatpak
    SHA256SUMS
  1.1.1/
    DeskPet-1.1.1-x86_64.AppImage
    DeskPet-1.1.1-x86_64.flatpak
    SHA256SUMS
```

可以单独补归档：

```bash
npm run archive:release       # 当前 package.json 版本
npm run archive:release:all   # release 根目录里的所有版本
```

完整规则见 [docs/RELEASES.md](docs/RELEASES.md)。**不要删除 `release/` 里的历史版本目录。**

### Flatpak

Flatpak 版本由 `scripts/build-flatpak.sh` 生成，直接复用 `release/linux-unpacked`，不需要 `flatpak-builder`：

```bash
# 先安装 GNOME 运行时（脚本默认使用 org.gnome.Platform 50）
flatpak install --user flathub org.gnome.Platform//50

npm run dist:linux:flatpak
# 产物：release/DeskPet-1.1.1-x86_64.flatpak
# 同时归档到 release/1.1.1/
```

安装与运行：

```bash
flatpak install --user release/DeskPet-1.1.1-x86_64.flatpak
flatpak run com.deskpet.app
flatpak run com.deskpet.app --settings
```

Flatpak 权限包含：X11/XWayland、PulseAudio、GPU、网络、`home` 文件访问、开机自启目录、桌面通知、StatusNotifier 托盘和门户。桌宠数据保存在：

```text
~/.var/app/com.deskpet.app/config/DeskPet/
```

> Flatpak 内使用 `--no-sandbox` 启动 Electron，外层由 Flatpak 沙箱隔离。首次启动会自动打开设置窗口。卸载：`flatpak uninstall --user com.deskpet.app`。

### 重新生成图标

```bash
npm run icons
```

需要 `rsvg-convert`（librsvg）或 ImageMagick；只生成 Linux 使用的 `build/icon.png`。

### GitHub Actions

- `.github/workflows/build.yml`：每次 push/PR 执行类型检查 + 构建；在 Ubuntu 上打包并上传 artifact。
- `.github/workflows/release.yml`：推送 `v*` tag 时构建 Linux 产物并创建 GitHub Release。

工作流使用 `npm ci`，因此请提交 `package-lock.json`。

---

## 项目结构

```text
DeskPet/
├── .github/
│   ├── workflows/build.yml          # CI：typecheck + Linux 打包
│   ├── workflows/release.yml        # tag 发布
│   ├── ISSUE_TEMPLATE/*.yml
│   └── PULL_REQUEST_TEMPLATE.md
├── build/
│   ├── icon.svg / icon.png
├── docs/
│   ├── ARCHITECTURE.md              # 进程模型 / IPC / 数据流
│   ├── PET_PACK.md                  # 桌宠包格式（可分享）
│   ├── PLATFORM.md                  # Linux 平台说明
│   └── assets/banner.svg
├── scripts/
│   ├── dev.mjs                      # 启动器：Wayland 下传入 --ozone-platform=x11
│   ├── build-flatpak.sh             # 从 linux-unpacked 生成 .flatpak
│   └── generate-icons.mjs
├── src/
│   ├── main/                        # Electron 主进程
│   │   ├── index.ts                 # 启动、协议、权限、生命周期
│   │   ├── pet-window.ts            # 透明桌宠窗口、移动、命中测试、聊天缩放
│   │   ├── settings-window.ts
│   │   ├── pet-store.ts             # 桌宠包 CRUD、导入导出、资源落盘
│   │   ├── config-store.ts          # 配置合并、校验、safeStorage
│   │   ├── ipc.ts                   # 全部 IPC handler（来源校验）
│   │   ├── input-monitor.ts         # uiohook + 待机检测
│   │   ├── ai-service.ts            # OpenAI 兼容流式对话 / STT
│   │   ├── hotkeys.ts
│   │   ├── tray.ts
│   │   ├── platform.ts              # 开机自启、菜单、平台启动项
│   │   ├── paths.ts / logger.ts
│   ├── preload/
│   │   ├── index.ts                 # contextBridge 暴露 typed API
│   │   └── index.d.ts
│   ├── renderer/
│   │   ├── pet/                     # 桌宠窗口（透明 + 聊天）
│   │   │   ├── index.html / style.css / main.ts
│   │   │   ├── engine.ts            # 状态机、物理、动作、帧动画
│   │   │   ├── chat.ts              # AI 对话 + 录音
│   │   │   ├── speech.ts            # TTS / 音效 / 气泡
│   │   │   └── builtin.ts           # 内置 SVG 桌宠
│   │   ├── settings/                # 设置窗口
│   │   │   ├── main.ts / state.ts / ui.ts
│   │   │   ├── pet-tab.ts / studio-tab.ts / actions-tab.ts
│   │   │   ├── voice-tab.ts / interaction-tab.ts / ai-tab.ts / about-tab.ts
│   │   │   ├── image-editor.ts      # 抠图 / 选区 / 泛洪 / 羽化
│   │   │   └── spritesheet.ts       # 精灵图切分、资源转 dataURL
│   │   └── shared/dom.ts            # 无依赖 DOM 工具
│   └── shared/
│       ├── types.ts                 # 主/渲染共用类型、AI 预设
│       └── defaults.ts              # 默认配置、默认动作、内置桌宠
├── electron-builder.yml
├── electron.vite.config.ts
├── package.json
├── tsconfig*.json
└── README.md
```

---

## 数据与隐私

桌宠数据保存在 Electron 的 `userData` 目录（不是源码目录）：

| 系统 | 路径 |
| --- | --- |
| Linux | `~/.config/DeskPet/` |

内容：

```text
DeskPet/
├── config.json        # 所有设置（AI Key 会尽量加密后保存）
├── pets/
│   ├── builtin/       # 内置桌宠的动作（形象由程序绘制）
│   └── <uuid>/        # pet.json + sprite.png + frames/ + sounds/
├── chat.json          # 最近 60 条对话
└── deskpet.log        # 运行日志（超过 2MB 轮转一次）
```

隐私：

- 除主动使用 AI / 语音识别外，所有数据都在本机。
- 全局键盘监听只统计事件类别（打字节流计数、回车、Esc、Ctrl+S），**不保存具体按键内容**。
- API Key 仅在主进程内使用；系统支持 `safeStorage` 时会加密落盘。若系统不支持（部分 Linux 环境），会以明文保存在仅当前用户可读的配置文件中。
- 录音只在你按下 🎤 后开始，发送给配置的识别接口后即丢弃。

重置：

- 设置 → 关于 →「重置所有设置」恢复默认配置（不删除桌宠与聊天记录）。
- 删除桌宠会删除其图片、帧和音频。
- 想彻底清空可退出后删除整个 `userData` 目录。

---

## Linux 平台说明与已知限制

| 能力 | Linux X11 / XWayland | 原生 Wayland |
| --- | --- | --- |
| 透明/无边框窗口 | ✅（需要合成器） | ⚠️ 取决于合成器 |
| 窗口程序化移动 / 自由拖放 | ✅ | ❌ 协议禁止应用自定位 |
| 置顶 | ✅ | ⚠️ 由合成器决定 |
| 所有工作区可见 | ✅ | ⚠️ 由合成器决定 |
| 全局键盘/鼠标事件 | ✅（需 libXtst） | ⚠️ 只能看到 XWayland 应用 |
| 全局快捷键 | ✅ | ⚠️ 通常不可用 |
| 系统 TTS | ✅（需 speech-dispatcher） | 同左 |
| 麦克风录音 | ✅ | ✅ |

**Wayland 会话下应用默认使用 XWayland**：启动器/桌面入口传入 `--ozone-platform=x11`；直接运行 `electron .` 或 AppImage 时主进程会自动带该参数重启一次。`app.commandLine.appendSwitch()` 在 Chromium 初始化后执行，不能用来选择 Ozone 平台。XWayland 是桌宠自由移动、透明、置顶和全局快捷键能够工作的前提；如需原生 Wayland，设置 `DESKPET_OZONE_PLATFORM=wayland`，但拖拽/自由定位会失效。

已知限制：

- 原生 Wayland 下无法程序化移动窗口，也无法可靠监听原生 Wayland 应用的键盘；这不是 DeskPet 能绕过的协议限制。
- 全局快捷键如果被其他软件占用会注册失败，设置页会显示 ✗，换一个组合即可。
- 内置桌宠的图形不能替换；请用抠图工坊创建自定义桌宠。
- 单个桌宠包没有做压缩归档；导出是一个文件夹。分享时可以自行 zip。
- 大尺寸高帧数序列帧会增加内存占用；编辑器会限制到 80 帧、1024px 输出。

---

## 常见问题

**看不到桌宠或设置窗口？**

这是 1.0.0 在 GNOME Wayland 上的已知问题：Electron 创建了原生 Wayland 窗口，但原生 Wayland 不允许桌宠定位窗口，窗口也可能不呈现。1.0.1 已修复：

- 使用最新代码重新 `npm run dev` / `npm run build` / 重新打包 AppImage；
- `npm run dev` 的启动器会自动传 `--ozone-platform=x11`；
- 直接运行 `electron .` 或 AppImage 时，主进程会自动用 XWayland 重启一次（会有一瞬间的闪烁）；
- 再次启动 DeskPet 会打开设置窗口；首次启动（没有 `config.json`）也会自动打开设置；
- GNOME 需要 AppIndicator 扩展来显示托盘，若没有托盘，请右键桌宠 →「设置…」或使用 `--settings` 参数；
- 仍未出现时，在终端运行 `npm run dev` 并查看 `~/.config/DeskPet/deskpet.log`，确认日志里有 `Pet window shown`。

**桌宠看得见，但点它没反应？**

1.0.3 起「透明区域可以点穿」默认关闭，桌宠窗口默认整个区域都能接收鼠标；旧配置会自动迁移为关闭。如果手动开启后点击又不灵敏，重新关闭该项即可。指针移到桌宠身上时，自动溜达也会暂停。

**设置里的开关点不动？**

这是 1.0.1 及更早版本的样式问题：开关的复选框被设成 0×0，视觉滑块并不接收点击。1.0.2 已把 checkbox 铺满整个开关，可以直接点击关闭「显示在所有桌面」「透明区域可以点穿」等选项。如果当前仍是旧进程，请退出后重新启动。

**切换工作区后桌宠不见了？**

1.0.2 起 Linux 会真正应用「显示在所有桌面 / 全屏应用之上」，且默认开启。如果手动关闭了它，桌宠会留在原来的工作区；在设置 →「我的桌宠」里重新打开即可。旧版配置会在首次启动 1.0.2 时自动迁移为开启。

**桌宠跑到屏幕外或被 Dock 挡住？**

托盘菜单 →「把它放回右下角」，或打开设置 →「我的桌宠」→「回到右下角」。也可以退出应用后删除 `~/.config/DeskPet/config.json` 里的 `window` 字段，下次启动会回到屏幕底部中央。

**窗口背景是黑色 / 不透明？**
Linux 需要开启桌面合成（KWin、Mutter 等默认开启）；Wayland 原生模式尤其受限。可设置 `DESKPET_OZONE_PLATFORM=x11` 或登录 X11 会话。

**键盘反应无效？**
- 确认使用 X11/XWayland，安装 `libxtst`；原生 Wayland 应用不会被捕获。

**设置了快捷键但用不了？**
如果组合被其他软件占用，设置页会标记注册失败；换一个组合即可。DeskPet 默认通过 XWayland 运行，`globalShortcut` 可用。

**没有声音 / 没有可选音色？**
Linux 安装 `speech-dispatcher`（或 `espeak-ng`），重启 DeskPet；也可以在动作里绑定自己的音频文件。

**麦克风没反应？**
确认系统有输入设备、已允许 DeskPet 使用麦克风，并在 AI 设置里启用语音识别；部分 OpenAI 兼容服务不提供 `/audio/transcriptions`。

**AI 测试连接失败？**
- 401/403：API Key 无效。
- 404：Base URL 少/多了 `/v1`，或该服务不支持 `/models`（会自动回退用一次对话测试）。
- 连不上：本地模型确认 `ollama serve` / LM Studio 服务器已启动。

**抠图把角色也删了？**
点「↶ 撤销」或「↺ 还原原图」，降低「容差」后再试；用套索圈出角色后点「保留选区」更稳妥。

**Electron 启动提示找不到可执行文件？**
`npm install` 后若 `node_modules/electron/dist/electron` 不存在，运行 `npx electron --version` 触发下载（或 `npm rebuild electron`）。

**想查看日志？**
设置 → 关于 →「查看日志」/「打开数据目录」，或直接打开 `deskpet.log`。

---

## 开发状态与验证

已在 **Arch Linux（GNOME Wayland + XWayland, 2560×1600, Node 26, Electron 44.9.1）** 完成并验证：

- `npm install`（含 uiohook-napi 预编译二进制）
- 主进程与渲染进程严格 TypeScript 类型检查（`npm run typecheck`）
- 共享逻辑测试（`npm test`）
- 生产构建（`npm run build`，主进程 / preload / 两个渲染页面）
- 修复并验证 **GNOME Wayland 下窗口不可见**：
  - 定位到应用实际创建了原生 Wayland 窗口，`app.commandLine.appendSwitch` 对 Ozone 选择太晚；
  - 改为启动器 / 桌面入口传真实 `--ozone-platform=x11`，直接运行时自动重启；
  - 用 X11 窗口树确认桌宠/设置窗口为 `Viewable`，并实际截取窗口内容确认渲染正常；
  - XWayland 下全局快捷键注册成功。
- 打包冒烟测试：`electron-builder --linux AppImage` 成功；AppImage 直接启动（无桌面入口参数）也能自动重启到 XWayland 并显示桌宠与设置。
- 首次启动自动打开设置、二次启动打开设置、`ready-to-show` 超时兜底均已验证。
- 修复并验证 Linux/GNOME 多工作区置顶：`setVisibleOnAllWorkspaces(true)` 在 XWayland 下把桌宠变成 `_NET_WM_STATE_STICKY` / `_NET_WM_DESKTOP=-1`；窗口显示后重新 `setAlwaysOnTop` + `moveTop`，打开设置窗口后桌宠仍在最上层。
- 修复并验证设置页 toggle：`elementFromPoint` 命中 `INPUT`，点击后配置中的 `showOnAllWorkspaces` / `clickThrough` 能正确切换。
- 修复点击交互：点击穿透默认关闭；指针位于桌宠上时暂停溜达。实测窗口 input shape 为完整 `720×760`，直接点击/拖动可用。
- 自由定位：拖动可把窗口放到屏幕任意位置，松手后不再落回底部；位置会保存到配置，重启后保留。
- 桌宠右侧悬浮按钮已移除，只保留右键功能菜单；右键桌宠或透明区域即可打开聊天 / 设置 / 隐藏等。
- Flatpak：`scripts/build-flatpak.sh` 生成单文件 `.flatpak`，使用 GNOME Platform 50，已在用户安装并 `flatpak run com.deskpet.app` 验证（输入监听、桌宠/设置窗口正常）。
- Linux-only：移除 Windows/macOS 构建目标与平台分支，CI 只构建 Linux 产物。

---

## 贡献与许可

- 开发说明、代码风格、扩展指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 桌宠包格式见 [docs/PET_PACK.md](docs/PET_PACK.md)，架构与 IPC 见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
- 安全问题请参考 [SECURITY.md](SECURITY.md)。

[MIT](LICENSE) © 2025 DeskPet Contributors
