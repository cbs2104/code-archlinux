# 安全策略

## 支持版本

只维护最新发布版本（当前 1.x）。

## 报告漏洞

请不要在公开 issue 中贴出可利用细节。请通过仓库的 **Security → Report a vulnerability**（GitHub 私密漏洞报告）联系维护者，或发送邮件给仓库维护者（见 GitHub 个人资料）。我们会在确认后尽快修复并在 Release Notes 中致谢。

## 安全模型

DeskPet 是本地桌面应用，默认不开放任何网络端口。主要信任边界：

### 渲染进程

- 两个窗口都启用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: false`（preload 需要 Electron 模块）。
- preload 只通过 `contextBridge` 暴露白名单 API；渲染进程没有 `require` / `fs` / `child_process`。
- 页面禁止导航与新窗口；外部链接只允许 `http(s)` 并交给系统浏览器。
- 所有 IPC 调用会校验 sender 是否属于本应用创建的 BrowserWindow（`trustedWindow`），防止被意外加载的第三方页面调用。
- 设置了 CSP：脚本只能来自应用自身，图片/音频允许 `deskpet:` 与 `data:`，外部网络请求只在主进程发生。

### 资源协议

`deskpet://assets/<petId>/<path>`：

- 先 `decodeURIComponent`，再 `path.resolve`；
- 必须位于 `<userData>/pets` 内，否则返回 403；
- 只读取文件，不执行任何内容。

### 输入监听

- 使用 `uiohook-napi` 读取全局事件，但只把**事件类别、计数**传给渲染进程；不保存键码序列、不记录文本。
- 可以在设置中完全关闭。
- Linux 依赖 X11/XWayland。

### API Key 与 AI 数据

- API Key 只存在主进程与 `config.json` 中；系统支持时使用 Electron `safeStorage` 加密（`apiKeyEnc`），否则明文保存在用户配置目录（仅当前用户可读）。
- 聊天请求由主进程直接发往用户配置的 Base URL；不经过任何中转服务。
- 聊天记录保存在本地 `chat.json`，可在设置中清空。
- 录音只在用户按下 🎤 时开始，发送到配置的 `/audio/transcriptions` 后丢弃。
- 请只使用你信任的 AI 服务；恶意/被劫持的 Base URL 可以看到你发送的聊天内容。

### 桌宠包

导入的桌宠包被视为**不可信数据**：

- JSON 会校验 schema、字段类型、范围；
- 所有资源路径必须位于包目录内（`assetFile` 校验）；
- 文件大小限制（图片 25MB、音频 20MB）；
- 不支持可执行文件、HTML 或脚本资源。

### 外部依赖

- 运行时仅依赖 `uiohook-napi`（可选，原生预编译），其余为 Electron 内置能力。
- 开发依赖包括 electron、electron-vite、electron-builder、typescript、vite。
- `npm audit` 与 Dependabot 可用于跟踪依赖问题。

## 已知风险

- 全局输入 hook 需要较高系统权限；如果用户选择启用，请从可信来源安装 DeskPet。
- 请从可信来源安装 AppImage / 包管理器产物，避免使用被篡改的二进制。
- 任何本地桌面应用都无法防御已取得当前用户权限的恶意软件读取 `config.json`。
