# DeskPet 项目规则

本文件是 DeskPet 的长期开发约束，修改项目时必须遵守。

## 发布与版本

- 只维护 Linux，不要重新加入 Windows / macOS 目标。
- **每个版本都要保留**：新版本不能覆盖旧版本。`release/<version>/` 必须保留该版本的 AppImage / Flatpak（有 deb/rpm/pacman 时也保留）。
- 对外可见的修复或行为变更必须提升版本号，并同步 `CHANGELOG.md`。
- 构建脚本会自动执行 `scripts/preserve-release.mjs`；不要删除 `release/`、不要在构建前清空它。
- 详细规则和归档结构见 [`docs/RELEASES.md`](docs/RELEASES.md)。

## 桌宠窗口

- 桌宠窗口使用 Linux EWMH `toolbar` 类型，使其不出现在任务栏 / 分页器，也不能被最小化；不要改回普通窗口。
- 桌宠不是普通应用窗口：开机自启必须直接显示桌宠，不得在 autostart 的 `Exec` 中附加 `--hidden`。
- 桌宠保持置顶、所有工作区可见；用户从右键菜单或托盘主动隐藏时除外。

## 代码与验证

- 遵守 `CONTRIBUTING.md` 的风格与目录约定。
- 提交前至少运行 `npm run typecheck`、`npm test` 和 `npm run build`。
- 修改窗口行为后，用 `xprop` 检查 `_NET_WM_STATE`、`_NET_WM_WINDOW_TYPE` 和 `_NET_WM_ALLOWED_ACTIONS`，确认没有任务栏和最小化动作。
