# 贡献指南

感谢你愿意改进 DeskPet！这是一个 Electron + TypeScript 项目，欢迎提交 bug、桌宠包、动作预设、平台适配和文档改进。

## 开发环境

```bash
git clone <your-fork>
cd DeskPet
npm install
npm run dev
```

要求 Node.js ≥ 20.19。`npm run dev` 会调用 `scripts/dev.mjs`；在 Linux Wayland 上它会通过 electron-vite 的 `--` 转发 `--ozone-platform=x11`，**不要**直接用 `electron-vite dev` 启动，否则 Electron 会创建原生 Wayland 窗口，桌宠无法定位/显示。提交前请至少执行：

```bash
npm run typecheck
npm run build
```

## 代码风格

- 2 空格缩进、单引号、**不写分号**、LF 换行（`.editorconfig` / `.gitattributes`）。
- 严格 TypeScript：不要用 `any` 绕过类型（现有 IPC helper 的 `any` 是受控例外）；新增公共类型放 `src/shared/types.ts`。
- 不引入运行时框架（React/Vue）或大型依赖。渲染层使用 `shared/dom.ts` 的 `h()` 构造 DOM。
- 主进程通过 `PetStore` / `ConfigStore` 访问磁盘，不要在 IPC handler 里直接写文件。
- 渲染进程不要访问 Node API；所有能力走 `window.deskpet`。
- 新增用户可见文案使用简体中文；代码注释/日志使用英文。

## 目录约定

| 路径 | 内容 |
| --- | --- |
| `src/main` | 只能在这里使用 Electron/Node |
| `src/preload` | contextBridge API，不写业务逻辑 |
| `src/shared` | 无 Node/DOM 依赖的类型与常量 |
| `src/renderer/pet` | 桌宠窗口、引擎、聊天、语音 |
| `src/renderer/settings` | 设置页、抠图、动作编辑器 |
| `docs` | 架构、桌宠包、平台文档 |

## 常见扩展

### 增加一种触发条件

1. `src/shared/types.ts`：加入 `PetTrigger` 联合类型与 `PET_TRIGGERS` 中文标签。
2. `src/main/input-monitor.ts`：在 `handleKey` / `handleClick` / `handleWheel` 中发送对应 `InputKind`；如果新增 `InputKind`，同步更新 `InputEvent`。
3. `src/renderer/pet/engine.ts`：在 `handleInput` 里把事件映射到 `playTrigger('your-trigger')`。
4. `src/main/pet-store.ts` 的 `normalizeAction` 会自动接受新 trigger（通过 `PET_TRIGGERS` 集合）。
5. 更新 README 与 `docs/PET_PACK.md`。

### 增加一个设置页

1. `src/shared/types.ts`：扩展 `SettingsTab`。
2. `src/main/ipc.ts`：把新 tab 加入 `VALID_TABS`。
3. `src/renderer/settings/index.html`：侧边栏加按钮（`data-tab`）。
4. `src/renderer/settings/main.ts`：`META` + `createView` 分支。
5. 新建 `xxx-tab.ts`，实现 `TabView`（`el`、可选 `onShow/refresh`），使用 `ui.ts` 组件。

### 增加一个 IPC

1. `src/shared/types.ts` 的 `DeskPetApi` 增加方法。
2. `src/preload/index.ts` 暴露 `ipcRenderer.invoke/send`。
3. `src/main/ipc.ts` 用 `handle()` / `ipcMain.on()` 实现；**必须**校验参数与 sender。
4. 需要广播给所有窗口时用 `notifyConfig()` / `settings.broadcast()`。

### 修改桌宠包格式

- 任何不兼容变更都要提升 `PET_SCHEMA`（例如 `deskpet/pet@2`），并在 `PetStore.readPack` 中做迁移或拒绝。
- 新增可选字段时保持 `@1`，在 `normalizeAction` / `readPack` 中给默认值。
- 同步更新 `docs/PET_PACK.md`。

### 新增动画

1. `src/shared/types.ts`：`PetAnimation` + `PET_ANIMATIONS`。
2. `src/renderer/pet/engine.ts`：`playAction` 的动画分支（`applyVisual`）。
3. `src/main/pet-store.ts` 依赖 `PET_ANIMATIONS` 自动接受。

## 修改桌宠 UI

- 桌宠窗口尺寸常量在 `src/shared/defaults.ts`（`PET_WINDOW` / `CHAT_WINDOW`）。
- 气泡/聊天的 `bottom` 使用 `--pet-scale` 计算，修改桌宠高度时保持对齐。
- 命中测试由渲染进程 `updateHitbox()` 上报；加入新的可点击元素时记得把它并入 hitbox（参考 `updateHitbox` 里的 bubble/chat）。桌宠不再有悬浮工具栏，交互入口是右键菜单。

## 自动化检查

CI 会运行：

```bash
npm ci
npm run typecheck
npm run build
npx electron-builder --publish never
```

三平台分别构建。提交 PR 前请确认没有把 `out/`、`release/`、`node_modules/` 或本地配置提交进来。

## 提交 PR

- 每个 PR 聚焦一个主题；说明动机、实现方式和手动验证步骤。
- UI 改动请附截图/GIF（可以放在 PR 描述里，不必进仓库）。
- 涉及平台行为时，注明测试过的系统与桌面环境（如 `Arch + KDE Wayland/XWayland`）。
- 不提交他人的图片、音频或角色素材，除非你有明确授权。

## 发布

1. 更新 `CHANGELOG.md` 与 `package.json` 版本。
2. 提交并打 tag：`git tag v1.0.1 && git push --tags`。
3. `.github/workflows/release.yml` 会构建三平台产物并创建 Release。
