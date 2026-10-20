## 这个 PR 做了什么？

<!-- 一句话说明，并关联 issue：Closes #123 -->

## 类型

- [ ] Bug 修复
- [ ] 新功能
- [ ] 文档 / 构建
- [ ] 重构（不改变行为）
- [ ] 平台适配

## 实现说明

<!-- 关键设计、取舍、影响的 IPC / 数据结构 / 桌宠包格式 -->

## 手动验证

- 操作系统 / 桌面环境：
- `npm run typecheck`：
- `npm run build`：
- 测试过的流程（勾图 / 动作 / 语音 / AI / 打包）：

## 截图或录屏（UI 改动）

## 检查清单

- [ ] 遵循 `.editorconfig`（2 空格、单引号、无分号）
- [ ] 新增 IPC 做了 sender 与参数校验
- [ ] 渲染进程没有直接使用 Node API
- [ ] 修改了桌宠包格式时同步更新 `docs/PET_PACK.md`（并考虑 schema 版本）
- [ ] 更新了 README / 文档
- [ ] 没有提交 `out/`、`release/`、`node_modules/`、API Key 或他人素材
