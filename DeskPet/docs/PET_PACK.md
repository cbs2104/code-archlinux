# 桌宠包格式（DeskPet Pet Pack v1）

一个桌宠包就是一个文件夹。DeskPet 在 `userData/pets/<id>/` 下维护它；「导出」会把整个文件夹复制到你选择的位置，「导入」则复制到新的 UUID 目录并重写 `id`。

```text
my-pet/
├── pet.json
├── sprite.png
├── frames/
│   └── wave/
│       ├── 0.png
│       └── 1.png
└── sounds/
    └── wave.mp3
```

## pet.json

```json
{
  "schema": "deskpet/pet@1",
  "id": "e724e648-9e3b-4954-9f1a-bbc91f1c32e2",
  "name": "芙芙",
  "author": "我",
  "version": "1.0.0",
  "kind": "custom",
  "createdAt": 1792482729234,
  "updatedAt": 1792482729234,
  "sprite": {
    "kind": "image",
    "asset": "sprite.png",
    "width": 1024,
    "height": 576
  },
  "greeting": "芙芙 来啦！",
  "actions": [
    {
      "id": "hello",
      "name": "打招呼",
      "trigger": "click",
      "animation": "bounce",
      "durationMs": 800,
      "frames": [],
      "frameDurationMs": 120,
      "sound": null,
      "say": "喵～",
      "cooldownMs": 600,
      "enabled": true,
      "emotion": "happy"
    }
  ]
}
```

### 顶层字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `schema` | `"deskpet/pet@1"` | 必填；不匹配会拒绝导入 |
| `id` | string | 导入时会被替换为新 UUID |
| `name` | string | 显示名（≤40 字符） |
| `author` | string | 作者，可选 |
| `version` | string | 桌宠包版本，默认 `1.0.0` |
| `kind` | `builtin \| custom` | 内置包由程序生成；导入后一律为 `custom` |
| `createdAt` / `updatedAt` | number | Unix ms |
| `sprite` | object | 形象信息 |
| `greeting` | string | 见面台词（≤200 字符） |
| `actions` | PetAction[] | 动作列表；为空时回退到默认动作 |

### `sprite`

| 字段 | 说明 |
| --- | --- |
| `kind` | `image`（自定义 PNG）或 `builtin`（内置 SVG） |
| `asset` | `kind === "image"` 时必填，相对包目录的路径，如 `sprite.png` |
| `width` / `height` | 原图尺寸（用于导入校验与设置预览） |

图片建议透明背景 PNG；最长边保存时限制为 1024px。`asset` 不允许绝对路径或 `..`。

### `actions[]`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 唯一 ID；序列帧目录按它命名 |
| `name` | string | 动作名 |
| `trigger` | enum | 见下表 |
| `animation` | enum | `none, bounce, jump, spin, shake, nod, wobble, wave, squash, float` |
| `durationMs` | number | 动画时长（100–15000） |
| `frames` | string[] | 相对包目录的帧路径，最多 80 张 |
| `frameDurationMs` | number | 帧间隔（30–2000） |
| `sound` | string \| null | 相对包目录的音频路径 |
| `say` | string | 气泡台词（≤300 字符） |
| `cooldownMs` | number | 冷却（0–3600000） |
| `enabled` | boolean | 是否启用 |
| `emotion` | string? | `happy/sad/think/sleepy/love` 之一，播放时切换表情 |

触发条件：

| `trigger` | 触发时机 |
| --- | --- |
| `click` | 单击桌宠 |
| `double-click` | 双击桌宠 |
| `drag-start` | 开始拖动（移动超过 4px） |
| `land` | 抛掷/跳跃落地 |
| `typing` | 全局打字（节流） |
| `key-enter` | 全局 Enter |
| `key-escape` | 全局 Esc |
| `save-hotkey` | 全局 Ctrl/Cmd + S |
| `wheel` | 全局滚轮 |
| `mouse-near` | 鼠标靠近桌宠 |
| `idle` | 系统空闲达到设置阈值 |
| `ai-reply` | AI 回复完成 |
| `custom` | 不会自动触发，只能手动测试 |

同一种触发条件可以有多个动作，引擎会优先选择冷却结束的动作并随机挑选。

## 资源路径

- 所有 `asset` / `frames[]` / `sound` 必须是**相对路径**，使用 `/` 分隔；
- 保存动作时，新帧写入 `frames/<actionId>/<index>.<ext>`，音效写入 `sounds/<actionId>.<ext>`；
- 导入会拒绝缺失 sprite、非法 JSON、错误的 schema；
- 单个文件上限 25MB（图片）和 20MB（音频）。

## 编写与分享

1. 在 DeskPet 里创建桌宠并配置好动作。
2. 设置 → 我的桌宠 →「导出」选择目标文件夹。
3. 把生成的文件夹（可先 zip）分享给朋友。
4. 对方在 DeskPet 设置 → 我的桌宠 →「导入桌宠包」选择该文件夹（内含 `pet.json`）。
5. 导入后会自动设为当前桌宠；`id` 会重新生成，因此不会覆盖已有桌宠。

## 手动制作

也可以完全手写：

```text
my-cat/
├── pet.json
├── sprite.png          # 透明 PNG
├── frames/wave/0.png
├── frames/wave/1.png
└── sounds/wave.mp3
```

```json
{
  "schema": "deskpet/pet@1",
  "id": "my-cat",
  "name": "我的猫",
  "author": "you",
  "version": "1.0.0",
  "kind": "custom",
  "createdAt": 0,
  "updatedAt": 0,
  "sprite": { "kind": "image", "asset": "sprite.png", "width": 512, "height": 512 },
  "greeting": "我来啦！",
  "actions": [
    {
      "id": "wave",
      "name": "挥手",
      "trigger": "click",
      "animation": "wave",
      "durationMs": 1200,
      "frames": ["frames/wave/0.png", "frames/wave/1.png"],
      "frameDurationMs": 160,
      "sound": "sounds/wave.mp3",
      "say": "你好呀！",
      "cooldownMs": 1000,
      "enabled": true,
      "emotion": "happy"
    }
  ]
}
```

> 手动制作的包在导入时会校验文件存在性；`createdAt/updatedAt` 可以填 0。
