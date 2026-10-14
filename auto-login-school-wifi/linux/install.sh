#!/usr/bin/env bash
# ============================================================================
#  校园网自动登录 - Arch Linux 安装脚本（systemd --user，无需 root）
#
#  用法：
#    bash linux/install.sh                       安装：开机自动连 Wi-Fi + 校园网认证 + 每 2 分钟兜底
#    bash linux/install.sh --watch               装成常驻守护服务（掉线即时重连）
#    bash linux/install.sh --interval 60         自定义兜底检测间隔（秒，默认 120）
#    bash linux/install.sh --with-autostart      额外装「进桌面若没网就弹终端问你连哪个 Wi-Fi」
#    bash linux/install.sh --no-wifi-auto        不用 auto_connect.py 管 Wi-Fi，只做网页认证
#    bash linux/install.sh --with-nm-dispatcher  额外装 NetworkManager 钩子（需要 sudo）
#    bash linux/install.sh --config /path/x.json 指定配置文件
#    bash linux/uninstall.sh                     卸载
#
#  默认行为：有 auto_connect.py 且系统装了 nmcli 时，服务执行
#      auto_connect.py --boot
#  即「按优先级依次连接所有已保存的 Wi-Fi → 探测是否被劫持 → 校园网自动认证」。
#
#  为什么用 --user 服务？  登录就能用、不需要 root，配置/日志都在自己家目录。
#  为什么要 enable-linger？即使没开终端，开机后 timer 也会照常运行。
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PY_SCRIPT="$ROOT_DIR/portal_login.py"
WIFI_SCRIPT="$ROOT_DIR/auto_connect.py"
CONFIG_FILE="${CAMPUS_LOGIN_CONFIG:-$ROOT_DIR/config.json}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
AUTOSTART_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
SERVICE="campus-net-login.service"
TIMER="campus-net-login.timer"
INTERVAL=120
MODE="timer"
NM_DISPATCHER=0
WITH_AUTOSTART=0
WIFI_AUTO="auto"   # auto | on | off

while [ $# -gt 0 ]; do
  case "$1" in
    --watch)              MODE="watch"; shift ;;
    --timer)              MODE="timer"; shift ;;
    --interval)           INTERVAL="${2:?--interval 后面要跟秒数}"; shift 2 ;;
    --config)             CONFIG_FILE="$2"; shift 2 ;;
    --with-nm-dispatcher) NM_DISPATCHER=1; shift ;;
    --with-autostart)     WITH_AUTOSTART=1; shift ;;
    --wifi-auto)          WIFI_AUTO="on"; shift ;;
    --no-wifi-auto)       WIFI_AUTO="off"; shift ;;
    -h|--help)            sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "未知参数: $1（用 --help 查看用法）" >&2; exit 2 ;;
  esac
done

msg() { printf '%s\n' "$*"; }
die() { printf '[ERROR] %s\n' "$*" >&2; exit 1; }

[ -f "$PY_SCRIPT" ] || die "找不到 $PY_SCRIPT"
command -v systemctl >/dev/null 2>&1 || die "没找到 systemctl（本脚本面向 Arch/systemd）"
PYTHON="$(command -v python3 2>/dev/null || true)"
[ -n "$PYTHON" ] || die "没找到 python3：sudo pacman -S python"

if [ ! -f "$CONFIG_FILE" ]; then
  "$PYTHON" "$PY_SCRIPT" --init --config "$CONFIG_FILE"
  die "已生成配置模板 $CONFIG_FILE，填好 username / password 后请重新运行本脚本"
fi

mkdir -p "$UNIT_DIR"

# --- 是否用 auto_connect.py 一起管 Wi-Fi（默认：文件在 + 有 nmcli 就用）--- #
USE_WIFI=0
case "$WIFI_AUTO" in
  on)   USE_WIFI=1 ;;
  off)  USE_WIFI=0 ;;
  auto) [ -f "$WIFI_SCRIPT" ] && command -v nmcli >/dev/null 2>&1 && USE_WIFI=1 ;;
esac
if [ "$WIFI_AUTO" = "on" ] && { [ ! -f "$WIFI_SCRIPT" ] || ! command -v nmcli >/dev/null 2>&1; }; then
  die "要求 Wi-Fi 自动管理（--wifi-auto），但缺少 auto_connect.py 或 nmcli"
fi

PY_RUN="$PY_SCRIPT"
PY_RUN_ARGS=""
WIFI_DESC="未启用（只做网页认证）"
if [ "$USE_WIFI" = "1" ]; then
  PY_RUN="$WIFI_SCRIPT"
  PY_RUN_ARGS="--boot"
  WIFI_DESC="已启用（连已保存网络 + 自动认证）"
fi

msg "Python     : $PYTHON"
msg "登录脚本   : $PY_SCRIPT"
[ "$USE_WIFI" = "1" ] && msg "Wi-Fi 脚本 : $WIFI_SCRIPT"
msg "配置文件   : $CONFIG_FILE"
msg "systemd目录: $UNIT_DIR"
msg "运行模式   : $MODE"
msg "Wi-Fi 管理 : $WIFI_DESC"

# --------------------------------------------------------------------------- #
# 生成 systemd 单元
# --------------------------------------------------------------------------- #
SERVICE_UNIT="$UNIT_DIR/$SERVICE"
TIMER_UNIT="$UNIT_DIR/$TIMER"

cat > "$SERVICE_UNIT" <<EOF
[Unit]
Description=校园网自动登录（auto-login-school-wifi）
Documentation=file://$ROOT_DIR/README.md
Wants=network-online.target
After=network-online.target

[Service]
EOF

if [ "$MODE" = "watch" ]; then
  cat >> "$SERVICE_UNIT" <<EOF
Type=simple
ExecStart=$PYTHON $PY_RUN $PY_RUN_ARGS --config $CONFIG_FILE --watch --interval 15
Restart=always
RestartSec=10
EOF
else
  cat >> "$SERVICE_UNIT" <<EOF
Type=oneshot
ExecStart=$PYTHON $PY_RUN $PY_RUN_ARGS --config $CONFIG_FILE --quiet
# 0=已联网/登录成功 1=登录失败 2=环境问题，都交给下一轮 timer 重试
SuccessExitStatus=0 1 2 3
EOF
fi

cat > "$TIMER_UNIT" <<EOF
[Unit]
Description=定时检查校园网登录状态

[Timer]
OnBootSec=30
OnUnitActiveSec=${INTERVAL}s
AccuracySec=10s
Persistent=true
Unit=$SERVICE

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload

if [ "$MODE" = "watch" ]; then
  systemctl --user disable --now "$TIMER" >/dev/null 2>&1 || true
  rm -f "$TIMER_UNIT"
  systemctl --user enable --now "$SERVICE"
  msg "已启用常驻守护服务: $SERVICE"
else
  systemctl --user disable --now "$SERVICE" >/dev/null 2>&1 || true
  systemctl --user enable --now "$TIMER"
  msg "已启用定时器: $TIMER（每 ${INTERVAL} 秒检查一次）"
fi

# --------------------------------------------------------------------------- #
# linger：没登录终端时也让服务能跑
# --------------------------------------------------------------------------- #
if loginctl show-user "$USER" --property=Linger 2>/dev/null | grep -q 'Linger=yes'; then
  msg "linger 已开启，无需处理"
elif loginctl enable-linger "$USER" >/dev/null 2>&1; then
  msg "已开启 linger（$USER 的服务可脱离终端运行）"
else
  msg "[!] 未能自动开启 linger，建议手动执行: sudo loginctl enable-linger $USER"
fi

# --------------------------------------------------------------------------- #
# 可选：进桌面时若一个网络都没连上，弹终端问你要连哪个 Wi-Fi
# --------------------------------------------------------------------------- #
if [ "$WITH_AUTOSTART" = "1" ]; then
  PROMPT_SCRIPT="$ROOT_DIR/linux/wifi-prompt.sh"
  if [ -f "$PROMPT_SCRIPT" ]; then
    chmod 0755 "$PROMPT_SCRIPT" 2>/dev/null || true
    mkdir -p "$AUTOSTART_DIR"
    cat > "$AUTOSTART_DIR/campus-wifi-prompt.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Wi-Fi 网络选择（campus-net）
Comment=进桌面时若完全没有网络，弹出终端让你选择要连的 Wi-Fi
Exec="$PROMPT_SCRIPT"
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
    msg "已安装桌面自启动: $AUTOSTART_DIR/campus-wifi-prompt.desktop"
    msg "  （只有在完全没连上网络时才会弹终端，平时不打扰）"
  else
    msg "[!] 没找到 $PROMPT_SCRIPT，跳过桌面自启动"
  fi
fi

# --------------------------------------------------------------------------- #
# 可选：NetworkManager 钩子，一连上网就立刻登录（不用等 timer）
# --------------------------------------------------------------------------- #
if [ "$NM_DISPATCHER" = "1" ]; then
  NM_DIR="/etc/NetworkManager/dispatcher.d"
  if [ -d "$NM_DIR" ]; then
    TMP="$(mktemp)"
    cat > "$TMP" <<EOF
#!/bin/sh
# 校园网自动登录：NetworkManager 在网卡状态变化时调用（root 身份）
if [ "\$2" = "up" ]; then
    UID_NUM=\$(id -u $USER 2>/dev/null) || exit 0
    [ -n "\$UID_NUM" ] || exit 0
    su -l $USER -c "XDG_RUNTIME_DIR=/run/user/\$UID_NUM systemctl --user start $SERVICE" >/dev/null 2>&1 &
fi
exit 0
EOF
    chmod 0755 "$TMP"
    sudo install -m 0755 -o root -g root "$TMP" "$NM_DIR/90-campus-net-login"
    rm -f "$TMP"
    msg "已安装 NetworkManager 钩子: $NM_DIR/90-campus-net-login"
  else
    msg "[!] 没找到 $NM_DIR，跳过 NetworkManager 钩子"
  fi
fi

# --------------------------------------------------------------------------- #
# 立即测试一次
# --------------------------------------------------------------------------- #
msg ""
msg "立即测试一次（--status，只检测不登录）……"
"$PYTHON" "$PY_SCRIPT" --config "$CONFIG_FILE" --status || true

cat <<EOF

========================== 安装完成 ==========================
查看定时器状态 : systemctl --user status $TIMER
查看运行日志   : journalctl --user -u $SERVICE -n 50 --no-pager
立刻执行一次   : systemctl --user start $SERVICE
看 Wi-Fi 列表  : $PYTHON $WIFI_SCRIPT --list
手动选网连一次 : $PYTHON $WIFI_SCRIPT --ask
删除某个网络   : $PYTHON $WIFI_SCRIPT --forget <SSID>
停止并卸载     : bash linux/uninstall.sh
日志文件       : $HOME/.local/state/auto-login-school-wifi/login.log
==============================================================
EOF

