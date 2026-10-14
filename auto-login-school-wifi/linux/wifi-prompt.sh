#!/bin/sh
# ============================================================================
#  校园网自动登录 - 桌面登录后的 Wi-Fi 询问器
#
#  作用：开机进入桌面时，如果**一个网络都没连上**，就弹出一个终端窗口，
#        运行 auto_connect.py --ask 让你选要连哪个 Wi-Fi（可选是否保存 + 优先级）。
#        已经有任何连接（有线/无线）时立刻退出，不打扰你。
#
#  由 linux/install.sh --with-autostart 安装到 ~/.config/autostart/。
#  也可以直接手动运行：bash linux/wifi-prompt.sh
# ============================================================================
set -u

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PYTHON="${PYTHON:-python3}"

# 已经连着任何网络就直接退出（网页认证交给 systemd 的 boot/timer 单元）
if command -v nmcli >/dev/null 2>&1; then
  if nmcli -t -f DEVICE,STATE device status 2>/dev/null | grep -q ':connected'; then
    exit 0
  fi
fi

TARGET="$ROOT_DIR/auto_connect.py"
[ -f "$TARGET" ] || exit 0

# 依次尝试常见的终端模拟器（不同终端的参数写法不一样）
for term in x-terminal-emulator alacritty kitty wezterm foot gnome-terminal konsole \
            xfce4-terminal terminator xterm; do
  command -v "$term" >/dev/null 2>&1 || continue
  case "$term" in
    gnome-terminal) exec "$term" -- "$PYTHON" "$TARGET" --ask ;;
    wezterm)        exec "$term" start -- "$PYTHON" "$TARGET" --ask ;;
    kitty|foot)     exec "$term" "$PYTHON" "$TARGET" --ask ;;
    *)              exec "$term" -e "$PYTHON" "$TARGET" --ask ;;
  esac
done

# 没有图形终端就静默退出（也可以自己跑 python3 auto_connect.py --ask）
exit 0