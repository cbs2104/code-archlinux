# 架构说明

DeskPet 由三个进程/上下文组成：Electron 主进程、preload 桥、两个渲染页面（desk pet 与 settings）。所有 Node / Electron 能力只在主进程和 preload 中出现，渲染页面通过类型化的 `window.deskpet` API 调用。

```
┌─────────────────────────────────────────────────────────────────────┐
│ Electron main                                                       │
│  index.ts       启动、单实例、协议、权限、生命周期                    │
│  PetWindow      透明窗口、移动、光标轮询、命中测试、聊天缩放          │
│  SettingsWindow                                                     │
│  PetStore       userData/pets/<id>/pet.json + 资源                  │
│  ConfigStore    config.json + safeStorage 加密 Key                  │
│  InputMonitor   uiohook-napi（全局键鼠） + powerMonitor 待机         │
│  AiService      OpenAI 兼容 /chat/completions、/audio/transcriptions │
│  Hotkeys/Tray/Platform/Menu                                         │
└───────────────▲─────────────────────────────────────────────────────┘
                │ ipcMain.handle / webContents.send
┌───────────────┴─────────────────────────────────────────────────────┐
│ preload/index.ts  contextBridge.exposeInMainWorld('deskpet', api)   │
└───────────────▲───────────────────────────────▲─────────────────────┘
                │ typed API                     │
       ┌────────┴────────┐            ┌─────────┴──────────┐
       │ pet renderer    │            │ settings renderer  │
       │ engine/chat/    │            │ tabs/editor/state  │
       │ speech/builtin  │            │ ui/dom             │
       └─────────────────┘            └────────────────────┘
```

## 主进程

### 启动顺序（`src/main/index.ts`）

1. 注册 `deskpet://` 为 privileged scheme。
2. Linux：启用透明视觉；Wayland + DISPLAY 时通过真实命令行参数 `--ozone-platform=x11` 启动（启动器/桌面入口/主进程自动重启），保证窗口可定位。
3. 单实例锁；第二个实例显示已有桌宠。
4. `app.whenReady()`：
   - `log.init()`
   - `ConfigStore.load()` → 合并默认值并校验
   - `PetStore.init()` → 确保 `builtin/pet.json` 存在、当前桌宠有效
   - 注册 `protocol.handle('deskpet', …)`
   - 创建 `PetWindow`、`SettingsWindow`
   - 注册 IPC、托盘、应用菜单、权限处理器
   - 启动 `InputMonitor` 与全局快捷键
   - 监听显示器变化、锁屏/休眠

### 资源协议

`deskpet://assets/<petId>/<relative path>` 只读取 `<userData>/pets/<petId>/...`。实现上：

- `decodeURIComponent` 后 `path.resolve`；
- 结果必须位于 pets 根目录内，否则 403；
- 返回正确的 `Content-Type`，不缓存（`no-cache`），便于设置里换图后立即刷新。

自定义协议让渲染进程可以用普通 `<img src>` / `new Audio()` / `fetch()` 访问资源，而不暴露 `file://` 路径。

### 桌宠窗口与命中测试

窗口固定为透明、无边框、不可调整大小（`PetWindow`）：

- **移动**：渲染进程引擎每帧计算窗口左上角并调用 `pet:move-to`（节流 30fps），主进程按目标显示器工作区夹取。
- **点击穿透**：主进程每 40ms 读取一次 `screen.getCursorScreenPoint()`，与渲染进程上报的 hitbox（CSS px，相对窗口）比较；只有光标在桌宠/悬浮按钮/气泡上时才 `setIgnoreMouseEvents(false)`。这比依赖 `forward: true` 的 mousemove 更可靠，在 Linux 也可用。
- **拖拽**：渲染进程 `pointerdown` 后捕获指针，`pointermove` 的 `screenX/screenY` 驱动窗口位置；主进程在拖拽期间保持可交互。
- **聊天面板**：渲染进程请求 `pet:set-chat-open(true)`，主进程把窗口从 `360×380` 扩到 `420×660`（底部/水平中心锚定、夹取到工作区），关闭时缩回。窗口尺寸变化会广播 `pet:env`。
- **视觉**：窗口自身透明；SVG/自定义图片完全由 CSS 绘制。聊天面板与气泡都在同一个渲染进程里。

### 输入监听

`InputMonitor` 动态 `require('uiohook-napi')`：

- 可选依赖，加载失败不会让应用崩溃；设置页显示错误。
- 监听 `keydown` / `click` / `wheel`；不监听 `mousemove`（改用主进程轮询光标，避免高频 IPC）。
- 按键分类：
  - `Ctrl/Cmd + S` → `save`
  - Enter → `enter`，Esc → `escape`
  - 其他非控制/导航/功能键 → 按 450ms 节流发送 `typing` 事件（带计数）
- `powerMonitor.getSystemIdleTime()` 每 10s 检查一次，到达阈值发送 `idle`，恢复活动发送 `wake`。
- Linux Wayland 原生应用的按键不会被 XWayland hook 捕获；文档与设置页会提示。

主进程把事件通过 `pet:input` 发给桌宠渲染进程，由 `PetEngine.handleInput` 映射到动作。

### AI

`AiService` 完全运行在主进程（渲染进程不持有 API Key，也不发外部请求）：

- `POST {baseUrl}/chat/completions`，`stream: true` 时解析 SSE `data:` 行，逐块 `ai:chunk` 回传；最后 `ai:done`。
- 支持非流式、超时（120s）、取消（AbortController）、HTTP 错误可读化（401/403/404/429/5xx 提示）。
- `/models` 用于测试；404/405 时回退到一次极小的 `ping` 对话。
- `/audio/transcriptions` 使用 `FormData` + `Blob`，30MB 上限。

### 配置

`ConfigStore` 使用 `mergeDeep(DEFAULT_CONFIG, stored)` 后逐字段 `normalize`（范围夹取、字符串截断、类型回退）。

- 写入使用临时文件 + `rename`，避免半写入。
- 250ms 防抖写入。
- `safeStorage.isEncryptionAvailable()` 时把 `ai.apiKey` 加密为 `apiKeyEnc`；解密发生在主进程内存中。
- 配置修改通过 `config:changed` 广播给两个渲染进程；窗口位置保存不广播（位置变化由引擎处理）。

## 渲染进程

### 桌宠（`src/renderer/pet`）

- `PetEngine`：状态机 `idle | walk | air | drag | land | sleep`。
  - 物理：重力 2400 px/s²、落地弹跳、水平摩擦；
  - 漫游：空闲随机目标 + 速度；
  - 动作：动画曲线叠加 + 序列帧播放；
  - 表情：内置 SVG 的嘴型、眨眼、瞳孔偏移；
  - 鼠标靠近 / 屏幕输入触发的动作。
- `ChatPanel`：消息列表、流式渲染、停止、清空、历史、录音 → STT → 输入框。
- `Speaker`：`speechSynthesis`（音色/语速/音调/音量） + `Audio` 音效 + 气泡计时。
- `builtin.ts`：内置 SVG 与表情/瞳孔操作函数。
- 主进程只负责窗口、输入、AI 和存储；动画与布局在渲染进程完成。

### 设置（`src/renderer/settings`）

- `main.ts` 管理导航、页面标题与跨页面刷新。
- `state.ts`：配置 + 桌宠列表 + 输入/快捷键状态；统一的 `patch` / `reloadPacks`。
- `ui.ts` / `shared/dom.ts`：无框架的小型 DOM 构造器与控件（开关、滑块、select、模态框、toast）。
- 每个 tab 是一个实现 `TabView` 的类，惰性创建并复用 DOM。
- `image-editor.ts`：离屏 canvas 保存当前像素，view canvas 负责显示叠加层；所有编辑操作在原始分辨率进行。泛洪、最大连通域、羽化、alpha 包围盒均为手写实现，无第三方图像库。
- `spritesheet.ts`：精灵图切分（跳过全透明格）与 `fetch` → dataURL 转换。

### IPC 通道

| 通道 | 方向 | 说明 |
| --- | --- | --- |
| `config:get` / `config:patch` / `config:reset` | invoke | 读写配置 |
| `pets:list/get/create-from-sprite/replace-sprite/...` | invoke | 桌宠包 CRUD |
| `pets:save-action/delete-action/reset-actions` | invoke | 动作与资源落盘 |
| `pets:import/export` | invoke | 文件夹选择 + 复制 |
| `dialogs:*` | invoke | 图片/多图/音频/目录选择 |
| `pet:get-env/move-to/set-hitbox/set-chat-open/begin-drag/end-drag/...` | invoke/send | 窗口控制 |
| `pet:cursor` / `pet:input` / `pet:env` / `pet:command` / `pet:test-action` | main → renderer | 运行时事件 |
| `ai:chat/cancel/transcribe`、`ai:chunk/done/error` | send/invoke | AI 流式 |
| `history:load/save/clear` | invoke | 聊天记录 |
| `system:*` | invoke | 输入状态、快捷键、自启、置顶 |
| `app:*` | invoke | 信息、外部链接、打开目录、退出 |

所有 handler 先通过 `isTrusted(sender)`（sender 必须是本应用创建的 BrowserWindow）校验，失败直接拒绝。

## 数据模型

- **AppConfig**：见 `src/shared/types.ts`；`ConfigStore` 负责默认值与范围。
- **PetPack**：`schema: "deskpet/pet@1"`，包含 `sprite`、`actions`、`greeting`；详见 [PET_PACK.md](PET_PACK.md)。
- **PetAction**：触发条件 + 动画 + 帧 + 音效 + 台词 + 冷却 + 启用 + 情绪标记。
- **ChatHistoryEntry**：`user | assistant` + 内容 + 时间，最多 60 条。
