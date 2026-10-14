#!/usr/bin/env bash
# ============================================================================
#  校园网自动登录 - Arch Linux 卸载脚本
#
#  用法：
#    bash linux/uninstall.sh                         卸载 systemd 单元和桌面自启动
#    bash linux/uninstall.sh --purge-nm-dispatcher   同时删除 NetworkManager 钩子
#
#  只删除自启动配置，不会删除脚本、config.json 和日志文件。
#  （已保存的 Wi-Fi 配置仍在 NetworkManager 里，可用 auto_connect.py --forget <SSID> 清理）
# ============================================================================
set -uo pipefail

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE="campus-net-login.service"
TIMER="campus-net-login.timer"
PURGE_NM=0

for arg in "$@"; do
  case "$arg" in
    --purge-nm-dispatcher) PURGE_NM=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now "$TIMER" >/dev/null 2>&1 || true
  systemctl --user disable --now "$SERVICE" >/dev/null 2>&1 || true
  systemctl --user stop "$SERVICE" >/dev/null 2>&1 || true
fi

rm -f "$UNIT_DIR/$SERVICE" "$UNIT_DIR/$TIMER"
echo "已删除单元文件: $UNIT_DIR/$SERVICE, $UNIT_DIR/$TIMER"

AUTOSTART_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/campus-wifi-prompt.desktop"
if [ -e "$AUTOSTART_FILE" ]; then
  rm -f "$AUTOSTART_FILE"
  echo "已删除桌面自启动: $AUTOSTART_FILE"
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload || true
  systemctl --user reset-failed "$SERVICE" >/dev/null 2>&1 || true
  echo "已重新加载 systemd --user 配置"
fi

if [ "$PURGE_NM" = "1" ]; then
  NM_FILE="/etc/NetworkManager/dispatcher.d/90-campus-net-login"
  if [ -e "$NM_FILE" ]; then
    sudo rm -f "$NM_FILE" && echo "已删除 NetworkManager 钩子: $NM_FILE"
  else
    echo "没有安装 NetworkManager 钩子，无需删除"
  fi
fi

cat <<'EOF'

卸载完成。脚本、config.json、日志文件都还在原目录，如需彻底清理请手动删除整个文件夹。
若之前开启过 linger 且不再需要，可执行: sudo loginctl disable-linger $USER
EOF
