# 校园网自动登录（Windows + Arch Linux）

针对**网页认证（Portal / Captive Portal）型校园网**的自动登录脚本。

**纯 Python 3 标准库实现，零第三方依赖**：Windows 和 Arch Linux 共用同一份代码，
不需要 `pip install`、不需要管理员/root 权限、不需要编译。

```
未联网 ──► 跟随网关跳转找到认证页 ──► 解析 <form> 填账号密码 ──► 提交 ──► 再探测确认
                                          ▲                          │
                                          └──── 失败/掉线则重试 ◄─────┘
```

在此之上还有一层 **Wi-Fi 管理**（`auto_connect.py`：Linux 走 NetworkManager/`nmcli`，
Windows 走 `netsh wlan`）：开机按优先级连上所有“已保存”的网络；一个都连不上且你人在
终端前时，扫描周边 Wi-Fi 问你要连哪个、要不要保存密码和优先级；连上以后再自动判断
是不是需要网页认证的公共网络（校园网），是就用保存的账号完成认证。

```
开机 ─► 依次连接已保存的网络（优先级 1 先试）
         │ 连上 ─► 探测是否被劫持到认证页
         │          ├ 是 + 有账号 ─► 自动认证 ✔
         │          └ 是 + 无账号 ─► 问你要账号密码，写进 config.json 后认证
         └ 全失败 ─► 有终端？ ├ 有 ─► 扫描 Wi-Fi ─► 你选一个 ─► 问密码/是否保存/优先级
                              └ 无（开机自启）─► 安静退出，绝不卡住开机
```

## 特性

| 能力 | 说明 |
| --- | --- |
| 自动探测 | 依次访问 `generate_204` / `connecttest.txt` 等轻量探针，用状态码判断是否已联网 |
| 自动发现入口 | 未联网时跟随 302、`Location`、`<meta refresh>`、JS `location` 跳转找到认证页 |
| 通用表单自适应 | 解析页面里所有 `<form>`，按字段名启发式识别账号/密码，**并原样带上隐藏字段（token 等）** |
| 协议预设 | `srun`(深澜，自动区分 classic / eportal 两代接口) / `drcom` / `h3c` / `ruijie`，字段名与密码编码都能被配置覆盖 |
| 幂等 | 已经联网就什么都不做，不会反复登录（避免账号被风控） |
| 结果以联网为准 | 提交后重新探测确认，不轻信页面上的“成功”字样 |
| 常驻重连 | `--watch`；Linux 用 systemd timer / NetworkManager 钩子，Windows 用计划任务 |
| 调试友好 | `--debug` 打印请求细节，`--capture <目录>` 把每个请求/响应落盘，专门用来适配自家门户 |
| 双平台 | 同一脚本；Windows 自动切 UTF-8 控制台，日志分别写 `%LOCALAPPDATA%` / `$XDG_STATE_HOME` |
| Wi-Fi 自动连接 | 开机按**优先级**依次连接所有已保存的网络（系统 profile ∪ config.json 记录） |
| 交互式选网 | 一个都没连上时扫描周边 Wi-Fi 让你选；可选「保存密码 + 优先级」或「只连这一次」 |
| 公共网络自动认证 | 连上后自动判断是否被劫持；缺账号密码时问你要一次并写回 config.json，之后全自动 |
| 门户与 SSID 解耦 | 「寝室网 SSID + 校园网认证页」这类组合天然支持：顶层账号对所有网络生效，`portal.enabled=false` 可让某个网络绝不提交账号 |
| 多网卡感知 | 有线抢了默认路由时判断门户探测会走哪条线路，只在可行时绑定无线网卡，绝不静默误判/超时 |
| 不打扰开机 | 无终端（systemd 自启 / 计划任务）时绝不阻塞，安静退出，交给下一轮重试 |
| 跨平台后端 | Linux = `nmcli`；Windows = `netsh wlan`（自动生成并导入 WLAN profile XML） |

## 目录结构

```
auto-login-school-wifi/
├── portal_login.py        # 校园网门户认证主程序
├── auto_connect.py        # Wi-Fi 连接管理 + 选网询问 + 调用上面的认证（推荐入口）
├── wifi_manager.py        # 跨平台 Wi-Fi 后端（nmcli / netsh），也可单独运行排查
├── config.example.json    # 配置模板（字段含义写在 _comment 里）
├── tests/
│   ├── mock_portal.py     # 本地模拟门户（开发自测用，可独立运行）
│   ├── selftest.py        # 门户认证端到端自测（8 个用例 / 13 项断言）
│   └── test_wifi.py       # Wi-Fi 层离线自测（149 项断言，不需要网卡/不联网）
├── linux/
│   ├── install.sh         # systemd --user 服务 + timer（可选 NM 钩子、桌面询问）
│   ├── uninstall.sh
│   └── wifi-prompt.sh     # 进桌面若没网就弹终端问你要连哪个 Wi-Fi
├── windows/
│   ├── login.bat          # 双击即可登录（也可放进「启动」文件夹）
│   ├── install.ps1        # 注册计划任务（登录时 + 网络连接时 + 定时兜底）
│   ├── uninstall.ps1
│   └── wifi-prompt.vbs    # 登录后若没网就弹控制台问你要连哪个 Wi-Fi
└── README.md
```

## 快速开始

Windows 把下面命令里的 `python3` 换成 `python`（或 `py -3`）即可，其余完全一致。

### 只做校园网认证（最小用法）

```bash
# 1) 生成配置模板（POSIX 下会自动 chmod 600）
#    已存在 config.json 时不会覆盖（避免清空账号密码）；确实要重来加 --force
python3 portal_login.py --init

# 2) 编辑 config.json，至少填 username / password；type 一般保持 "auto"

# 3) 看一眼现在联网了没有（只检测，不登录）
python3 portal_login.py --status

# 4) 登录一次
python3 portal_login.py

# 5) 常驻运行，掉线自动重连（Ctrl+C 退出）
python3 portal_login.py --watch
```

退出码：`0` = 已联网 / 登录成功，`1` = 登录失败，`2` = 配置或网络环境有问题。
可以据此接入自己的脚本或监控。

### 连 Wi-Fi + 校园网认证（推荐入口）

```bash
# 0) config.json 不存在时会自动生成模板（也可以先 python3 portal_login.py --init）

python3 auto_connect.py --list     # 看看已保存的 / 现在能搜到的 Wi-Fi
python3 auto_connect.py            # 智能模式：能连就连，连不上且在终端前就问你要连哪个
python3 auto_connect.py --ask      # 直接进入「扫描 + 选网」向导
python3 auto_connect.py --boot     # 模拟开机自启：只连已保存网络 + 认证，不询问
```

第一次推荐这样走一遍：**`--ask` → 选一个校园网 Wi-Fi → 输 Wi-Fi 密码 → 选“保存” →
设优先级 → 被问到时填学号密码**。之后配置就齐了，开机全自动（见下面两个平台的安装章节）。

## 命令行参数

```
usage: portal_login.py [-h] [-c CONFIG] [--init] [--force]
                       [-u USERNAME] [-p PASSWORD]
                       [-t {auto,srun,drcom,h3c,ruijie}]
                       [--portal-url PORTAL_URL]
                       [--password-encoding PASSWORD_ENCODING] [--watch]
                       [--interval INTERVAL] [--status] [--probe-url URL]
                       [--bind-address IP] [--capture DIR] [--log LOG_FILE]
                       [-q] [--debug] [--version]

options:
  -c, --config CONFIG      配置文件路径（默认：脚本目录下的 config.json）
  --init                   生成配置模板后退出（已存在则拒绝，见 --force）
  --force                  与 --init 一起用：覆盖已存在的 config.json（会清空原内容）
  -u, --username USERNAME  学号/账号（覆盖配置文件）
  -p, --password PASSWORD  密码（覆盖配置文件；注意会留在命令历史里）
  -t, --type {auto,srun,drcom,h3c,ruijie}
                           认证类型，默认 auto（通用表单自适应）
  --portal-url URL         认证页面地址（覆盖配置文件）
  --password-encoding ...  密码编码：auto|plain|base64|md5|md5-upper|md5-16|sha1|url
  --watch                  常驻运行，掉线自动重连
  --interval SECONDS       --watch 的检测间隔秒数
  --status                 只检测联网状态，不登录
  --probe-url URL          自定义探测地址，可重复使用（特殊校园网/测试用）
  --bind-address IP        把探测/认证的源地址绑定到该 IPv4（多网卡时指定走无线网卡）
  --capture DIR            把所有 HTTP 请求/响应保存到目录（适配门户用）
  --log FILE               日志文件路径
  -q, --quiet              只在出错时输出（适合放进定时任务）
  --debug                  输出调试信息
  --version                显示版本号
```

## Wi-Fi 自动连接（auto_connect.py）

`auto_connect.py` 负责“先有网、再认证”，和 `portal_login.py` 共用同一份 `config.json`。

### 命令行参数

```
usage: auto_connect.py [-h] [-c CONFIG] [--boot] [--ask] [--list]
                       [--connect SSID] [--key KEY] [--save]
                       [--priority PRIORITY] [--forget SSID] [--no-wifi]
                       [--non-interactive] [--capture DIR] [--log LOG] [-q]
                       [--watch] [--interval INTERVAL] [--debug] [--version]

  不带参数           智能模式：依次连已保存网络 → 认证；都连不上且有终端就扫描并问你
  --boot             开机自启用：只连已保存网络 + 认证，绝不询问（无终端也不会卡住）
  --ask              强制进入向导：扫描周边 Wi-Fi → 你选编号 → 问密码/是否保存/优先级
  --list             列出已保存的 / 当前可见的网络和当前连接，然后退出
  --connect SSID     直接连指定网络（--key 密码、--save 保存、--priority 1-9 优先级）
  --forget SSID      删除某个已保存的网络（系统 profile + config.json 记录）
  --no-wifi          跳过 Wi-Fi 管理，只做网页认证（等同以前只用 portal_login.py）
  --watch --interval 常驻守护：每 N 秒重连 + 认证一次
```

退出码：`0` 成功，`1` 没连上，`2` 出错，`3` 用户主动跳过。

### 交互向导长什么样

```
$ python3 auto_connect.py --ask
==============================================================
下面扫描周边 Wi-Fi，请选择要连接的网络（标 [已保存] 的不用再输密码）：
   1) CampusWiFi              信号  78%  WPA2            [已保存]
   2) DSU-Open                信号  32%  开放
   3) Lab:2.4G                信号  55%  WPA2
   0) 跳过（不连接）
请输入要连接的编号（回车 / 0 = 跳过）: 3
请输入 Lab:2.4G 的 Wi-Fi 密码: ******
是否保存这个网络和密码（以后自动连接）？ [Y/n] y
现有网络优先级（数字越小越先连接）：
  1) CampusWiFi
请设置 Lab:2.4G 的优先级 1-9（回车 = 2）: 2
已保存网络 Lab:2.4G（优先级 2，密码写入 /path/config.json）
[OK] 网络已连通，无需认证（http://...generate_204 判定为已联网（HTTP 204））
```

如果连上的是**需要网页认证的公共网络**（校园网），会接着问：

```
这个网络需要网页认证（典型的校园网）。
认证页面: http://10.0.0.2/srun_portal_pc
现在填写账号密码并保存到配置文件？ [Y/n] y
账号 / 学号: 20240001
密码: ******
已把账号密码保存到 config.json（明文保存，注意别提交到 git）
[OK] 校园网自动登录成功
```

选“不保存”时就只建立这一次连接，不写 `config.json`（准确含义见下面的已知限制）。

### config.json 里的 wifi 段

```json
"wifi": {
  "auto_connect": true,     // 启动时按优先级依次连接所有已保存网络
  "interactive": true,      // 都连不上时是否在终端里询问用户
  "prompt_timeout": 30,     // 询问等待秒数，超时视为跳过（0 = 一直等）
  "connect_timeout": 25,    // 单个网络的连接确认等待秒数
  "portal_via_wifi": true,  // 多网卡时是否把门户探测/认证绑定到无线网卡（见「多网卡机器」）
  "networks": [
    {
      "ssid": "CampusWiFi",
      "key": "Wi-Fi 密码（开放网络留空）",
      "priority": 1,        // 数字越小越先连接
      "security": "wpa2",
      "portal": {           // 该网络的网页认证账号（留空则用全局 username/password）
        "enabled": true,
        "username": "20240001",
        "password": "网页认证密码",
        "type": "auto",
        "portal_url": ""
      }
    },
    {
      "ssid": "ChinaNet-109-5G",   // 寝室网：认证页还是同一个校园网门户 → 不用写 portal
      "key": "Wi-Fi 密码",
      "priority": 2
    }
  ]
}
```

`wifi.networks` 通常不用手写，向导会自动维护。注意区分两个密码：

* `key` = **Wi-Fi 密码**（连 AP 用）；
* `portal.password` = **网页认证密码**（校园网登录用），留空则退回全局 `password`；
* `priority` 会同时写进系统（Linux 的 `connection.autoconnect-priority`、Windows 的 `profileorder`）。

### 认证页是「校园网」、SSID 却是「寝室网」怎么办？

很常见：寝室网、教学楼、图书馆的 SSID 各不相同，但被劫持到的认证页是**同一个**校园网门户。
这时只要在 `config.json` **顶层**填一次账号密码就够了：

```json
{
  "username": "20240001",
  "password": "校园网密码",
  "portal_url": "",
  "wifi": {
    "networks": [
      {"ssid": "ChinaNet-109-5G", "key": "寝室网密码", "priority": 1},
      {"ssid": "HDU-WLAN",        "key": "",           "priority": 2}
    ]
  }
}
```

规则只有三条：

| 情况 | 怎么写 |
| --- | --- |
| 多个网络共用一套校园网账号（最常见） | 只填顶层 `username` / `password`；`wifi.networks` 里只写 `ssid` / `key` / `priority` |
| 某个网络要用**另一个**账号 | 在该网络里写 `"portal": {"username": ..., "password": ...}` 覆盖顶层的 |
| 某个网络**绝不要**自动提交校园网账号（酒店 / 商场 / 朋友家的 Wi-Fi） | 在该网络里写 `"portal": {"enabled": false}` |

`portal.enabled = false` 时脚本只连接、不做任何网页认证，**不会把校园网账号发给别人家的
认证页**；这类网络想上网就用浏览器自己登录。默认（不写 `portal`）是允许自动认证，因为
“不同 SSID、同一个校园网门户”才是最普遍的情况。

### 多网卡机器：有线插着、Wi-Fi 也连着

一台机器同时有线和无线在线时，**系统只有一个默认路由**（看 `ip route show default` 的
metric，数字小的赢）。门户探测和认证都跟着默认路由走，于是可能：

* Wi-Fi 其实需要校园网认证，但探测从有线出去拿到「已联网」→ 脚本按“无需认证”跳过；
* 或者请求被引导到错误的线路，直接超时。

脚本的处理（`wifi.portal_via_wifi`，默认 `true`）：

1. 比较无线网卡的 IPv4 与默认路由的源地址；一致（单网卡）就什么都不做；
2. 不一致时先问内核：`ip route get 1.1.1.1 from <无线网卡IP>` 会从哪张网卡出去；
3. **只有内核确实会走无线网卡**时，才把门户会话绑定到无线网卡（源地址 `bind_address`），
   否则保持原样并打印一行提示（`--list` 里也能看到判断结果）。

绑定实现上还踩过一个坑：绑定**必须按源地址的地址族解析**。校园网 DNS 经常只给
AAAA（或把 IPv6 排在前面），而 `socket.create_connection` 会在 AF_INET6 的 socket 上
bind 一个 IPv4 源地址，直接抛 `gaierror: [Errno -9] Address family for hostname not
supported`，整条探测链路都会失败。现在绑定 IPv4 时只解析 IPv4（见
`portal_login._create_bound_socket`），确实没有 IPv4 地址时给的是看得懂的错误。

为什么不无脑绑定：Linux 在普通路由表下会忽略源地址、仍按默认路由发包，绑定后请求会**全部
超时**——可以用 `ip route get 1.1.1.1 from <无线网卡IP>` 自己验证（输出里的 `dev` 不是
无线网卡就说明绑不了）。这种情况下想按无线网卡判断/认证校园网，最直接的办法是**拔掉有线网线**
再运行；进阶用户可以配策略路由（`ip rule`），再用 `bind_address` 手动指定源地址：

```bash
python3 auto_connect.py --list                                  # 看默认路由 / 无线网卡地址和提示
python3 portal_login.py --status --bind-address 10.150.175.108  # 手动指定源地址探测
```

### 已知限制：**只连一次**到底是什么含义

`nmcli` 和 `netsh` 都没有“不落盘就把密码交给系统”的能力，所以选“不保存”时，实际行为是：
连上之后立刻把该配置改成**不自动连接**（`connection.autoconnect no` / `connectionMode=manual`），
本次会话照常使用，但下次开机不会自动连它。要彻底删掉：
`python3 auto_connect.py --forget <SSID>`。

另外，一块无线网卡同一时间只能连一个 AP，所以“连接所有已保存的网络”＝**按优先级依次尝试，
第一个成功的就用**，而不是同时连上多个。

## 配置文件说明

`config.json` 与脚本放同一目录（也可用 `-c` 指定别处）。只有 `username` / `password` 必填：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `username` / `password` | — | **必填**：学号/工号与密码 |
| `type` | `"auto"` | `auto` 通用自适应（遇到深澜的 JS 页面会自动切到 `srun`）；`srun` 深澜；`drcom`；`h3c`；`ruijie` |
| `portal_url` | `""` | 认证页地址。留空 = 自动跟随网关跳转发现；`type=srun` 时可以只填服务器根地址，如 `http://10.0.0.2` |
| `srun_protocol` | `"auto"` | 深澜接口世代：`auto` 先探测、`classic`（`/cgi-bin/srun_portal`）、`eportal`（`/eportal/portal/login`） |
| `srun_ac_id` | `""` | 深澜的 `ac_id`，留空自动从认证页 URL（`?ac_id=32`）里取，取不到用 `1` |
| `username_field` | `""` | 账号字段名，留空自动识别。例：`DDDDD`、`userid`、`user_account` |
| `password_field` | `""` | 密码字段名，留空自动识别。例：`upass`、`passwd`、`user_password` |
| `password_encoding` | `"auto"` | `auto` / `plain` / `base64` / `md5` / `md5-upper` / `md5-16` / `md5-16-upper` / `sha1` / `url`；`auto` 会先看页面里有没有 `btoa`、`md5` 再决定 |
| `extra_fields` | `{}` | 额外固定参数，会一并提交。例：`{"0MKKey": "123456"}` |
| `method` | `""` | 强制用 `GET`/`POST`；留空则用 `<form>` 自带的方式 |
| `probe_urls` | `[]` | 自定义探针，如 `[{"url": "http://1.1.1.1/generate_204", "expect": "204"}]`；`expect` 支持 `204`、`200`、`body:关键字` |
| `local_ip` | `""` | 本机 IP，留空自动探测（只有门户要求上报 `wlan_user_ip` 时才需要） |
| `user_agent` | Chrome UA | 个别门户会校验 UA，可改成手机 UA 试试 |
| `insecure_tls` | `true` | 忽略 HTTPS 证书错误（校园网自签证书很常见） |
| `use_env_proxy` | `false` | 是否走环境变量里的 HTTP 代理；内网认证建议保持 `false` |
| `bind_address` | `""` | 把探测/认证的源地址绑定到该 IPv4（多网卡时指定走哪张网卡）；留空 = 自动判断，见「多网卡机器」 |
| `timeout` | `8` | 单次请求超时秒数 |
| `interval` | `30` | `--watch` 的检测间隔秒数 |
| `verify_interval` | `2` | 登录后复查的间隔（最多复查 3 次） |
| `log_file` | `""` | 日志路径，留空则写到用户状态目录 |
| `wifi.auto_connect` | `true` | 启动时是否按优先级依次连接所有已保存的网络 |
| `wifi.interactive` | `true` | 都连不上时是否在终端里询问用户 |
| `wifi.prompt_timeout` | `30` | 询问等待秒数，超时按“跳过”处理（`0` = 一直等） |
| `wifi.connect_timeout` | `25` | 单个网络的连接确认等待秒数 |
| `wifi.portal_via_wifi` | `true` | 多网卡时是否把门户探测/认证绑定到无线网卡（内核路由不支持时会自动跳过并提示） |
| `wifi.networks` | `[]` | 已保存的网络列表（详见上一节）；向导会自动维护，一般不用手写 |
| `wifi.networks[].portal.enabled` | `true` | 设成 `false` = 这个网络绝不自动提交校园网账号（酒店/商场 Wi-Fi） |

不想把密码写进磁盘时，可以用环境变量（优先级：命令行 > 环境变量 > 配置文件）：

```bash
# Linux / macOS
export CAMPUS_PORTAL_USERNAME=20240001
export CAMPUS_PORTAL_PASSWORD='你的密码'
python3 portal_login.py
```

```powershell
# Windows PowerShell
$env:CAMPUS_PORTAL_USERNAME = '20240001'
$env:CAMPUS_PORTAL_PASSWORD = '你的密码'
python portal_login.py
```

默认日志位置：Linux 为 `$XDG_STATE_HOME/auto-login-school-wifi/login.log`（通常是
`~/.local/state/...`），Windows 为 `%LOCALAPPDATA%\auto-login-school-wifi\login.log`。

## Arch Linux：开机自动登录

提供的是 systemd **用户级**（`--user`）服务，**不需要 root**：

```bash
bash linux/install.sh                        # 默认：开机自动连 Wi-Fi + 认证，每 120 秒兜底
bash linux/install.sh --watch                # 换成常驻守护进程（掉线立刻重连）
bash linux/install.sh --interval 60          # 自定义兜底间隔为 60 秒
bash linux/install.sh --with-autostart       # 进桌面若没网，弹终端问你要连哪个 Wi-Fi
bash linux/install.sh --no-wifi-auto         # 不装 Wi-Fi 管理，只做网页认证（旧行为）
bash linux/install.sh --with-nm-dispatcher   # 额外装 NetworkManager 钩子（需要 sudo）
```

默认行为：只要系统里有 `nmcli`（NetworkManager）且 `auto_connect.py` 存在，服务执行的
就是 `auto_connect.py --boot` —— 开机把所有已保存的 Wi-Fi 按优先级连一遍，再完成校园网认证。
想退回“只做网页认证”就用 `--no-wifi-auto`。

`--with-autostart` 会额外往 `~/.config/autostart/` 放一个自启动项（内部调用
`linux/wifi-prompt.sh`）：**只有在完全没有任何网络连接时**，才弹出一个终端窗口运行
`auto_connect.py --ask` 让你选 Wi-Fi；平时开机不会打扰你。

`--with-nm-dispatcher` 会往 `/etc/NetworkManager/dispatcher.d/90-campus-net-login` 放一个钩子，
网卡一 up 就立刻触发登录，不用等 timer（宿舍/教室之间来回插拔网线时很有用）。

常用命令：

```bash
systemctl --user status campus-net-login.timer           # 看定时器
systemctl --user list-timers 'campus-net-login*'         # 看下次触发时间
systemctl --user start campus-net-login.service          # 立刻手动跑一次
journalctl --user -u campus-net-login -n 50 --no-pager   # 看最近日志
systemctl --user disable --now campus-net-login.timer    # 临时停用
bash linux/uninstall.sh [--purge-nm-dispatcher]          # 卸载
```

安装脚本会自动执行 `loginctl enable-linger $USER`，这样即使你没开终端（比如刚开机、
还没 SSH 上来），timer 也会照常运行。若没权限，手动跑一次
`sudo loginctl enable-linger $USER` 即可。

生成的单元文件（位于 `~/.config/systemd/user/`）大致如下：

```ini
# campus-net-login.service
[Unit]
Description=校园网自动登录（auto-login-school-wifi）
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
# 默认（有 nmcli 时）：连已保存的 Wi-Fi + 校园网认证；加 --no-wifi-auto 则只做认证
ExecStart=/usr/bin/python3 /路径/auto_connect.py --boot --config /路径/config.json --quiet
SuccessExitStatus=0 1 2 3      # 失败也不标记为服务失败，下一轮 timer 会重试

# campus-net-login.timer
[Timer]
OnBootSec=30
OnUnitActiveSec=120s
AccuracySec=10s
Persistent=true

[Install]
WantedBy=timers.target
```

## Windows：开机自动登录

需要 Python 3.8+（安装时勾选 *Add python.exe to PATH*）。在**普通** PowerShell 里执行：

```powershell
powershell -ExecutionPolicy Bypass -File windows\install.ps1
powershell -ExecutionPolicy Bypass -File windows\install.ps1 -IntervalMinutes 5
powershell -ExecutionPolicy Bypass -File windows\install.ps1 -NoRepeat
powershell -ExecutionPolicy Bypass -File windows\install.ps1 -WithAutostart   # 登录时若没网就弹窗问 Wi-Fi
powershell -ExecutionPolicy Bypass -File windows\install.ps1 -NoWifi          # 不装 Wi-Fi 管理，只做认证
```

脚本会注册名为 `CampusNetAutoLogin` 的计划任务（路径 `\CampusNetwork\`），
用 `pythonw.exe` 运行，**不会弹黑窗口**。触发条件：

1. 用户登录时；
2. 网络连接事件（`Microsoft-Windows-NetworkProfile/Operational`，EventID 10000）；
3. 每 N 分钟兜底轮询（默认 5 分钟，可用 `-NoRepeat` 关掉）。

默认执行的是 `auto_connect.py --boot --quiet`（该文件存在且没加 `-NoWifi` 时）：
开机把已保存的 Wi-Fi 按优先级连一遍，再做校园网认证。

加 `-WithAutostart` 会再注册一个 `CampusWifiPrompt` 任务（登录时触发，调用
`windows\wifi-prompt.vbs`）：**只有在完全没有网络连接时**才弹出一个 cmd 窗口运行
`auto_connect.py --ask` 让你选 Wi-Fi；有网时什么都不做。

常用命令：

```powershell
Start-ScheduledTask -TaskName CampusNetAutoLogin -TaskPath '\CampusNetwork\'    # 立刻执行
Get-ScheduledTask CampusNetAutoLogin | Format-List                              # 查看状态
Disable-ScheduledTask -TaskName CampusNetAutoLogin -TaskPath '\CampusNetwork\'  # 临时停用
powershell -ExecutionPolicy Bypass -File windows\uninstall.ps1                  # 卸载
```

不想用计划任务的话，把 `windows\login.bat` 的**快捷方式**丢进启动文件夹
（Win+R 输入 `shell:startup`）也一样能开机自动登录。

> `login.bat` 双击即可手动登录一次，它会自动在 `python` / `py -3` 里找可用的解释器。

## 适配你自己的门户（重点）

`auto` 模式能覆盖大多数**纯表单**门户。如果第一次没成功，按下面三步走，一般十分钟内搞定。

### 第 1 步：抓包

```bash
python3 portal_login.py --debug --capture ./capture
```

`./capture/` 里每个 HTTP 交互会保存成一个文件，文件名形如
`001-POST_http_10.0.0.2_portal_login.txt`，内容形如：

```
# ---------- 请求 ----------
POST http://10.0.0.2/portal/login
--- 请求头 ---
User-Agent: Mozilla/5.0 ...
Content-Type: application/x-www-form-urlencoded
--- 请求体 ---
username=20240001&password=...&token=...&wlanuserip=10.1.2.3

# ---------- 响应 ----------
HTTP 200  (最终地址: http://10.0.0.2/portal/login)
--- 响应头 ---
Content-Type: text/html; charset=gb2312
--- 响应体（最多 20000 字符）---
<html>...登录成功...</html>
```

同时也建议在浏览器里手动登录一次：按 `F12` → Network → 勾选 **Preserve log**，
找到“提交后返回 JSON / 触发跳转”的那个请求，对照它的 **URL / Method / Form Data**。

### 第 2 步：把差异写进 config.json

| 观察到的情况 | 怎么改配置 |
| --- | --- |
| 字段名不是 username/password | 填 `username_field` / `password_field` |
| 有固定参数（`0MKKey`、`wlan_ac_name`…） | 加到 `extra_fields` |
| 不是 POST 提交 | 设 `method` 为 `"GET"` 或 `"POST"` |
| 密码先做了 md5 / base64 | 设 `password_encoding` |
| 认证页不在自动发现的地址上 | 填 `portal_url`（浏览器地址栏里那个就行） |
| 认证页地址里有 `srun_portal_pc` 或 `/cgi-bin/`（深澜） | `"type": "srun"`（一般不用手填，`auto` 也会自动识别）；`portal_url` 可只填服务器根地址如 `http://192.168.112.30` |
| 探测地址被校园网劫持 | 用 `probe_urls` 换成学校自己的 `generate_204` 地址 |
| 连的是寝室网，认证页却是校园网的 | 顶层 `username`/`password` 对所有网络生效，`wifi.networks` 里只写 `ssid`/`key`/`priority` 即可，见「认证页是校园网、SSID 却是寝室网」 |
| 有线插着时探测总说“已联网，无需认证” | 默认路由在有线上，门户探测跟着它走；看 `--list` 的提示，必要时拔掉网线或用 `bind_address`，见「多网卡机器」 |
| 日志里出现 `[Errno -9] Address family for hostname not supported` | 绑定源地址时该域名解析到了 IPv6（校园网 DNS 常只给 AAAA）：在 AF_INET6 的 socket 上 bind IPv4 源地址就是这个报错。现在绑定 IPv4 时只按 IPv4 解析，不再出现；若仍遇到，把该探针换成 IPv4 地址 |

### 第 3 步：验证

```bash
python3 portal_login.py --debug
```

日志会打印识别到的账号字段、密码字段、密码编码、提交地址、随同提交的字段，
以及返回结果摘要。看到 `[OK] 校园网自动登录成功` 就成了。

### 深澜（Srun）的两代接口

深澜门户有两套互不兼容的登录接口，脚本会先探测再决定（也可用 `srun_protocol` 强制）：

| 世代 | 判据 | 登录方式 |
| --- | --- | --- |
| classic | `GET /cgi-bin/get_challenge` 返回 `challenge` | `GET /cgi-bin/srun_portal`，带 `chksum`（sha1）+ `info`（XEncode 后按自定义字母表 base64） |
| eportal | 没有 `get_challenge`，`/eportal/portal/login` 可访问 | 密码 base64 后直接放在 URL 里 |

classic 的加密实现是**逐字节对照门户自己的 JS**（`Portal.js` 的 `encode()` +
`all.min.js` 里 `jquery-base64` 的 `setAlpha` 字母表）写的，几处容易踩错的点：

* `hmd5 = md5(password, token)` 里的 `md5()` 只接受一个参数，**token 实际被忽略**，就是 `md5(password)`；
* `info` 里的 `password` 是**明文**（外面由 XEncode 保护），不是 md5；
* base64 用的是 `LVoJPiCN2R8G90yg+hmFHuacZ1OWMnrsSTXkYpUq/3dlbfKwv6xztjI7DeBE45QA`，不是标准字母表；
* `ac_id` 从认证页 URL 的 `?ac_id=` 取（常见 32），`n=200`、`type=1`、`double_stack=0` 要原样带上。

`tests/test_wifi.py` 里固化了由该 JS 算出的黄金向量（`info` / `chksum` / `md5`），
并用本地 mock 门户跑完整提交，所以以后改这块不需要再连真实校园网就能验证。

## 常见问题

**Q：提示“找不到认证页面”，但浏览器打开就能跳出来？**
浏览器的跳转常常是 JS 拼出来的，脚本只能跟随 `Location`、`<meta refresh>` 和简单的
`location.href` 赋值。把浏览器地址栏里认证页的实际 URL 填到 `portal_url` 即可。

**Q：提示“没能自动识别账号/密码字段”？**
看 `--capture` 抓到的表单 HTML，把两个字段名填进 `username_field` / `password_field`。

**Q：提示“在 http://…/srun_portal_pc?ac_id=32 没有找到登录表单”？**
这是深澜（Srun）的门户：登录框由 JS 动态渲染，HTML 里本来就没有 `<form>`。
脚本现在会识别出这种情况并自动切到 `srun` 适配器：先 `GET /cgi-bin/get_challenge`
取 token，再按门户自己的 JS 算法算出 `chksum`（sha1）和 `info`（XEncode + 自定义字母表 base64），
`GET /cgi-bin/srun_portal` 提交。老版本只支持 `/eportal/portal/login`，遇到这种门户必然失败。
若还报这个错，说明页面既没有深澜特征也真没有表单，用 `--capture` 抓下来再适配。

**Q：日志里偶尔出现“请求认证服务器失败: timed out”，但浏览器打得开？**
实测刚连上 i-HDU 时门户会丢 SYN——裸 TCP `connect` 都可能连续两次 8 秒超时，
第三次却只要 69ms。脚本现在对门户请求做最多 4 次退避重试，4 次都超时才是真的连不上。
校园网门户比较慢时，也可以把 `timeout` 从 8 调到 12。

**Q：页面返回“登录成功”，但复检仍显示未联网？**
说明提交没被网关采纳，通常是缺 `wlan_user_ip` / `wlan_ac_name` 之类的参数。
对照浏览器请求补进 `extra_fields`；深澜用户直接用 `type=srun`，脚本会自动带上这些参数。

**Q：明明能上网，`--status` 却说未联网？**
探测地址被劫持或走了透明代理。用 `probe_urls` 换成学校自己的无重定向地址，
或者干脆把这个脚本只当作“登录器”使用。

**Q：中文乱码？**
脚本按 `Content-Type` 的 charset 解码，并依次回退尝试 UTF-8 / GB18030 / Big5；
Windows 控制台也会被自动切到 UTF-8。

**Q：HTTPS 证书报错？**
默认已忽略（`insecure_tls: true`），因为校园网自签证书很常见；想恢复严格校验设为 `false`。

**Q：密码里有 `@`、`%`、空格？**
脚本会正确做 URL 编码；只是用 `-p` 写在命令行时注意 shell 展开，建议写进
`config.json` 或用环境变量。

**Q：会不会把密码发到网上？**
不会。脚本只向「探测地址 + 认证页所在主机」发请求，没有任何硬编码的第三方服务器，
也不会执行下载来的内容。整个 `portal_login.py` 可以通读，纯标准库、无动态执行。

**Q：开机后没有自动连 Wi-Fi，也没问我要连哪个？**
开机阶段（systemd / 计划任务）没有终端，脚本不会阻塞等待输入，会安静退出并交给下一轮重试。
想让它“一个网络都没有时来问你”，请装带交互入口的那一套：

* Linux：`bash linux/install.sh --with-autostart`
* Windows：`powershell -ExecutionPolicy Bypass -File windows\install.ps1 -WithAutostart`

也可以随时手动跑 `python3 auto_connect.py --ask`。

**Q：`--list` 里已保存的网络显示“信号 - / 未知”？**
保存的 profile 本身不含信号强度和加密方式（那是扫描时才有的信息），脚本如实显示为未知，
而不是猜一个值。

**Q：想让某个 Wi-Fi 最后才连？**
```bash
python3 auto_connect.py --connect <SSID> --save --priority 9   # 数字越小越先连
```
也可以直接改 `config.json` 里对应网络的 `priority`。

**Q：Linux 上没有 nmcli？**
Wi-Fi 层需要 NetworkManager。Arch 上装并启用它：
`sudo pacman -S networkmanager && sudo systemctl enable --now NetworkManager`。
找不到 nmcli 时脚本会自动退回“只做网页认证”模式（也可用 `--no-wifi` 显式跳过）。

**Q：Windows 上 Wi-Fi 密码存到哪了？**
导入的是标准 WLAN profile（和手动连一次 Wi-Fi 完全一样，凭据在系统里），
脚本另外在 `config.json` 里留了一份自己的记录。注意 `key` 是 Wi-Fi 密码，
`portal.password` 才是校园网认证密码。

## 开发与自测

仓库自带本地模拟门户，不用连真实校园网就能端到端验证：

```bash
python3 tests/selftest.py
```

它会临时启动 `tests/mock_portal.py`（302 跳转 + GB2312 页面 + 隐藏 token 校验 +
深澜 JSONP 接口),然后从外部调用 `portal_login.py`，覆盖 8 个场景 / 13 项断言：

```
[1/8] --init 生成配置模板
[2/8] 未登录时 --status 应返回 1
[3/8] 通用表单自适应：正确账号密码登录（并校验隐藏 token 是否被完整提交）
[4/8] 已登录时 --status 应返回 0，且不重复登录
[5/8] 密码错误时应返回 1，且不会误判为已联网
[6/8] 深澜 srun 模式（base64 密码 + JSONP 接口）
[7/8] drcom 预设（预设字段名不存在时回退到自动识别）
[8/8] --capture 抓包文件 / 日志文件
```

也可以单独把模拟门户跑起来玩：

```bash
python3 tests/mock_portal.py --port 18080         # 然后浏览器访问 http://127.0.0.1:18080/
```

### Wi-Fi 层自测（不需要网卡、不联网）

`wifi_manager.py` 里的解析函数都是纯函数（喂命令行输出、出结构体），`auto_connect.py`
的编排逻辑用 `FakeBackend` 驱动，所以整层可以完全离线验证：

```bash
python3 tests/test_wifi.py
```

覆盖 149 项断言：`nmcli` / `netsh` 输出解析（含中文界面、SSID 带冒号、转义还原）、
Windows WLAN profile XML 生成与转义、优先级排序、按优先级依次连接与失败回退、
向导的「保存 / 只连一次 / 开放网络 / 跳过」四种流程、公共网络缺凭据时的询问与写盘、
`--connect --save --priority`、`--forget`、`--list` 等命令行为。

真实网卡也可以直接用这条命令看后端状态：

```bash
python3 wifi_manager.py      # 后端类型 / 当前连接 / 已保存的网络 / 可见的网络
```

## 安全提示

* `config.json` 里是**明文密码**。脚本生成时会自动 `chmod 600`（POSIX），
  `.gitignore` 也已排除它，请**不要**提交到公开仓库。
* Wi-Fi 密码（`wifi.networks[].key`）和网页认证密码（`wifi.networks[].portal.password`）
  同样是明文，向导每次写盘都会重新 `chmod 600`。系统层面（nmcli / netsh）保存的凭据
  则走各自的安全存储，脚本不去读它。
* 更稳妥的方式是环境变量 `CAMPUS_PORTAL_USERNAME` / `CAMPUS_PORTAL_PASSWORD`。
* 脚本只发 HTTP 请求，从不执行外部内容；`--capture` 目录里都是纯文本。
* 登录频率过高可能触发学校的账号风控，`--watch` / timer 的间隔建议不小于 15 秒。

## 免责声明

本工具仅用于自动化**你自己账号**的校园网登录，请遵守所在学校的网络使用规定。
因使用不当（高频重试、账号共享等）造成的后果由使用者自行承担。



