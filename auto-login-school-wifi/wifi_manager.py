#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""跨平台 Wi-Fi 管理：Linux 走 NetworkManager(nmcli)，Windows 走 netsh。

只依赖 Python 标准库。对外统一接口：

    backend = detect_backend()
    backend.list_saved()      # 系统里已保存的网络（含优先级）
    backend.scan()            # 当前可见的网络（按优先级/信号排序）
    backend.connect(ssid, password="", persist=True, priority=None)
    backend.forget(ssid)      # 删除已保存的网络
    backend.set_priority(ssid, priority)
    backend.current_ssid()    # 当前已连接的 SSID
    backend.wifi_ipv4()       # 无线网卡当前的 IPv4（把门户探测/认证绑定到它）

所有 parse_* 都是纯函数（输入系统命令的输出、输出结构体），可以脱离真实网卡做单元测试；
FakeBackend 供 auto_connect.py 的编排逻辑测试使用。

⚠️ 已知限制：nmcli 和 netsh 都**无法“不落盘地连一次”**——要把密码交给系统就得先写一份配置。
因此 persist=False 的语义是“连上之后把该配置设为不再自动连接”，配合 `--forget` 清理。
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Set, Tuple

COMMAND_TIMEOUT = 40   # 普通系统命令超时（秒）
CONNECT_TIMEOUT = 60    # 连接动作超时（秒，连网比较慢）
SCAN_TIMEOUT = 30       # 触发扫描的超时（秒）


class WifiError(Exception):
    """Wi-Fi 操作失败（没有网卡 / 找不到网络 / 密码错误 / 权限不足等）。"""


# --------------------------------------------------------------------------- #
# 写进 config.json 的 "wifi" 块
# --------------------------------------------------------------------------- #
WIFI_DEFAULTS: Dict[str, object] = {
    "auto_connect": True,    # 启动时按优先级依次连接已保存的网络
    "interactive": True,     # 都连不上时，是否在终端里询问用户
    "prompt_timeout": 30,    # 询问等待秒数；0 = 无限等待
    "connect_timeout": 25,   # 单个网络的连接确认等待秒数
    "scan": True,            # 询问前是否重新扫描
    # 多网卡时把门户探测/认证绑定到无线网卡的源地址：
    # 否则有线一旦抢到默认路由，所有请求都从有线出去，会误判成“已联网，无需认证”
    "portal_via_wifi": True,
    "networks": [],          # [{ssid, key, priority, security, portal{...}}]
}


def new_network_entry(ssid: str, key: str = "", priority: int = 1, security: str = "",
                      portal: Optional[Dict[str, object]] = None) -> Dict[str, object]:
    """构造一条要写进 config.json 的网络记录。"""
    return {
        "ssid": ssid,
        "key": key,
        "priority": int(priority),
        "security": security or "wpa2",
        "portal": dict(portal or {}),
    }


def find_network_entry(wifi_cfg: Dict[str, object], ssid: str) -> Optional[Dict[str, object]]:
    """按 SSID 在配置里找网络记录（忽略大小写）。"""
    target = (ssid or "").strip().lower()
    for item in (wifi_cfg.get("networks") or []):
        if isinstance(item, dict) and str(item.get("ssid") or "").strip().lower() == target:
            return item
    return None


def next_priority(wifi_cfg: Dict[str, object]) -> int:
    """给出下一个可用优先级（数字越小越优先，1-9）。"""
    used: Set[int] = set()
    for item in (wifi_cfg.get("networks") or []):
        if isinstance(item, dict):
            try:
                used.add(int(item.get("priority") or 0))
            except (TypeError, ValueError):
                continue
    for value in range(1, 10):
        if value not in used:
            return value
    return max(used) + 1 if used else 1


# --------------------------------------------------------------------------- #
# 网络数据结构 / 安全类型
# --------------------------------------------------------------------------- #
@dataclass
class WifiNetwork:
    """一个 Wi-Fi 网络（扫描到的，或系统里已保存的）。"""

    ssid: str
    profile: str = ""            # 系统里的连接配置名（nmcli 的 NAME / netsh 的 profile 名）
    signal: int = 0              # 0-100
    security: str = "open"       # open / wep / wpa / wpa2 / wpa3 / enterprise
    saved: bool = False          # 系统里已有配置
    auto: bool = True            # 配置是否启用“自动连接”
    active: bool = False         # 当前正在使用
    priority: int = 0            # 系统的自动连接优先级

    @property
    def open(self) -> bool:
        return self.security == "open"

    def label(self) -> str:
        """交互列表里显示用的一行信息（信号未知时显示 -）。"""
        flags = []
        if self.active:
            flags.append("当前连接")
        if self.saved:
            flags.append("已保存" if self.auto else "已保存·不自动连")
        signal = ("%d%%" % self.signal) if self.signal > 0 else "-"
        return "  信号 %4s  %-14s%s" % (signal, security_label(self.security),
                                       ("  [" + " / ".join(flags) + "]") if flags else "")


def normalize_security(raw: str) -> str:
    """把 nmcli / netsh 的安全类型归一到少量类别。"""
    text = (raw or "").strip().lower()
    if not text or text in ("--", "none", "open", "开放式", "无", "无保护"):
        return "open"
    if "802.1x" in text or "enterprise" in text or "企业" in text or "eap" in text:
        return "enterprise"
    if "wpa3" in text or "sae" in text:
        return "wpa3"
    if "wpa2" in text or "rsn" in text:
        return "wpa2"
    if "wpa" in text:
        return "wpa"
    if "wep" in text:
        return "wep"
    return "wpa2"


def security_from_keymgmt(value: str) -> str:
    """把 NetworkManager 的 802-11-wireless-security.key-mgmt 映射成安全类型。

    注意：key-mgmt 的 wpa-psk 无法区分 WPA 与 WPA2（NM 共用一个值），统一按 wpa2 显示。
    """
    text = (value or "").strip().lower()
    if not text or text in ("none", "--", "open"):
        return "open"
    if "sae" in text or "wpa3" in text:
        return "wpa3"
    if "eap" in text or "8021x" in text or "802.1x" in text:
        return "enterprise"
    if "psk" in text:
        return "wpa2"
    return "unknown"


def security_label(security: str) -> str:
    """给用户看的安全类型中文名。"""
    return {
        "open": "开放",
        "wep": "WEP",
        "wpa": "WPA",
        "wpa2": "WPA2",
        "wpa3": "WPA3",
        "enterprise": "企业级802.1X",
        "unknown": "未知",
    }.get((security or "").lower(), security or "未知")


def sort_networks(nets: Sequence[WifiNetwork]) -> List[WifiNetwork]:
    """排序：已保存的在前，其次优先级（小=先连）、信号、名称。"""
    return sorted(
        nets,
        key=lambda n: (not n.saved, n.priority if n.priority > 0 else 9999, -n.signal, n.ssid.lower()),
    )


def split_terse(line: str) -> List[str]:
    r"""拆 nmcli -t（terse）输出：`\:` 表示冒号本身，`\\` 表示反斜杠。"""
    fields: List[str] = []
    buf: List[str] = []
    escaped = False
    for ch in line:
        if escaped:
            buf.append(ch)
            escaped = False
        elif ch == "\\":
            escaped = True
        elif ch == ":":
            fields.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    if escaped:
        buf.append("\\")
    fields.append("".join(buf))
    return fields


# --------------------------------------------------------------------------- #
# Linux：NetworkManager / nmcli
# --------------------------------------------------------------------------- #
def parse_nmcli_scan(output: str) -> List[WifiNetwork]:
    """解析 `nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list`。"""
    nets: List[WifiNetwork] = []
    for line in (output or "").splitlines():
        if not line.strip():
            continue
        parts = split_terse(line)
        if len(parts) < 4:
            continue
        in_use, ssid, signal, security = parts[0].strip(), parts[1], parts[2], parts[3]
        if not ssid.strip():
            continue  # 隐藏 SSID（扫描结果为空）
        try:
            value = int(float(signal or 0))
        except ValueError:
            value = 0
        nets.append(WifiNetwork(ssid=ssid,
                                signal=max(0, min(100, value)),
                                security=normalize_security(security),
                                active=in_use in ("*", "yes")))
    return nets


def parse_nmcli_saved(output: str) -> List[WifiNetwork]:
    """解析 `nmcli -t -f NAME,TYPE,AUTOCONNECT,AUTOCONNECT-PRIORITY connection show`。"""
    nets: List[WifiNetwork] = []
    for line in (output or "").splitlines():
        parts = split_terse(line)
        if len(parts) < 2:
            continue
        name, ctype = parts[0].strip(), parts[1].strip()
        if "wireless" not in ctype:
            continue
        autoconnect = parts[2].strip().lower() if len(parts) > 2 else "yes"
        try:
            priority = int(float(parts[3] or 0)) if len(parts) > 3 else 0
        except ValueError:
            priority = 0
        nets.append(WifiNetwork(ssid=name, profile=name, saved=True, security="unknown",
                                auto=autoconnect != "no", priority=priority))
    return nets


# --------------------------------------------------------------------------- #
# 网卡 / 路由查询：判断“默认路由现在走的是不是无线网卡”
# --------------------------------------------------------------------------- #
def parse_nmcli_ipv4(output: str) -> str:
    """解析 `nmcli -t -f IP4.ADDRESS device show <dev>`，返回第一个 IPv4（无则空串）。"""
    for line in (output or "").splitlines():
        if "IP4.ADDRESS" not in line:
            continue
        value = line.partition(":")[2].strip().split("/")[0].strip()
        if value:
            return value
    return ""


def parse_netsh_addresses(output: str) -> str:
    """从 `netsh interface ip show addresses` 的输出里取出 IPv4（中英文都认）。"""
    for line in (output or "").splitlines():
        if "IP 地址" not in line and not re.search(r"IP Address", line, re.I):
            continue
        match = re.search(r"(\d{1,3}(?:\.\d{1,3}){3})", line)
        if match:
            return match.group(1)
    return ""


def _route_fields(line: str) -> Tuple[str, str, int]:
    """从 `ip route` 输出的一行里取出 (网卡, 源 IPv4, metric)。"""
    dev = re.search(r"\bdev\s+(\S+)", line)
    src = re.search(r"\bsrc\s+(\S+)", line)
    metric = re.search(r"\bmetric\s+(\d+)", line)
    return (dev.group(1) if dev else "",
            src.group(1) if src else "",
            int(metric.group(1)) if metric else 0)


def parse_default_route(output: str) -> Tuple[str, str]:
    """解析 `ip -4 route show default`，返回 (网卡, 源 IPv4)，取 metric 最小的一条。"""
    best: Tuple[int, str, str] = (1 << 30, "", "")
    for line in (output or "").splitlines():
        if not line.strip().startswith("default"):
            continue
        dev, src, metric = _route_fields(line)
        if metric < best[0]:
            best = (metric, dev, src)
    return best[1], best[2]


def parse_route_get(output: str) -> Tuple[str, str]:
    """解析 `ip route get <目标> [from <源地址>]`，返回内核实际会用的 (网卡, 源 IPv4)。"""
    for line in (output or "").splitlines():
        if not line.strip():
            continue
        dev, src, _ = _route_fields(line)
        if dev:
            return dev, src
    return "", ""


def parse_route_print_default(output: str) -> str:
    """解析 Windows `route print -4 0.0.0.0`，返回默认路由使用的接口 IPv4。"""
    best: Tuple[int, str] = (1 << 30, "")
    for line in (output or "").splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[0] != "0.0.0.0" or parts[1] != "0.0.0.0":
            continue
        try:
            metric = int(parts[4])
        except ValueError:
            continue
        if metric < best[0]:
            best = (metric, parts[3])
    return best[1]


def _run_command(cmd: Sequence[str], timeout: int = COMMAND_TIMEOUT) -> str:
    proc = subprocess.run([str(c) for c in cmd], capture_output=True, text=True,
                          timeout=timeout, errors="replace")
    return proc.stdout or ""


def default_route_source() -> Tuple[str, str]:
    """当前默认路由实际走哪张网卡：返回 (网卡名, 源 IPv4)，拿不到就返回空串。

    多网卡时（同时插着有线又连着 Wi-Fi）系统只有一个默认路由，门户探测
    必须知道它走的是不是无线网卡，否则会拿有线的结果去判断 Wi-Fi 是否需要认证。
    """
    try:
        if os.name == "nt":
            return "", parse_route_print_default(_run_command(["route", "print", "-4", "0.0.0.0"]))
        dev, src = parse_default_route(_run_command(["ip", "-4", "route", "show", "default"]))
        if dev and not src:
            detail = _run_command(["ip", "-4", "-o", "addr", "show", "dev", dev])
            match = re.search(r"inet\s+(\d{1,3}(?:\.\d{1,3}){3})", detail)
            if match:
                src = match.group(1)
        return dev, src
    except (OSError, subprocess.SubprocessError, ValueError):
        return "", ""


def route_get(dest: str, src: str = "") -> Tuple[str, str]:
    """问内核：发往 dest 的包（可选绑定源地址 src）会从哪张网卡出去。

    用来判断「把请求绑定到无线网卡的源地址」到底会不会真的从无线网卡发出去——
    在只有一张默认路由的普通系统上，Linux 会把这种包按默认路由发走（源地址被忽略），
    那样绑定反而会让请求全部超时。
    """
    if os.name == "nt":
        return "", ""
    cmd = ["ip", "-4", "route", "get", str(dest)]
    if src:
        cmd += ["from", str(src)]
    try:
        return parse_route_get(_run_command(cmd))
    except (OSError, subprocess.SubprocessError):
        return "", ""


class NmcliBackend:
    """Linux（NetworkManager）后端。"""

    name = "nmcli"

    def __init__(self, device: str = "") -> None:
        self._device = device

    @staticmethod
    def available() -> bool:
        return shutil.which("nmcli") is not None

    # ---- 基础 ---- #
    def _run(self, args: Sequence[str], timeout: int = COMMAND_TIMEOUT,
             check: bool = True) -> str:
        cmd = ["nmcli"] + [str(a) for a in args]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True,
                                  timeout=timeout, errors="replace")
        except FileNotFoundError:
            raise WifiError("找不到 nmcli，请先安装 NetworkManager")
        except subprocess.TimeoutExpired:
            raise WifiError("nmcli 执行超时（%s）" % " ".join(cmd[1:3]))
        if check and proc.returncode != 0:
            err = (proc.stderr or proc.stdout or "").strip()
            raise WifiError(err or ("nmcli 执行失败: %s" % " ".join(cmd[1:])))
        return (proc.stdout or "").strip()

    def device(self) -> str:
        """找一块可用的无线网卡。"""
        if self._device:
            return self._device
        out = self._run(["-t", "-f", "DEVICE,TYPE", "device", "status"], check=False)
        for line in out.splitlines():
            parts = split_terse(line)
            if len(parts) >= 2 and parts[1].strip() == "wifi":
                self._device = parts[0].strip()
                return self._device
        raise WifiError("没有找到可用的无线网卡（nmcli device status 里没有 wifi）")

    # ---- 查询 ---- #
    def list_saved(self) -> List[WifiNetwork]:
        out = self._run(["-t", "-f", "NAME,TYPE,AUTOCONNECT,AUTOCONNECT-PRIORITY",
                         "connection", "show"], check=False)
        nets = parse_nmcli_saved(out)
        for net in nets:
            ssid, security = self._profile_details(net.profile)
            if ssid:
                net.ssid = ssid
            if security:
                net.security = security
        return nets

    def _profile_details(self, profile: str) -> Tuple[str, str]:
        """读 profile 的真实 SSID 和安全类型（profile 名不一定等于 SSID）。"""
        try:
            out = self._run(["-t", "connection", "show", profile], check=True)
        except WifiError:
            return "", ""
        ssid, security = "", ""
        for line in out.splitlines():
            parts = split_terse(line)
            if len(parts) < 2:
                continue
            if parts[0] == "802-11-wireless.ssid":
                ssid = parts[1].strip()
            elif parts[0] == "802-11-wireless-security.key-mgmt":
                security = security_from_keymgmt(parts[1])
        return ssid, security

    def _profile_ssid(self, profile: str) -> str:
        return self._profile_details(profile)[0]

    def scan(self, rescan: bool = True) -> List[WifiNetwork]:
        args = ["-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list"]
        if rescan:
            args += ["--rescan", "yes"]
        out = self._run(args, timeout=SCAN_TIMEOUT, check=False)
        nets = parse_nmcli_scan(out)
        saved = {n.ssid.strip().lower(): n for n in self.list_saved()}
        for net in nets:
            known = saved.get(net.ssid.strip().lower())
            if known:
                net.saved = True
                net.profile = known.profile
                net.priority = known.priority
                net.auto = known.auto
        return sort_networks(nets)

    def current_ssid(self) -> str:
        out = self._run(["-t", "-f", "NAME,TYPE", "connection", "show", "--active"], check=False)
        for line in out.splitlines():
            parts = split_terse(line)
            if len(parts) >= 2 and "wireless" in parts[1]:
                profile = parts[0].strip()
                return self._profile_ssid(profile) or profile
        return ""

    def wifi_ipv4(self) -> str:
        """无线网卡当前的 IPv4（没有网卡 / 没拿到地址时返回空串）。"""
        try:
            device = self.device()
        except WifiError:
            return ""
        out = self._run(["-t", "-f", "IP4.ADDRESS", "device", "show", device], check=False)
        return parse_nmcli_ipv4(out)

    def wifi_device(self) -> str:
        """无线网卡的名字（没有网卡返回空串）。"""
        try:
            return self.device()
        except WifiError:
            return ""

    # ---- 动作 ---- #
    def _find_profile(self, ssid: str) -> str:
        target = ssid.strip().lower()
        for net in self.list_saved():
            if net.ssid.strip().lower() == target or net.profile.strip().lower() == target:
                return net.profile
        return ""

    def connect(self, ssid: str, password: str = "", persist: bool = True,
                priority: Optional[int] = None) -> str:
        """连接网络（已保存的直接激活，未保存的用密码新建），返回 profile 名。"""
        self.device()  # 顺便确认有无线网卡
        profile = self._find_profile(ssid)
        if profile and password:
            # 更新已有配置里的密码，避免拿旧密码反复失败
            self._run(["connection", "modify", profile,
                       "802-11-wireless-security.psk", password], check=False)
        if profile:
            self._run(["connection", "up", profile], timeout=CONNECT_TIMEOUT)
        else:
            args = ["device", "wifi", "connect", ssid]
            if password:
                args += ["password", password]
            self._run(args, timeout=CONNECT_TIMEOUT)
            profile = self._find_profile(ssid) or ssid
        self.set_autoconnect(profile, persist, priority)
        return profile

    def set_autoconnect(self, profile: str, enabled: bool = True,
                        priority: Optional[int] = None) -> None:
        """设置 profile 的自动连接开关和优先级（数字越小越优先）。"""
        args = ["connection", "modify", profile,
                "connection.autoconnect", "yes" if enabled else "no"]
        if priority:
            args += ["connection.autoconnect-priority", str(int(priority))]
        self._run(args, check=False)

    def set_priority(self, ssid: str, priority: int) -> None:
        profile = self._find_profile(ssid) or ssid
        self._run(["connection", "modify", profile, "connection.autoconnect-priority",
                   str(int(priority))], check=False)

    def forget(self, ssid: str) -> bool:
        """删除已保存的配置；本来就不存在时返回 False（别谎报成功）。"""
        profile = self._find_profile(ssid)
        if not profile:
            return False
        self._run(["connection", "delete", profile], check=False)
        return True


# --------------------------------------------------------------------------- #
# Windows：netsh
# --------------------------------------------------------------------------- #
def value_after_colon(line: str) -> str:
    """取第一个冒号之后的内容——netsh 的标签随系统语言变化，值的格式比较稳定。"""
    if ":" not in line:
        return ""
    return line.split(":", 1)[1].strip()


def parse_netsh_profiles(output: str) -> List[str]:
    """解析 `netsh wlan show profiles` 里的配置文件名（兼容中英文界面）。"""
    names: List[str] = []
    for line in (output or "").splitlines():
        if not line[:1].isspace() or ":" not in line:
            continue  # 标题行都不缩进
        value = value_after_colon(line)
        if not value or value.startswith("<"):
            continue  # <None> / <无>
        names.append(value)
    return names


_NETSH_SSID_RE = re.compile(r"^\s*SSID\s+\d+\s*:\s*(.*)$")


def parse_netsh_networks(output: str) -> List[WifiNetwork]:
    """解析 `netsh wlan show networks mode=bssid`（中英文界面均可）。"""
    nets: List[WifiNetwork] = []
    current: Optional[WifiNetwork] = None
    for line in (output or "").splitlines():
        match = _NETSH_SSID_RE.match(line)
        if match:
            ssid = match.group(1).strip()
            current = WifiNetwork(ssid=ssid) if ssid else None
            if current is not None:
                nets.append(current)
            continue
        if current is None:
            continue
        label = line.split(":", 1)[0].strip().lower()
        value = value_after_colon(line)
        if not value:
            continue
        if "auth" in label or "验证" in label:
            current.security = normalize_security(value)
        elif "%" in value:
            numbers = re.findall(r"(\d+)\s*%", value)
            if numbers:
                current.signal = max(current.signal, min(100, int(numbers[0])))
    return nets


def parse_netsh_interfaces(output: str) -> str:
    """从 `netsh wlan show interfaces` 取当前 SSID（必须排除 BSSID 那一行）。"""
    for line in (output or "").splitlines():
        if line.split(":", 1)[0].strip().lower() == "ssid":
            return value_after_colon(line)
    return ""


def xml_escape(text: str) -> str:
    """WLAN profile XML 里必须转义的特殊字符。"""
    return (str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&apos;"))


def build_windows_profile_xml(ssid: str, password: str = "", security: str = "wpa2",
                             auto: bool = True) -> str:
    """生成 Windows WLAN 配置文件（给 `netsh wlan add profile` 用）。"""
    kind = (security or "wpa2").lower()
    if kind == "open" or not password:
        auth, enc, shared = "open", "none", ""
    else:
        if "wpa3" in kind:
            auth, enc = "WPA3SAE", "AES"
        elif "wpa2" in kind:
            auth, enc = "WPA2PSK", "AES"
        elif kind == "wep":
            auth, enc = "open", "WEP"
        elif "wpa" in kind:
            auth, enc = "WPAPSK", "TKIP"
        else:
            auth, enc = "WPA2PSK", "AES"
        shared = ("      <sharedKey>\n"
                  "        <keyType>passPhrase</keyType>\n"
                  "        <protected>false</protected>\n"
                  "        <keyMaterial>%s</keyMaterial>\n"
                  "      </sharedKey>\n" % xml_escape(password))
    return ('<?xml version="1.0"?>\n'
            '<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">\n'
            "  <name>%s</name>\n"
            "  <SSIDConfig>\n    <SSID>\n      <name>%s</name>\n    </SSID>\n  </SSIDConfig>\n"
            "  <connectionType>ESS</connectionType>\n"
            "  <connectionMode>%s</connectionMode>\n"
            "  <MSM>\n    <security>\n      <authEncryption>\n"
            "        <authentication>%s</authentication>\n"
            "        <encryption>%s</encryption>\n"
            "        <useOneX>false</useOneX>\n"
            "      </authEncryption>\n"
            "%s    </security>\n  </MSM>\n"
            "</WLANProfile>\n"
            % (xml_escape(ssid), xml_escape(ssid), "auto" if auto else "manual",
               auth, enc, shared))


class NetshBackend:
    """Windows（netsh wlan）后端。"""

    name = "netsh"

    def __init__(self, interface: str = "") -> None:
        self._interface = interface

    @staticmethod
    def available() -> bool:
        return os.name == "nt" and shutil.which("netsh") is not None

    def _run(self, args: Sequence[str], timeout: int = COMMAND_TIMEOUT,
             check: bool = True) -> str:
        cmd = ["netsh"] + [str(a) for a in args]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True,
                                  timeout=timeout, errors="replace")
        except FileNotFoundError:
            raise WifiError("找不到 netsh（该后端只能在 Windows 上运行）")
        except subprocess.TimeoutExpired:
            raise WifiError("netsh 执行超时（%s）" % " ".join(cmd[1:3]))
        text = ((proc.stdout or "") + (proc.stderr or "")).strip()
        if check and proc.returncode != 0:
            raise WifiError(text or ("netsh 执行失败: %s" % " ".join(cmd[1:])))
        return text

    def interface(self) -> str:
        """无线网卡接口名（通常是 Wi-Fi / WLAN / 无线网络连接）。"""
        if self._interface:
            return self._interface
        out = self._run(["wlan", "show", "interfaces"], check=False)
        for line in out.splitlines():
            if line.split(":", 1)[0].strip().lower() in ("name", "名称"):
                self._interface = value_after_colon(line)
                if self._interface:
                    break
        if not self._interface:
            raise WifiError("没有找到无线网卡（netsh wlan show interfaces 没有输出）")
        return self._interface

    # ---- 查询 ---- #
    def list_saved(self) -> List[WifiNetwork]:
        out = self._run(["wlan", "show", "profiles"], check=False)
        return [WifiNetwork(ssid=n, profile=n, saved=True) for n in parse_netsh_profiles(out)]

    def scan(self, rescan: bool = True) -> List[WifiNetwork]:
        out = self._run(["wlan", "show", "networks", "mode=bssid"],
                        timeout=SCAN_TIMEOUT, check=False)
        nets = parse_netsh_networks(out)
        saved = {n.ssid.strip().lower() for n in self.list_saved()}
        for net in nets:
            if net.ssid.strip().lower() in saved:
                net.saved = True
                net.profile = net.ssid
        return sort_networks(nets)

    def current_ssid(self) -> str:
        return parse_netsh_interfaces(self._run(["wlan", "show", "interfaces"], check=False))

    def wifi_ipv4(self) -> str:
        """无线网卡当前的 IPv4（中英文 Windows 都认；拿不到返回空串）。"""
        try:
            iface = self.interface()
        except WifiError:
            return ""
        out = self._run(["interface", "ip", "show", "addresses", iface], check=False)
        return parse_netsh_addresses(out)

    def wifi_device(self) -> str:
        """无线网卡的名字（没有网卡返回空串）。"""
        try:
            return self.interface()
        except WifiError:
            return ""

    # ---- 动作 ---- #
    def connect(self, ssid: str, password: str = "", persist: bool = True,
                priority: Optional[int] = None) -> str:
        interface = self.interface()
        known = {n.ssid.strip().lower() for n in self.list_saved()}
        if ssid.strip().lower() not in known:
            self._add_profile(ssid, password, persist)
        self._run(["wlan", "connect", "name=%s" % ssid, "ssid=%s" % ssid,
                   "interface=%s" % interface], timeout=CONNECT_TIMEOUT)
        if priority:
            self.set_priority(ssid, int(priority))
        return ssid

    def _add_profile(self, ssid: str, password: str, persist: bool) -> None:
        """Windows 必须先有配置文件才能连；这里临时写一份 XML 导入。"""
        directory = tempfile.mkdtemp(prefix="campus-wifi-")
        path = os.path.join(directory, "profile.xml")
        security = "open" if not password else "wpa2"
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(build_windows_profile_xml(ssid, password, security, persist))
        try:
            self._run(["wlan", "add", "profile", "filename=%s" % path, "user=current"])
        finally:
            try:
                os.remove(path)
                os.rmdir(directory)
            except OSError:
                pass
        if not persist:
            # 语义上接近“只连这一次”：配置留着，但改成手动连接
            self._run(["wlan", "set", "profileparameter", "name=%s" % ssid,
                       "connectionmode=manual"], check=False)

    def set_priority(self, ssid: str, priority: int) -> None:
        """Windows 用 profileorder 表示优先级（1 = 最高）。"""
        self._run(["wlan", "set", "profileorder", "name=%s" % ssid,
                   "interface=%s" % self.interface(), "priority=%d" % int(priority)], check=False)

    def forget(self, ssid: str) -> bool:
        """删除已保存的配置；本来就不存在时返回 False。"""
        known = {n.ssid.strip().lower() for n in self.list_saved()}
        if ssid.strip().lower() not in known:
            return False
        self._run(["wlan", "delete", "profile", "name=%s" % ssid,
                   "interface=%s" % self.interface()], check=False)
        return True


# --------------------------------------------------------------------------- #
# 后端选择 / 测试替身
# --------------------------------------------------------------------------- #
def detect_backend():
    """按平台自动选后端：Windows → netsh；Linux / 类 Unix → nmcli。"""
    if os.name == "nt":
        if NetshBackend.available():
            return NetshBackend()
        raise WifiError("Windows 上找不到 netsh，无法管理 Wi-Fi")
    if NmcliBackend.available():
        return NmcliBackend()
    raise WifiError("找不到 nmcli（请安装 NetworkManager），或用 --no-wifi 跳过 Wi-Fi 管理")


class FakeBackend:
    """内存后端：只给单元测试用，不碰任何真实网络。"""

    name = "fake"

    def __init__(self, saved: Optional[Sequence[WifiNetwork]] = None,
                 visible: Optional[Sequence[WifiNetwork]] = None,
                 fail_connect: Sequence[str] = (), current: str = "",
                 ipv4: str = "", device: str = "") -> None:
        self._saved: List[WifiNetwork] = list(saved or [])
        self._visible: List[WifiNetwork] = list(visible or [])
        self.fail_connect = {s.strip().lower() for s in fail_connect}
        self._current = current
        self._ipv4 = ipv4
        self._device_name = device
        self.calls: List[str] = []

    @staticmethod
    def available() -> bool:
        return True

    def list_saved(self) -> List[WifiNetwork]:
        return list(self._saved)

    def scan(self, rescan: bool = True) -> List[WifiNetwork]:
        return sort_networks(self._visible)

    def current_ssid(self) -> str:
        return self._current

    def wifi_ipv4(self) -> str:
        return self._ipv4

    def wifi_device(self) -> str:
        return self._device_name

    def connect(self, ssid: str, password: str = "", persist: bool = True,
                priority: Optional[int] = None) -> str:
        self.calls.append("connect:%s:%s" % (ssid, "saved" if persist else "once"))
        if ssid.strip().lower() in self.fail_connect:
            raise WifiError("模拟连接失败: %s" % ssid)
        self._current = ssid
        return ssid

    def set_priority(self, ssid: str, priority: int) -> None:
        self.calls.append("priority:%s=%d" % (ssid, int(priority)))

    def forget(self, ssid: str) -> bool:
        self.calls.append("forget:%s" % ssid)
        target = ssid.strip().lower()
        remain = [n for n in self._saved if n.ssid.strip().lower() != target]
        found = len(remain) != len(self._saved)
        self._saved = remain
        return found


if __name__ == "__main__":  # 手动排查用：python3 wifi_manager.py
    try:
        _backend = detect_backend()
    except WifiError as _exc:
        print("后端不可用: %s" % _exc)
        raise SystemExit(2)
    print("后端: %s" % _backend.name)
    print("当前连接: %s" % (_backend.current_ssid() or "(未连接)"))
    _dev, _src = default_route_source()
    print("默认路由: %s（源 %s）" % (_dev or "?", _src or "?"))
    print("无线网卡 IPv4: %s" % (_backend.wifi_ipv4() or "(没有地址)"))
    print("已保存的网络:")
    for _net in _backend.list_saved():
        print("  - %s%s" % (_net.ssid, _net.label()))
    print("可见的网络:")
    for _net in _backend.scan():
        print("  - %s%s" % (_net.ssid, _net.label()))





