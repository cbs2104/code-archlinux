#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Wi-Fi 自动连接 + 公共网络（校园网）自动认证 —— 跨平台，只依赖标准库。

整体流程：
  1. 读 config.json（和 portal_login.py 共用）里的 "wifi" 块；
  2. 已经联网 → 直接检查门户认证状态（需要登录就登录）；
  3. 否则按优先级依次连接**所有已保存的网络**（系统 profile ∪ 配置里的记录），
     某一台连上就停止（一块网卡同一时间只能连一个 AP）；
  4. 全都连不上：
       * 有终端且允许交互 → 扫描周边 Wi-Fi、列出清单并询问用户要连哪个：
         - 没保存过的会问 Wi-Fi 密码；
         - 再问“是否保存该网络”，保存则问优先级 1-9，不保存则只连这一次；
       * 无终端（开机自启 / 计划任务）→ 安静退出，退出码 1，绝不卡住开机；
  5. 连上之后探测是否被劫持到认证页：如果是且缺账号密码，就询问账号密码并写回
     config.json（含 Wi-Fi 密码与网络优先级），然后复用 portal_login.py 自动认证。
  6. 同一台机器同时插着有线又连着 Wi-Fi 时，门户探测/认证会绑定到无线网卡的 IP，
     避免有线的探测结果掩盖「Wi-Fi 其实需要认证」这件事。

需要注意：「认证页面属于校园网」和「Wi-Fi 名字是寝室网」并不冲突——config.json 顶层的
username / password / portal_url 是**所有网络共用的校园网门户配置**，任何 SSID 都适用；
只有当某个网络要用另一个账号时，才在 wifi.networks[].portal 里单独写。反过来，如果某个
网络**不要**自动提交校园网账号（例如酒店 / 商场 Wi-Fi），给它写
`"portal": {"enabled": false}`。

用法：
  python3 auto_connect.py                  # 智能模式：能连就连，连不上且有终端就问
  python3 auto_connect.py --boot           # 开机自启用：只连已保存网络 + 认证，绝不询问
  python3 auto_connect.py --ask            # 强制进入交互向导（扫描 + 询问）
  python3 auto_connect.py --list           # 列出已保存 / 可见的网络和当前连接
  python3 auto_connect.py --connect SSID [--key 密码] [--save] [--priority N]
  python3 auto_connect.py --forget SSID    # 删除已保存的网络（含系统 profile）
  python3 auto_connect.py --no-wifi        # 跳过 Wi-Fi 管理，只做门户认证

退出码：0 成功 / 1 没连上 / 2 出错 / 3 用户主动跳过
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))

import portal_login as portal  # noqa: E402  (复用配置/日志/探测/认证)
from wifi_manager import (  # noqa: E402
    WIFI_DEFAULTS,
    FakeBackend,
    NetshBackend,
    NmcliBackend,
    WifiError,
    WifiNetwork,
    default_route_source,
    detect_backend,
    find_network_entry,
    new_network_entry,
    next_priority,
    route_get,
    security_label,
    sort_networks,
)

VERSION = "1.0.0"
YES_WORDS = ("y", "yes", "是", "好", "1", "ok", "确定", "保存")
# 问内核“这个目标会从哪张网卡出去”时用的参考地址（普通路由表里，任何公网地址结果都一样）
ROUTE_PROBE_HOST = "1.1.1.1"


def echo(message: str = "", end: str = "\n") -> None:
    """统一输出（带 flush，终端里能即时看到提示）。"""
    try:
        print(message, end=end, flush=True)
    except UnicodeEncodeError:
        print(message.encode("utf-8", "replace").decode("ascii", "replace"), end=end, flush=True)


# --------------------------------------------------------------------------- #
# 配置读写（复用 portal_login 的 config.json）
# --------------------------------------------------------------------------- #
def load_config(path: Path) -> Dict[str, object]:
    """读 config.json（不存在就生成模板），并把 wifi 块补齐默认值。"""
    if not path.exists():
        portal.write_config_template(path)
        echo("已生成配置模板: %s" % path)
    cfg = portal.load_config(path)
    wifi = cfg.get("wifi")
    merged: Dict[str, object] = dict(WIFI_DEFAULTS)
    if isinstance(wifi, dict):
        merged.update(wifi)
    merged["networks"] = [n for n in (merged.get("networks") or []) if isinstance(n, dict)]
    cfg["wifi"] = merged
    return cfg


def save_config(path: Path, cfg: Dict[str, object]) -> None:
    """把配置写回磁盘（丢掉内部字段，权限收紧到 600）。"""
    data = {k: v for k, v in cfg.items() if not str(k).startswith("_")}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# 交互输入（带超时；一旦超时就再也不问，避免开机时卡住）
# --------------------------------------------------------------------------- #
_INPUT_ABANDONED = False


def _read_line(box: List[str]) -> None:
    try:
        box.append(sys.stdin.readline())
    except (EOFError, KeyboardInterrupt, ValueError):
        box.append("")


def ask(prompt: str, default: str = "", timeout: float = 0) -> str:
    """带超时的 input()：timeout<=0 表示一直等；EOF/超时返回 default。"""
    global _INPUT_ABANDONED
    if _INPUT_ABANDONED:
        return default
    echo(prompt, end=" ")
    if timeout and timeout > 0:
        box: List[str] = []
        reader = threading.Thread(target=_read_line, args=(box,), daemon=True)
        reader.start()
        reader.join(timeout)
        if not box:
            _INPUT_ABANDONED = True
            echo("（等待超时，后面的问题一律按默认处理）")
            return default
        line = box[0]
    else:
        try:
            line = sys.stdin.readline()
        except (EOFError, KeyboardInterrupt):
            line = ""
    if line == "":
        echo("")
        return default
    return line.rstrip("\r\n")


def ask_yes_no(prompt: str, default: bool = True, timeout: float = 0) -> bool:
    """是/否提问；空输入 = 默认值。"""
    hint = "[Y/n]" if default else "[y/N]"
    answer = ask("%s %s" % (prompt, hint), default="", timeout=timeout).strip().lower()
    if not answer:
        return default
    return answer in YES_WORDS


def ask_password(prompt: str, timeout: float = 0) -> str:
    """优先隐藏输入；带超时或没有终端时退化成普通输入。"""
    if timeout and timeout > 0:
        return ask(prompt, timeout=timeout)
    if sys.stdin.isatty():
        try:
            return getpass.getpass(prompt)
        except (EOFError, KeyboardInterrupt, OSError):
            pass
    return ask(prompt)


def ask_priority(wifi_cfg: Dict[str, object], ssid: str, timeout: float = 0) -> int:
    """让用户设置优先级：数字越小越先连接（写进 config.json 和系统 profile）。"""
    entries = [e for e in (wifi_cfg.get("networks") or []) if isinstance(e, dict)]
    default = next_priority(wifi_cfg)
    if entries:
        echo("现有网络优先级（数字越小越先连接）：")
        for entry in sorted(entries, key=lambda e: int(e.get("priority") or 9)):
            echo("  %s) %s" % (entry.get("priority"), entry.get("ssid")))
    answer = ask("请设置 %s 的优先级 1-9（回车 = %d）:" % (ssid, default),
                 default=str(default), timeout=timeout).strip()
    try:
        value = int(answer)
    except ValueError:
        return default
    return min(max(value, 1), 9)


# --------------------------------------------------------------------------- #
# 门户认证相关
# --------------------------------------------------------------------------- #
def apply_portal_block(cfg: Dict[str, object], ssid: str) -> None:
    """把某个 SSID 专属的门户凭据覆盖到全局配置上（不同网络可用不同账号）。"""
    if not ssid:
        return
    wifi = cfg.get("wifi")
    if not isinstance(wifi, dict):
        return
    entry = find_network_entry(wifi, ssid)
    block = (entry or {}).get("portal")
    if not isinstance(block, dict) or not block.get("enabled", True):
        return
    for key in ("username", "password", "type", "portal_url"):
        if block.get(key):
            cfg[key] = block[key]


def remember_portal_credentials(cfg: Dict[str, object], ssid: str, username: str,
                                password: str) -> None:
    """把门户账号密码记到该 SSID 名下，写回 config.json。"""
    if not ssid:
        return
    wifi = cfg.get("wifi")
    if not isinstance(wifi, dict):
        wifi = dict(WIFI_DEFAULTS)
        cfg["wifi"] = wifi
    nets = wifi.get("networks")
    if not isinstance(nets, list):
        nets = []
        wifi["networks"] = nets
    entry = find_network_entry(wifi, ssid)
    if entry is None:
        entry = new_network_entry(ssid, priority=next_priority(wifi))
        nets.append(entry)
    block = entry.get("portal")
    block = dict(block) if isinstance(block, dict) else {}
    block.update({"enabled": True, "username": username, "password": password})
    entry["portal"] = block


def portal_auth_allowed(cfg: Dict[str, object], ssid: str) -> bool:
    """这个网络是否允许自动提交校园网账号？

    默认允许（因为「同一个校园网门户、不同 SSID」是最常见的情况：寝室网、教学楼
    的 SSID 不一样，认证页却是同一个）。只有在配置里显式写了
    ``"portal": {"enabled": false}`` 时才跳过——比如连到酒店 / 商场的公共 Wi-Fi 时，
    避免把校园网账号密码交出去。
    """
    wifi = cfg.get("wifi")
    if not isinstance(wifi, dict):
        return True
    entry = find_network_entry(wifi, ssid) if ssid else None
    block = (entry or {}).get("portal")
    if isinstance(block, dict) and not block.get("enabled", True):
        return False
    return True


def portal_bind_address(cfg: Dict[str, object], backend, log) -> str:
    """决定门户探测/认证要不要绑定到无线网卡的源地址。

    背景：一台机器同时插着有线又连着 Wi-Fi 时只有一个默认路由，所有请求都从有线
    出去，于是「Wi-Fi 是否需要校园网认证」会被有线的探测结果掩盖。

    但绑定源地址不一定有效：Linux 在只有一张默认路由时会把这种包按默认路由发走
    （源地址被忽略），绑定反而会让探测/认证全部超时。所以这里先问内核
    ``ip route get <目标> from <无线网卡IP>`` 会从哪张网卡出去，确认真的会走无线
    网卡才绑定；否则保持原样并给出提示。

    优先级：配置里的 bind_address（手动指定）> 自动判断 > 不绑定。
    """
    explicit = str(cfg.get("bind_address") or "").strip()
    if explicit:
        return explicit
    wifi = cfg.get("wifi")
    if isinstance(wifi, dict) and not wifi.get("portal_via_wifi", True):
        return ""
    if not backend or not hasattr(backend, "wifi_ipv4"):
        return ""
    try:
        wifi_ip = str(backend.wifi_ipv4() or "").strip()
        wifi_dev = str(getattr(backend, "wifi_device", lambda: "")() or "").strip()
    except WifiError:
        return ""
    if not wifi_ip or not wifi_dev:
        return ""
    try:
        default_dev, default_ip = default_route_source()
    except Exception:  # 查询路由失败时保持旧行为，不影响认证
        return ""
    if not default_ip or default_ip == wifi_ip:
        return ""  # 默认路由就在无线网卡上，什么都不用做
    try:
        dest_dev, _dest_src = route_get(ROUTE_PROBE_HOST, wifi_ip)
    except Exception:
        dest_dev = ""
    if dest_dev and dest_dev == wifi_dev:
        log.debug("默认路由走 %s（源 %s），把门户请求绑定到无线网卡 %s（%s）"
                  % (default_dev or "?", default_ip, wifi_dev, wifi_ip))
        return wifi_ip
    log.warn("默认路由现在走 %s（源 %s），门户探测/认证会跟着这条线路；"
             "系统路由不会把无线网卡 %s（%s）的流量单独分出来，这次就不绑定了。"
             "想按无线网卡判断/认证校园网，请先拔掉有线网线再运行。"
             % (default_dev or "?", default_ip, wifi_dev, wifi_ip))
    return ""


# --------------------------------------------------------------------------- #
# 连接已保存的网络
# --------------------------------------------------------------------------- #
def wifi_settings(cfg: Dict[str, object]) -> Dict[str, object]:
    """取 wifi 配置块（带默认值）。"""
    wifi = cfg.get("wifi")
    if not isinstance(wifi, dict):
        wifi = dict(WIFI_DEFAULTS)
        cfg["wifi"] = wifi
    return wifi


def connect_saved(cfg: Dict[str, object], log, backend, timeout: float = 0) -> str:
    """按优先级依次尝试所有已保存的网络，返回连上的 SSID（都没连上返回空串）。

    候选 = config.json 里的 wifi.networks ∪ 系统里已有的 profile。
    一块无线网卡同一时间只能连一个 AP，所以这里是“依次尝试直到成功”。
    """
    wifi = wifi_settings(cfg)
    saved = backend.list_saved()
    candidates: List[Tuple[int, str, str]] = []   # (优先级, SSID, Wi-Fi 密码)
    known = set()
    for entry in (wifi.get("networks") or []):
        if not isinstance(entry, dict):
            continue
        ssid = str(entry.get("ssid") or "").strip()
        if not ssid:
            continue
        try:
            priority = int(entry.get("priority") or 9)
        except (TypeError, ValueError):
            priority = 9
        candidates.append((priority, ssid, str(entry.get("key") or "")))
        known.add(ssid.lower())
    for net in saved:
        if net.ssid.strip().lower() not in known:
            candidates.append((net.priority or 9, net.ssid, ""))
            known.add(net.ssid.strip().lower())
    if not candidates:
        log.info("配置和系统里都没有已保存的网络")
        return ""
    candidates.sort(key=lambda item: (item[0], item[1].lower()))
    for priority, ssid, key in candidates:
        if backend.current_ssid().strip().lower() == ssid.lower():
            log.info("已经连接在 %s 上" % ssid)
            return ssid
        log.info("尝试连接已保存的网络: %s（优先级 %s）" % (ssid, priority))
        try:
            backend.connect(ssid, key, persist=True, priority=priority)
        except WifiError as exc:
            log.warn("连接 %s 失败: %s" % (ssid, exc))
            continue
        if wait_connected(backend, ssid, timeout):
            log.info("[OK] 已连接到 %s" % ssid)
            return ssid
        log.warn("已发起连接，但暂时没确认连上 %s" % ssid)
    return ""


def wait_connected(backend, ssid: str, timeout: float = 0) -> bool:
    """轮询等待链路真正建立（有些网卡会慢几秒）。"""
    limit = time.time() + max(float(timeout or 10), 1.0)
    while True:
        if backend.current_ssid().strip().lower() == ssid.strip().lower():
            return True
        if time.time() >= limit:
            return False
        time.sleep(0.8)


# --------------------------------------------------------------------------- #
# 联网探测 + 需要时自动认证
# --------------------------------------------------------------------------- #
def ensure_online(cfg: Dict[str, object], path: Path, log, interactive: bool,
                  timeout: float = 0, ssid: str = "", backend=None) -> int:
    """探测联网状态；若被劫持到认证页，就按 portal_login.py 的方案登录。

    backend 用于判断「要不要把门户请求绑定到无线网卡」：多网卡（有线 + 无线）时
    默认路由可能走的是有线，不绑定就会把有线的探测结果当成 Wi-Fi 的结果。
    返回 0 已联网 / 1 认证失败 / 2 配置或环境问题 / 3 跳过（含配置里关闭了自动认证）。
    """
    cfg["_bind_address"] = portal_bind_address(cfg, backend, log)  # 内部字段，不写盘
    session = portal.PortalSession(cfg, log, capture_dir=cfg.get("_capture_dir"))
    state = portal.probe_connectivity(session, cfg, log)
    if state.online:
        log.info("[OK] 网络已连通，无需认证（%s）" % state.detail)
        return 0
    if not portal_auth_allowed(cfg, ssid):
        log.warn("按配置跳过自动认证（%s 的 portal.enabled = false）" % (ssid or "当前网络"))
        return 3
    log.info("检测到未联网：%s" % state.detail)
    portal_url = str(cfg.get("portal_url") or state.portal_url or "")
    if not portal_url and str(cfg.get("type") or "auto").lower() != "srun":
        log.error("找不到认证页面；请把认证页地址填到 config.json 的 portal_url")
        return 2
    if str(cfg.get("username") or "") and str(cfg.get("password") or ""):
        return portal.run_once(cfg, log)  # 已有凭据：直接沿用原来的认证方案
    if not interactive:
        log.error("该网络需要网页认证，但配置里没有账号密码（手动运行 auto_connect.py 可填写）")
        return 2
    echo("")
    echo("─" * 60)
    echo("这个网络需要网页认证（典型的校园网）。")
    if portal_url:
        echo("认证页面: %s" % portal_url)
    if not ask_yes_no("现在填写账号密码并保存到配置文件？", default=True, timeout=timeout):
        log.warn("用户选择暂不认证")
        return 3
    username = ask("账号 / 学号: ", timeout=timeout).strip()
    password = ask_password("密码: ", timeout=timeout)
    if not username or not password:
        log.error("账号或密码为空，跳过认证")
        return 2
    cfg["username"] = username
    cfg["password"] = password
    remember_portal_credentials(cfg, ssid, username, password)
    save_config(path, cfg)
    echo("已把账号密码保存到 %s（明文保存，注意别提交到 git）" % path)
    return portal.run_once(cfg, log)


# --------------------------------------------------------------------------- #
# 交互向导：扫描 → 选网络 → 问密码 → 是否保存 → 优先级 → 门户认证
# --------------------------------------------------------------------------- #
def print_networks(nets: List[WifiNetwork]) -> None:
    """把扫描结果打印成编号列表。"""
    for index, net in enumerate(nets, 1):
        echo("  %2d) %-24s%s" % (index, net.ssid, net.label()))
    echo("   0) 跳过（不连接）")


def wizard(cfg: Dict[str, object], path: Path, log, backend, timeout: float) -> int:
    """扫描周边 Wi-Fi 并询问用户要连哪个（没有可用已保存网络时走这里）。"""
    echo("")
    echo("=" * 62)
    echo("下面扫描周边 Wi-Fi，请选择要连接的网络（标 [已保存] 的不用再输密码）：")
    try:
        nets = backend.scan()
    except WifiError as exc:
        echo("扫描失败: %s" % exc)
        return 2
    if not nets:
        echo("没有扫描到任何 Wi-Fi；请确认无线网卡已打开、无线开关已启用。")
        return 1
    print_networks(nets)
    choice = ask("请输入要连接的编号（回车 / 0 = 跳过）:", default="0", timeout=timeout).strip()
    if not choice or choice == "0":
        echo("已跳过，不连接任何网络。")
        return 3
    try:
        net = nets[int(choice) - 1]
    except (ValueError, IndexError):
        echo("输入无效，退出。")
        return 2
    return connect_one(cfg, path, log, backend, net, timeout)


def connect_one(cfg: Dict[str, object], path: Path, log, backend,
                net: WifiNetwork, timeout: float) -> int:
    """连接选中的网络：问密码 / 问是否保存 / 问优先级，最后做门户认证。"""
    wifi = wifi_settings(cfg)
    entry = find_network_entry(wifi, net.ssid)
    key = str(entry.get("key") or "") if entry else ""
    save_cfg = entry is not None
    priority = int(entry.get("priority") or 0) if entry else 0

    if not key and net.saved:
        # 系统 profile 里已经有密码，直接激活；只需问要不要记进 config.json
        echo("「%s」在系统里已经保存过，直接连接。" % net.ssid)
        if not save_cfg and ask_yes_no("是否把它写进 config.json（含自动连接优先级）？",
                                       default=True, timeout=timeout):
            save_cfg = True
            priority = ask_priority(wifi, net.ssid, timeout)
    elif not key and not net.open:
        key = ask_password("请输入 %s 的 Wi-Fi 密码: " % net.ssid, timeout=timeout)
        if not key:
            echo("没有输入密码，取消连接。")
            return 2
        echo("")
        if ask_yes_no("是否保存这个网络和密码（以后自动连接）？", default=True, timeout=timeout):
            save_cfg = True
            priority = ask_priority(wifi, net.ssid, timeout)
        else:
            save_cfg = False
            echo("好，这次只连一次，不写进配置文件。")
    elif net.open:
        echo("「%s」是开放网络，不需要密码。" % net.ssid)
        if not save_cfg and ask_yes_no("是否保存这个网络（以后自动连接）？",
                                       default=True, timeout=timeout):
            save_cfg = True
            priority = ask_priority(wifi, net.ssid, timeout)

    try:
        backend.connect(net.ssid, key, persist=save_cfg, priority=priority)
    except WifiError as exc:
        echo("连接 %s 失败: %s" % (net.ssid, exc))
        return 1
    if not wait_connected(backend, net.ssid, timeout=10):
        echo("[!] 已发起连接，但还没确认连上（无线网卡有时要多等几秒）。")

    if save_cfg:
        if entry is None:
            nets = wifi.get("networks")
            if not isinstance(nets, list):
                nets = []
                wifi["networks"] = nets
            entry = new_network_entry(net.ssid, key, priority or next_priority(wifi), net.security)
            nets.append(entry)
        else:
            if key:
                entry["key"] = key
            if priority:
                entry["priority"] = priority
            if net.security and not entry.get("security"):
                entry["security"] = net.security
        save_config(path, cfg)
        echo("已保存网络 %s（优先级 %s，密码写入 %s）" % (net.ssid, entry.get("priority"), path))
    else:
        echo("本次只连接、不保存。系统里仍会留一个“不自动连接”的配置，"
             "要清理可执行: python3 auto_connect.py --forget %s" % net.ssid)

    code = ensure_online(cfg, path, log, interactive=True, timeout=timeout, ssid=net.ssid)
    return 0 if code == 0 else code


# --------------------------------------------------------------------------- #
# 各个入口流程
# --------------------------------------------------------------------------- #
def show_list(backend) -> int:
    """--list：列出已保存 / 可见的网络。"""
    if not backend:
        echo("已跳过 Wi-Fi 管理（--no-wifi）")
        return 0
    saved = backend.list_saved()
    echo("已保存的网络（%d 个）：" % len(saved))
    for net in sort_networks(saved):
        echo("  - %-24s 优先级 %s%s" % (net.ssid, net.priority or "-",
                                        "" if net.auto else "（不自动连接）"))
    echo("")
    echo("当前可见的网络：")
    for net in backend.scan():
        echo("  - %-24s%s" % (net.ssid, net.label()))
    echo("")
    echo("当前连接: %s" % (backend.current_ssid() or "(未连接)"))
    _dev, _src = default_route_source()
    _wifi_ip = ""
    try:
        _wifi_ip = backend.wifi_ipv4() or ""
    except WifiError:
        pass
    echo("默认路由: %s（源 %s）" % (_dev or "?", _src or "?"))
    echo("无线网卡: %s" % (_wifi_ip or "(没有地址)"))
    if _wifi_ip and _src and _wifi_ip != _src:
        _wifi_dev = ""
        try:
            _wifi_dev = backend.wifi_device() or ""
        except WifiError:
            pass
        _dest_dev, _ = route_get(ROUTE_PROBE_HOST, _wifi_ip)
        if _wifi_dev and _dest_dev == _wifi_dev:
            echo("提示: 门户探测/认证会绑定到无线网卡 %s（%s）" % (_wifi_ip, _wifi_dev))
        else:
            echo("提示: 默认路由在 %s 上，门户探测/认证会跟着它；绑定无线网卡不起作用，"
                 "想按无线网卡判断/认证请拔掉有线" % (_dev or "其它线路"))
    return 0


def do_forget(cfg: Dict[str, object], path: Path, backend, ssid: str) -> int:
    """--forget：删除已保存的网络（系统 profile + config.json 记录）。"""
    if backend:
        try:
            if backend.forget(ssid):
                echo("已删除系统里的网络配置: %s" % ssid)
            else:
                echo("系统里没有「%s」的配置（可能已经删过了）" % ssid)
        except WifiError as exc:
            echo("删除系统配置失败: %s" % exc)
    wifi = wifi_settings(cfg)
    nets = wifi.get("networks")
    if isinstance(nets, list):
        remain = [n for n in nets if not (isinstance(n, dict) and
                                          str(n.get("ssid") or "").strip().lower() == ssid.strip().lower())]
        if len(remain) != len(nets):
            wifi["networks"] = remain
            save_config(path, cfg)
            echo("已从 %s 里删除: %s" % (path, ssid))
    return 0


def do_connect(cfg: Dict[str, object], path: Path, log, backend, args) -> int:
    """--connect SSID：非交互地连接指定网络（可配 --key / --save / --priority）。"""
    if not backend:
        echo("--connect 需要 Wi-Fi 后端（不能和 --no-wifi 一起用）")
        return 2
    ssid = args.connect
    wifi = wifi_settings(cfg)
    entry = find_network_entry(wifi, ssid)
    key = args.key or (str(entry.get("key") or "") if entry else "")
    net = None
    for item in backend.scan():
        if item.ssid.strip().lower() == ssid.strip().lower():
            net = item
            break
    if net is None and entry is None and not args.key:
        echo("没扫描到「%s」；请确认 SSID 拼写，或直接用 --ask 交互式选择" % ssid)
        return 2
    if not key and net is not None and not net.open and not net.saved:
        echo("「%s」需要密码，请加上 --key <密码>" % ssid)
        return 2
    priority = args.priority or (int(entry.get("priority") or 0) if entry else 0)
    save = bool(args.save) or entry is not None
    try:
        backend.connect(ssid, key, persist=save, priority=priority)
    except WifiError as exc:
        echo("连接失败: %s" % exc)
        return 1
    if not wait_connected(backend, ssid, timeout=15):
        echo("[!] 已发起连接，但还没确认连上（无线网卡有时要多等几秒）。")
    if args.save:
        if entry is None:
            nets = wifi.get("networks")
            if not isinstance(nets, list):
                nets = []
                wifi["networks"] = nets
            entry = new_network_entry(ssid, key, priority or next_priority(wifi),
                                      net.security if net else "wpa2")
            nets.append(entry)
        else:
            if key:
                entry["key"] = key
            if priority:
                entry["priority"] = priority
        save_config(path, cfg)
        echo("已保存网络 %s（优先级 %s）到 %s" % (ssid, entry.get("priority"), path))
    apply_portal_block(cfg, ssid)
    return ensure_online(cfg, path, log, interactive=False, ssid=ssid, backend=backend)


def run_boot(cfg: Dict[str, object], path: Path, log, backend) -> int:
    """--boot：开机自启，只连已保存网络 + 认证，绝不询问。"""
    wifi = wifi_settings(cfg)
    timeout = float(wifi.get("connect_timeout") or 10)
    ssid = backend.current_ssid() if backend else ""
    if not ssid and backend and wifi.get("auto_connect", True):
        ssid = connect_saved(cfg, log, backend, timeout=timeout)
    if ssid:
        apply_portal_block(cfg, ssid)
        return ensure_online(cfg, path, log, interactive=False, ssid=ssid, backend=backend)
    if not backend:
        return ensure_online(cfg, path, log, interactive=False)
    log.warn("开机流程：没能连上任何已保存的网络（用户登录后可由向导询问）")
    return 1


def run_smart(cfg: Dict[str, object], path: Path, log, backend, args) -> int:
    """默认模式：能连就连；连不上且有终端才询问用户。"""
    wifi = wifi_settings(cfg)
    timeout = float(wifi.get("prompt_timeout") or 0)
    interactive = (bool(wifi.get("interactive", True)) and not args.non_interactive
                   and sys.stdin.isatty())
    ssid = backend.current_ssid() if backend else ""
    code = 1
    if not ssid and backend:
        ssid = connect_saved(cfg, log, backend, timeout=wifi.get("connect_timeout") or 10)
    if ssid and backend:
        apply_portal_block(cfg, ssid)
        code = ensure_online(cfg, path, log, interactive, timeout, ssid, backend=backend)
        if code == 0:
            return 0
    if not backend:
        return ensure_online(cfg, path, log, interactive, timeout)
    if not interactive:
        if ssid:
            return code
        log.warn("没有连上任何已保存的网络，且当前环境不能交互（开机自启 / 无终端）")
        return 1
    return wizard(cfg, path, log, backend, timeout)


def run_watch(cfg: Dict[str, object], path: Path, log, backend, interval: float) -> int:
    """守护模式：每 interval 秒做一次「连已保存的网络 + 认证」，不询问用户。"""
    interval = max(float(interval or 30), 5.0)
    log.info("守护模式启动：每 %.0f 秒检查一次（Ctrl+C 退出）" % interval)
    while True:
        try:
            code = run_boot(cfg, path, log, backend)
            log.debug("本轮结果: %s" % code)
        except KeyboardInterrupt:
            log.info("收到中断，退出守护模式")
            return 0
        try:
            time.sleep(interval)
        except KeyboardInterrupt:
            log.info("收到中断，退出守护模式")
            return 0


# --------------------------------------------------------------------------- #
# 命令行入口
# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="auto_connect.py",
        description="Wi-Fi 自动连接 + 校园网自动认证（跨平台，只用标准库）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=("示例：\n"
                "  python3 auto_connect.py                    # 智能模式（能连就连，连不上就问）\n"
                "  python3 auto_connect.py --boot             # 开机自启（不询问，只连已保存的）\n"
                "  python3 auto_connect.py --ask              # 交互式扫描 + 询问选网\n"
                "  python3 auto_connect.py --list             # 看已保存 / 可见的网络\n"
                "  python3 auto_connect.py --connect CampusWiFi --key 12345678 --save --priority 1\n"
                "  python3 auto_connect.py --forget CampusWiFi\n"),
    )
    parser.add_argument("-c", "--config", default=str(portal.DEFAULT_CONFIG_PATH),
                        help="配置文件路径（默认与本脚本同目录的 config.json）")
    parser.add_argument("--boot", action="store_true",
                        help="开机自启模式：只连已保存的网络 + 认证，绝不询问")
    parser.add_argument("--ask", action="store_true", help="强制进入交互向导（扫描并询问用户）")
    parser.add_argument("--list", action="store_true", help="列出已保存 / 可见的网络后退出")
    parser.add_argument("--connect", metavar="SSID", help="直接连接指定 SSID")
    parser.add_argument("--key", default="", help="配合 --connect：Wi-Fi 密码")
    parser.add_argument("--save", action="store_true",
                        help="配合 --connect：把网络和密码保存到配置文件")
    parser.add_argument("--priority", type=int, default=0,
                        help="配合 --connect/--save：自动连接优先级 1-9（越小越先连）")
    parser.add_argument("--forget", metavar="SSID", help="删除已保存的网络（系统 + 配置文件）")
    parser.add_argument("--no-wifi", action="store_true", help="跳过 Wi-Fi 管理，只做门户认证")
    parser.add_argument("--non-interactive", action="store_true", help="即使有终端也不询问用户")
    parser.add_argument("--capture", metavar="DIR", help="把认证过程抓包到目录（调试用）")
    parser.add_argument("--log", default="", help="日志文件路径")
    parser.add_argument("-q", "--quiet", action="store_true", help="只输出警告和错误")
    parser.add_argument("--watch", action="store_true",
                        help="守护模式：常驻后台，每隔 --interval 秒重连并认证一次")
    parser.add_argument("--interval", type=float, default=0,
                        help="守护模式的检查间隔秒数（默认取配置里的 interval，最少 5 秒）")
    parser.add_argument("--debug", action="store_true", help="输出调试信息")
    parser.add_argument("--version", action="version", version="auto_connect.py %s" % VERSION)
    return parser


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except (AttributeError, OSError, ValueError):
            pass
    args = build_parser().parse_args(argv)
    path = Path(args.config).expanduser()
    cfg = load_config(path)
    if args.capture:
        cfg["_capture_dir"] = args.capture
    log = portal.Logger(args.log or str(cfg.get("log_file") or "") or portal.default_log_path(),
                        quiet=args.quiet, debug=args.debug)
    try:
        backend = None
        if not args.no_wifi:
            try:
                backend = detect_backend()
            except WifiError as exc:
                log.warn("%s（本次只做门户认证）" % exc)
        if args.list:
            return show_list(backend)
        if args.forget:
            return do_forget(cfg, path, backend, args.forget)
        if args.connect:
            return do_connect(cfg, path, log, backend, args)
        if args.ask:
            if not backend:
                log.error("--ask 需要 Wi-Fi 后端（不能和 --no-wifi 一起用）")
                return 2
            timeout = float(wifi_settings(cfg).get("prompt_timeout") or 0)
            return wizard(cfg, path, log, backend, timeout)
        if args.boot:
            return run_boot(cfg, path, log, backend)
        if args.watch:
            return run_watch(cfg, path, log, backend,
                             args.interval or float(cfg.get("interval") or 30))
        return run_smart(cfg, path, log, backend, args)
    finally:
        log.close()


if __name__ == "__main__":
    raise SystemExit(main())






