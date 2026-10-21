# 发布产物保留规则

DeskPet 的 `release/` 目录遵循以下规则：

1. **每个版本单独保留**：任何新版本都不得覆盖或删除旧版本。至少保留该版本的 AppImage 和 Flatpak；deb / rpm / pacman 有构建时也一并保留。
2. **版本目录是归档**：构建脚本会把当前版本产物复制到 `release/<version>/`，并在其中生成 `SHA256SUMS`。根目录中的产物方便直接安装，版本目录才是长期归档。
3. **版本号必须递增**：修改对外可见的行为、修复或构建配置后，先更新 `package.json` 版本（以及 `CHANGELOG.md`），再构建；不要用同一个版本号反复覆盖不同内容。
4. **不要清理 release**：`release/` 已被 `.gitignore` 忽略，但仍属于本地产物，不能执行 `rm -rf release` 或让构建工具清空它。空间不足时先确认每个版本已归档，再考虑迁移到外部备份。
5. **归档命令**：

```bash
npm run dist:linux:appimage   # 构建并自动归档当前版本
npm run dist:linux:flatpak    # 构建并自动归档当前版本
npm run archive:release       # 只归档 package.json 的当前版本
npm run archive:release:all   # 把 release 根目录里所有版本归档
```

推荐的目录结构：

```text
release/
  DeskPet-1.1.1-x86_64.AppImage       # 当前版本，便于直接运行
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

> 同一个版本重新构建时会更新该版本的目录；不同版本之间永远不会互相覆盖。
