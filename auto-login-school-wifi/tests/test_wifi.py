#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""wifi_manager.py / auto_connect.py 的离线自测：不需要真实网卡，也不联网。

运行：python3 tests/test_wifi.py
"""

import http.server
import json
import socket
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import auto_connect  # noqa: E402
import portal_login  # noqa: E402
import wifi_manager as wm  # noqa: E402

PASSED = []
FAILED = []


def check(name, ok, detail=""):
    if ok:
        PASSED.append(name)
        print("  [PASS] %s" % name)
    else:
        FAILED.append(name)
        print("  [FAIL] %s  %s" % (name, detail))


def eq(name, got, want):
    check(name, got == want, "got=%r want=%r" % (got, want))


# --------------------------------------------------------------------------- #
# 测试替身
# --------------------------------------------------------------------------- #
class StubPrompts:
    """把交互函数换成预先排好的答案队列，并静音 echo。"""

    def __init__(self, answers):
        self.queue = list(answers)

    def __enter__(self):
        self._saved = (auto_connect.ask, auto_connect.ask_password,
                       auto_connect.ask_yes_no, auto_connect.echo)
        auto_connect.ask = self._ask
        auto_connect.ask_password = self._ask
        auto_connect.ask_yes_no = self._yes
        auto_connect.echo = self._silent
        return self

    def _ask(self, prompt="", default="", timeout=0):
        return self.queue.pop(0) if self.queue else default

    def _yes(self, prompt="", default=True, timeout=0):
        if not self.queue:
            return default
        answer = self.queue.pop(0).strip().lower()
        return default if answer == "" else answer in auto_connect.YES_WORDS

    @staticmethod
    def _silent(*args, **kwargs):
        return None

    def __exit__(self, *exc):
        (auto_connect.ask, auto_connect.ask_password,
         auto_connect.ask_yes_no, auto_connect.echo) = self._saved
        return False


class OfflinePortal:
    """把门户探测 / 登录换成假实现，保证测试不联网。"""

    def __init__(self, online=True, portal_url="", code=0):
        self.online = online
        self.portal_url = portal_url
        self.code = code
        self.run_calls = []

    def __enter__(self):
        self._probe = portal_login.probe_connectivity
        self._run = portal_login.run_once
        portal_login.probe_connectivity = self._probe_impl
        portal_login.run_once = self._run_impl
        return self

    def _probe_impl(self, session, cfg, log):
        return portal_login.ProbeResult(self.online, self.portal_url, "测试用探测结果", "")

    def _run_impl(self, cfg, log):
        self.run_calls.append(str(cfg.get("username") or ""))
        return self.code

    def __exit__(self, *exc):
        portal_login.probe_connectivity = self._probe
        portal_login.run_once = self._run
        return False


def write_cfg(path, networks=None):
    """写一个最小可用的 config.json（日志也指向临时目录，避免污染真实环境）。"""
    data = {
        "username": "",
        "password": "",
        "type": "auto",
        "log_file": str(Path(path).parent / "test.log"),
        "wifi": {
            "auto_connect": True,
            "interactive": True,
            "prompt_timeout": 0,
            "connect_timeout": 1,
            "networks": networks or [],
        },
    }
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return data


def quiet_log():
    return portal_login.Logger(None, quiet=True)


# --------------------------------------------------------------------------- #
# 样例数据（取自真实命令输出，含中英文两套 netsh 界面）
# --------------------------------------------------------------------------- #
NMCLI_SCAN = "\n".join([
    "*:CampusWiFi:78:WPA2:11",
    ":DSU-Open:32::6",
    r":Lab\:2.4G:55:WPA1 WPA2:1",
    ":   :40:WPA3:9",
])

NMCLI_SAVED = "\n".join([
    "Wired connection 1:802-3-ethernet:yes:0",
    "CampusWiFi:802-11-wireless:yes:3",
    "OldNet:802-11-wireless:no:-5",
])

NETSH_PROFILES_EN = """
Profiles on interface Wi-Fi:

Group policy profiles (read only)
---------------------------------
    <None>

User profiles
-------------
    All User Profile     : HomeWiFi
    All User Profile     : Campus-WiFi
"""

NETSH_PROFILES_ZH = """
接口 Wi-Fi 上的配置文件:

组策略配置文件(只读)
---------------------------------
    <无>

用户配置文件
-------------
    所有用户配置文件 : HomeWiFi
    所有用户配置文件 : Campus-WiFi
"""

NETSH_NETWORKS_EN = """
Interface name : Wi-Fi
There are 3 networks currently visible.

SSID 1 : CampusWiFi
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP
    BSSID 1                 : 1c:4b:d6:00:11:22
         Signal             : 62%
    BSSID 2                 : 1c:4b:d6:00:11:23
         Signal             : 44%

SSID 2 : DSU-Open
    Network type            : Infrastructure
    Authentication          : Open
    Encryption              : None
    BSSID 1                 : 00:11:22:33:44:55
         Signal             : 88%

SSID 3 : WPA3-Test
    Network type            : Infrastructure
    Authentication          : WPA3-Personal
    Encryption              : CCMP
    BSSID 1                 : aa:bb:cc:dd:ee:ff
         Signal             : 30%
"""

NETSH_NETWORKS_ZH = """
接口名称 : Wi-Fi
当前可见 2 个网络。

SSID 1 : 校园网
    网络类型             : 结构
    身份验证             : WPA2-个人
    加密                 : CCMP
    BSSID 1              : 1c:4b:d6:00:11:22
         信号             : 71%

SSID 2 : 免费WiFi
    网络类型             : 结构
    身份验证             : 开放式
    加密                 : 无
    BSSID 1              : 00:11:22:33:44:55
         信号             : 50%
"""

NETSH_INTERFACES_EN = """
There is 1 interface on the system:

    Name                   : Wi-Fi
    Description            : Intel(R) Wi-Fi 6 AX201 160MHz
    GUID                   : 1234abcd-0000-0000-0000-000000000000
    Physical address       : 1c:4b:d6:00:11:22
    State                  : connected
    SSID                   : CampusWiFi
    BSSID                  : 1c:4b:d6:00:11:23
    Network type           : Infrastructure
    Signal                 : 78%
"""

# 多网卡：有线 metric 100 抢了默认路由，Wi-Fi 是 10.150.175.108（校园网段）
IP_ROUTE_DEFAULT = "\n".join([
    "default via 192.168.31.1 dev enp12s0 proto dhcp src 192.168.31.40 metric 100",
    "default via 10.150.0.1 dev wlan0 proto dhcp src 10.150.175.108 metric 600",
])

NMCLI_DEVICE_SHOW = "\n".join([
    "GENERAL.DEVICE:wlan0",
    "IP4.ADDRESS[1]:10.150.175.108/16",
    "IP4.ADDRESS[2]:10.150.175.109/16",
])

NETSH_ADDRESSES_ZH = """
接口 "WLAN" 的配置
    DHCP 已启用:                         是
    IP 地址:                           192.168.1.100
    子网前缀:                        192.168.1.0/24 (掩码 255.255.255.0)
    默认网关:                        192.168.1.1
"""

ROUTE_PRINT_4 = """
===========================================================================
Interface List
 12...aa bb cc dd ee ff ......Intel(R) Wi-Fi 6 AX201 160MHz
===========================================================================
IPv4 Route Table
===========================================================================
Active Routes:
Network Destination        Netmask          Gateway       Interface  Metric
          0.0.0.0          0.0.0.0      192.168.1.1    192.168.1.100     25
          0.0.0.0          0.0.0.0       10.150.0.1    10.150.175.108     50
"""


class _NoContentHandler(http.server.BaseHTTPRequestHandler):
    """测试用：任何请求都回 204。"""

    def do_GET(self):  # noqa: D102
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):  # noqa: D102
        return None


# --------------------------------------------------------------------------- #
# 解析层
# --------------------------------------------------------------------------- #
def test_parsing():
    print("\n== 命令行输出解析 ==")
    eq("split_terse 还原转义冒号", wm.split_terse(r"*:My\:Net:78:WPA2"),
       ["*", "My:Net", "78", "WPA2"])
    eq("split_terse 还原反斜杠", wm.split_terse(r"a\\b:c"), ["a\\b", "c"])

    nets = wm.parse_nmcli_scan(NMCLI_SCAN)
    eq("nmcli 扫描：跳过空 SSID", len(nets), 3)
    eq("nmcli 扫描：SSID", nets[0].ssid, "CampusWiFi")
    eq("nmcli 扫描：当前连接标记", nets[0].active, True)
    eq("nmcli 扫描：信号", nets[0].signal, 78)
    eq("nmcli 扫描：WPA2", nets[0].security, "wpa2")
    eq("nmcli 扫描：开放网络", nets[1].security, "open")
    eq("nmcli 扫描：含冒号的 SSID", nets[2].ssid, "Lab:2.4G")
    eq("nmcli 扫描：WPA1+WPA2 归一到 wpa2", nets[2].security, "wpa2")

    saved = wm.parse_nmcli_saved(NMCLI_SAVED)
    eq("nmcli 已保存：只保留无线", len(saved), 2)
    eq("nmcli 已保存：SSID", saved[0].ssid, "CampusWiFi")
    eq("nmcli 已保存：优先级", saved[0].priority, 3)
    eq("nmcli 已保存：关闭自动连接", saved[1].auto, False)

    eq("netsh 配置列表（英文）", wm.parse_netsh_profiles(NETSH_PROFILES_EN),
       ["HomeWiFi", "Campus-WiFi"])
    eq("netsh 配置列表（中文）", wm.parse_netsh_profiles(NETSH_PROFILES_ZH),
       ["HomeWiFi", "Campus-WiFi"])

    win = wm.parse_netsh_networks(NETSH_NETWORKS_EN)
    eq("netsh 扫描：数量", len(win), 3)
    eq("netsh 扫描：SSID", win[0].ssid, "CampusWiFi")
    eq("netsh 扫描：信号取最大值", win[0].signal, 62)
    eq("netsh 扫描：WPA2-Personal", win[0].security, "wpa2")
    eq("netsh 扫描：Open", win[1].security, "open")
    eq("netsh 扫描：WPA3", win[2].security, "wpa3")

    zh = wm.parse_netsh_networks(NETSH_NETWORKS_ZH)
    eq("netsh 中文扫描：数量", len(zh), 2)
    eq("netsh 中文扫描：SSID", zh[0].ssid, "校园网")
    eq("netsh 中文扫描：WPA2-个人", zh[0].security, "wpa2")
    eq("netsh 中文扫描：信号", zh[0].signal, 71)
    eq("netsh 中文扫描：开放式", zh[1].security, "open")

    eq("netsh 当前 SSID（排除 BSSID）", wm.parse_netsh_interfaces(NETSH_INTERFACES_EN),
       "CampusWiFi")

    eq("安全类型：-- 视为开放", wm.normalize_security("--"), "open")
    eq("安全类型：企业级", wm.normalize_security("WPA2-802.1X"), "enterprise")
    eq("安全类型：WPA3", wm.normalize_security("WPA3-SAE"), "wpa3")

    xml = wm.build_windows_profile_xml("My&Net", "p<w>d", "wpa2", True)
    check("Windows profile XML：含转义后的 SSID", "My&amp;Net" in xml, xml)
    check("Windows profile XML：密码已转义", "p&lt;w&gt;d" in xml, xml)
    check("Windows profile XML：WPA2PSK", "<authentication>WPA2PSK</authentication>" in xml, xml)
    check("Windows profile XML：auto 模式", "<connectionMode>auto</connectionMode>" in xml, xml)
    open_xml = wm.build_windows_profile_xml("FreeWiFi", "", "open", False)
    check("Windows profile XML：开放网络无密钥", "<sharedKey>" not in open_xml, open_xml)
    check("Windows profile XML：manual 模式", "<connectionMode>manual</connectionMode>" in open_xml)


# --------------------------------------------------------------------------- #
# 配置助手 / 连接编排
# --------------------------------------------------------------------------- #
def test_config_helpers():
    print("\n== 配置助手 ==")
    cfg = {"networks": [{"ssid": "A", "priority": 1}, {"ssid": "B", "priority": 3}]}
    eq("next_priority 跳过已用编号", wm.next_priority(cfg), 2)
    eq("find_network_entry 忽略大小写", (wm.find_network_entry(cfg, "a") or {}).get("ssid"), "A")
    eq("find_network_entry 找不到返回 None", wm.find_network_entry(cfg, "ZZ"), None)
    entry = wm.new_network_entry("New", "pw", 2, "wpa2", {"enabled": True})
    eq("new_network_entry 的 SSID", entry["ssid"], "New")
    eq("new_network_entry 的 portal 块", entry["portal"]["enabled"], True)

    nets = [wm.WifiNetwork("B", signal=10),
            wm.WifiNetwork("A", signal=90, saved=True),
            wm.WifiNetwork("C", signal=50)]
    eq("sort_networks 已保存的排前面", [n.ssid for n in wm.sort_networks(nets)], ["A", "C", "B"])


def test_connect_saved():
    print("\n== 已保存网络：按优先级依次连接 ==")
    log = quiet_log()
    cfg = {"wifi": {"networks": [{"ssid": "B", "key": "kb", "priority": 2},
                                 {"ssid": "A", "key": "ka", "priority": 1}]}}
    backend = wm.FakeBackend(saved=[wm.WifiNetwork("A", saved=True),
                                    wm.WifiNetwork("B", saved=True)],
                             fail_connect=["A"])
    eq("高优先级失败后回退到下一个", auto_connect.connect_saved(cfg, log, backend, 1), "B")
    eq("尝试顺序符合优先级", backend.calls, ["connect:A:saved", "connect:B:saved"])

    cfg2 = {"wifi": {"networks": []}}
    backend2 = wm.FakeBackend(saved=[wm.WifiNetwork("OnlySystem", saved=True)])
    eq("系统 profile 也算候选", auto_connect.connect_saved(cfg2, log, backend2, 1), "OnlySystem")

    eq("没有候选时返回空串",
       auto_connect.connect_saved({"wifi": {"networks": []}}, log, wm.FakeBackend(), 1), "")


def test_boot_without_saved():
    print("\n== 开机模式：没有已保存网络 ==")
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "config.json"
        write_cfg(path)
        cfg = auto_connect.load_config(path)
        with OfflinePortal(online=False):
            code = auto_connect.run_boot(cfg, path, quiet_log(), wm.FakeBackend())
        eq("安静退出且返回 1（不卡开机）", code, 1)


def test_wizard_saves_network():
    print("\n== 交互向导：保存网络和密码 ==")
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "config.json"
        write_cfg(path)
        cfg = auto_connect.load_config(path)
        backend = wm.FakeBackend(visible=[wm.WifiNetwork("CampusWiFi", signal=70, security="wpa2"),
                                          wm.WifiNetwork("OpenWiFi", signal=40, security="open")])
        with OfflinePortal(online=True), StubPrompts(["1", "my-secret", "y", "2"]):
            code = auto_connect.wizard(cfg, path, quiet_log(), backend, 0)
        eq("向导返回 0", code, 0)
        eq("以“保存”方式连接", backend.calls[0], "connect:CampusWiFi:saved")
        nets = json.loads(path.read_text(encoding="utf-8"))["wifi"]["networks"]
        eq("写入了 1 条网络记录", len(nets), 1)
        eq("SSID 已保存", nets[0]["ssid"], "CampusWiFi")
        eq("Wi-Fi 密码已保存", nets[0]["key"], "my-secret")
        eq("优先级已保存", nets[0]["priority"], 2)


def test_wizard_single_connection():
    print("\n== 交互向导：只连一次 ==")
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "config.json"
        write_cfg(path)
        cfg = auto_connect.load_config(path)
        backend = wm.FakeBackend(visible=[wm.WifiNetwork("GuestNet", signal=60, security="wpa2")])
        with OfflinePortal(online=True), StubPrompts(["1", "temp-pass", "n"]):
            code = auto_connect.wizard(cfg, path, quiet_log(), backend, 0)
        eq("向导返回 0", code, 0)
        eq("以“只连一次”方式连接", backend.calls[0], "connect:GuestNet:once")
        eq("配置里没有新增网络",
           json.loads(path.read_text(encoding="utf-8"))["wifi"]["networks"], [])


def test_wizard_open_network():
    print("\n== 交互向导：开放网络 ==")
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "config.json"
        write_cfg(path)
        cfg = auto_connect.load_config(path)
        backend = wm.FakeBackend(visible=[wm.WifiNetwork("OpenWiFi", signal=40, security="open")])
        with OfflinePortal(online=True), StubPrompts(["1", "y", "1"]):
            code = auto_connect.wizard(cfg, path, quiet_log(), backend, 0)
        eq("开放网络向导返回 0", code, 0)
        nets = json.loads(path.read_text(encoding="utf-8"))["wifi"]["networks"]
        eq("开放网络已保存", nets[0]["ssid"], "OpenWiFi")
        eq("开放网络不存密码", nets[0]["key"], "")


def test_wizard_skip():
    print("\n== 交互向导：用户跳过 ==")
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "config.json"
        write_cfg(path)
        cfg = auto_connect.load_config(path)
        backend = wm.FakeBackend(visible=[wm.WifiNetwork("X", signal=10)])
        with OfflinePortal(online=True), StubPrompts(["0"]):
            code = auto_connect.wizard(cfg, path, quiet_log(), backend, 0)
        eq("选择跳过返回 3", code, 3)
        eq("没有发起任何连接", backend.calls, [])


# --------------------------------------------------------------------------- #
# 门户认证 + 命令行
# --------------------------------------------------------------------------- #
def test_apply_portal_block():
    print("\n== 按网络的专属门户凭据 ==")
    cfg = {"username": "global", "password": "gp",
           "wifi": {"networks": [{"ssid": "CampusWiFi",
                                  "portal": {"enabled": True, "username": "stu", "password": "sp"}}]}}
    auto_connect.apply_portal_block(cfg, "campuswifi")
    eq("按网络覆盖账号", cfg["username"], "stu")
    eq("按网络覆盖密码", cfg["password"], "sp")
    other = {"username": "global", "wifi": {"networks": []}}
    auto_connect.apply_portal_block(other, "Other")
    eq("没有专属凭据时保留全局账号", other["username"], "global")


def test_ensure_online_asks_credentials():
    print("\n== 公共网络：询问账号密码并保存 ==")
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "config.json"
        write_cfg(path)
        cfg = auto_connect.load_config(path)
        stub = OfflinePortal(online=False, portal_url="http://10.0.0.2/srun_portal_pc", code=0)
        with stub, StubPrompts(["y", "20240001", "portalpass"]):
            code = auto_connect.ensure_online(cfg, path, quiet_log(), True, 0, "CampusWiFi")
        eq("认证成功后返回 0", code, 0)
        eq("用填写的账号登录", stub.run_calls, ["20240001"])
        data = json.loads(path.read_text(encoding="utf-8"))
        eq("全局账号已写入", data["username"], "20240001")
        eq("全局密码已写入", data["password"], "portalpass")
        eq("按网络记录了账号", data["wifi"]["networks"][0]["portal"]["username"], "20240001")
        eq("按网络记录了密码", data["wifi"]["networks"][0]["portal"]["password"], "portalpass")
        check("内部字段不写进配置文件", not any(str(k).startswith("_") for k in data), sorted(data))


def test_ensure_online_non_interactive():
    print("\n== 公共网络：无终端时不阻塞 ==")
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "config.json"
        write_cfg(path)
        cfg = auto_connect.load_config(path)
        with OfflinePortal(online=False, portal_url="http://10.0.0.2/login"):
            code = auto_connect.ensure_online(cfg, path, quiet_log(), False, 0, "")
        eq("缺凭据且非交互时返回 2", code, 2)


def test_route_and_ipv4_parsing():
    print("\n== 默认路由 / 网卡 IPv4 解析 ==")
    eq("默认路由取 metric 最小的一条", wm.parse_default_route(IP_ROUTE_DEFAULT),
       ("enp12s0", "192.168.31.40"))
    eq("只有一条默认路由也认", wm.parse_default_route(
        "default via 10.150.0.1 dev wlan0 proto dhcp src 10.150.175.108 metric 600"),
       ("wlan0", "10.150.175.108"))
    eq("没有默认路由时返回空", wm.parse_default_route(""), ("", ""))
    eq("nmcli 取第一个 IPv4", wm.parse_nmcli_ipv4(NMCLI_DEVICE_SHOW), "10.150.175.108")
    eq("nmcli 没有地址时返回空", wm.parse_nmcli_ipv4("GENERAL.DEVICE:wlan0"), "")
    eq("netsh 中文输出取 IPv4", wm.parse_netsh_addresses(NETSH_ADDRESSES_ZH), "192.168.1.100")
    eq("netsh 英文输出取 IPv4", wm.parse_netsh_addresses("   IP Address:  10.0.0.5"), "10.0.0.5")
    eq("route print 取默认路由接口地址", wm.parse_route_print_default(ROUTE_PRINT_4),
       "192.168.1.100")
    eq("route get 取内核实际出口", wm.parse_route_get(
        "1.1.1.1 via 192.168.31.1 dev enp12s0 src 192.168.31.40 uid 1000\n    cache"),
       ("enp12s0", "192.168.31.40"))
    eq("route get 绑定源地址后没有 src 字段也能取网卡", wm.parse_route_get(
        "1.1.1.1 from 10.150.175.108 via 192.168.31.1 dev enp12s0 uid 1000"),
       ("enp12s0", ""))
    eq("route get 无路由时返回空",
       wm.parse_route_get("RTNETLINK answers: Network is unreachable"), ("", ""))
    eq("FakeBackend 也能报无线网卡地址", wm.FakeBackend(ipv4="10.0.0.7").wifi_ipv4(), "10.0.0.7")


def test_portal_bind_address():
    print("\n== 多网卡：门户请求绑定到无线网卡 ==")
    log = quiet_log()
    wifi_backend = wm.FakeBackend(current="ChinaNet-109-5G", ipv4="10.150.175.108",
                                  device="wlan0")
    saved_route = auto_connect.default_route_source
    saved_get = auto_connect.route_get
    try:
        auto_connect.default_route_source = lambda: ("enp12s0", "192.168.31.40")
        auto_connect.route_get = lambda dest, src="": ("wlan0", src)
        eq("有线抢了默认路由时绑定无线网卡",
           auto_connect.portal_bind_address({}, wifi_backend, log), "10.150.175.108")
        cfg = {"bind_address": "10.0.0.9"}
        eq("配置里手动指定的地址优先", auto_connect.portal_bind_address(cfg, wifi_backend, log),
           "10.0.0.9")
        cfg = {"wifi": {"portal_via_wifi": False}}
        eq("关掉 portal_via_wifi 后不绑定",
           auto_connect.portal_bind_address(cfg, wifi_backend, log), "")

        # 内核会把这种包按默认路由（有线）发走：绑定会让请求全部超时，必须不绑
        auto_connect.route_get = lambda dest, src="": ("enp12s0", "192.168.31.40")
        eq("内核不会走无线网卡时不绑定（否则探测会超时）",
           auto_connect.portal_bind_address({}, wifi_backend, log), "")
        auto_connect.route_get = lambda dest, src="": ("", "")
        eq("查不到内核路由时不绑定",
           auto_connect.portal_bind_address({}, wifi_backend, log), "")

        auto_connect.route_get = lambda dest, src="": ("wlan0", src)
        auto_connect.default_route_source = lambda: ("wlan0", "10.150.175.108")
        eq("默认路由本来就是无线网卡时不绑定",
           auto_connect.portal_bind_address({}, wifi_backend, log), "")
        auto_connect.default_route_source = lambda: ("", "")
        eq("查不到默认路由时不做改动（保持旧行为）",
           auto_connect.portal_bind_address({}, wifi_backend, log), "")
        auto_connect.default_route_source = lambda: ("enp12s0", "192.168.31.40")
        eq("无线网卡没有地址时不绑定",
           auto_connect.portal_bind_address({}, wm.FakeBackend(), log), "")
        eq("拿不到网卡名字时不绑定",
           auto_connect.portal_bind_address(
               {}, wm.FakeBackend(ipv4="10.150.175.108"), log), "")
        eq("没有后端时不绑定", auto_connect.portal_bind_address({}, None, log), "")
    finally:
        auto_connect.default_route_source = saved_route
        auto_connect.route_get = saved_get


def test_portal_session_bind():
    print("\n== 门户会话绑定源地址（真实本地 HTTP）==")
    server = http.server.HTTPServer(("127.0.0.1", 0), _NoContentHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d/probe" % server.server_address[1]
    try:
        log = quiet_log()
        bound = portal_login.PortalSession(
            {"timeout": 5, "bind_address": "127.0.0.1", "insecure_tls": True,
             "use_env_proxy": False}, log)
        eq("绑定源地址后请求正常", bound.request(url, "GET").status, 204)
        eq("会话记录了绑定地址", bound.bind_address, "127.0.0.1")
        plain = portal_login.PortalSession(
            {"timeout": 5, "insecure_tls": True, "use_env_proxy": False}, log)
        eq("不绑定时行为不变", plain.request(url, "GET").status, 204)
        eq("不绑定时不记录地址", plain.bind_address, "")
    finally:
        server.shutdown()
        server.server_close()


def test_bound_socket_ipv4_only():
    print("\n== 绑定 IPv4 源地址时只按 IPv4 解析（校园网 DNS 陷阱）==")
    # 真实症状：校园网 DNS 只给 AAAA（或把 IPv6 排在解析结果最前面）时，
    # socket.create_connection 会在 AF_INET6 的 socket 上 bind 一个 IPv4 源地址，
    # 直接抛 gaierror [Errno -9]，日志里就是「连接失败([Errno -9] Address family
    # for hostname not supported)」，而且探测/认证整条链路都会失败。
    s6 = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    try:
        s6.bind(("127.0.0.1", 0))
        check("前提：AF_INET6 socket 上 bind IPv4 会报错", False, "居然成功了")
    except OSError as exc:
        check("前提：AF_INET6 socket 上 bind IPv4 会报错（复现 [Errno -9]）",
              getattr(exc, "errno", None) == -9, "got=%r" % exc)
    finally:
        s6.close()

    seen = []
    real = socket.getaddrinfo

    def v6_first(host, port, family=0, type=0, proto=0, flags=0):
        seen.append(family)
        infos = real(host, port, family, type, proto, flags)
        return [i for i in infos if i[0] == socket.AF_INET6] + infos

    server = http.server.HTTPServer(("127.0.0.1", 0), _NoContentHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d/probe" % server.server_address[1]
    socket.getaddrinfo = v6_first
    try:
        log = quiet_log()
        sess = portal_login.PortalSession(
            {"timeout": 5, "bind_address": "127.0.0.1", "insecure_tls": True,
             "use_env_proxy": False}, log)
        eq("IPv6 排在解析结果最前面时仍然连得上", sess.request(url, "GET").status, 204)
        eq("绑定 IPv4 时只请求 AF_INET 解析", sorted(set(seen)), [socket.AF_INET])

        def only_v6(host, port, family=0, type=0, proto=0, flags=0):
            seen.append(family)
            if family == socket.AF_INET6:
                return real(host, port, family, type, proto, flags)
            return []

        socket.getaddrinfo = only_v6
        try:
            portal_login._create_bound_socket("v6only.example", 80, 5, ("127.0.0.1", 0))
            check("域名只有 AAAA 时给出清晰错误", False, "竟然连上了")
        except OSError as exc:
            check("域名只有 AAAA 时给出清晰错误（不再是 Errno -9）",
                  "IPv4" in str(exc) and "-9" not in str(exc), "got=%r" % exc)
    finally:
        socket.getaddrinfo = real
        server.shutdown()
        server.server_close()


def test_portal_opt_out():
    print("\n== 显式关闭自动认证（portal.enabled=false）==")
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "config.json"
        write_cfg(path, networks=[{"ssid": "HotelWiFi", "key": "k", "priority": 1,
                                   "portal": {"enabled": False}}])
        cfg = auto_connect.load_config(path)
        cfg["username"], cfg["password"] = "20240001", "pw"
        stub = OfflinePortal(online=False, portal_url="http://10.0.0.2/login")
        with stub:
            code = auto_connect.ensure_online(cfg, path, quiet_log(), True, 0, "HotelWiFi")
        eq("关闭认证的网络返回 3（跳过）", code, 3)
        eq("没有把校园网账号交出去", stub.run_calls, [])
        with stub:
            other = auto_connect.ensure_online(cfg, path, quiet_log(), True, 0, "OtherWiFi")
        eq("其他网络默认仍会自动认证", (other, stub.run_calls), (0, ["20240001"]))


def test_forget():
    print("\n== --forget 删除网络 ==")
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "config.json"
        write_cfg(path, networks=[{"ssid": "Old", "key": "k", "priority": 1}])
        cfg = auto_connect.load_config(path)
        backend = wm.FakeBackend(saved=[wm.WifiNetwork("Old", saved=True)])
        eq("--forget 返回 0", auto_connect.do_forget(cfg, path, backend, "Old"), 0)
        eq("调用了后端删除", backend.calls, ["forget:Old"])
        eq("配置文件里也删掉了",
           json.loads(path.read_text(encoding="utf-8"))["wifi"]["networks"], [])
        eq("删除不存在的网络返回 False（不谎报成功）", wm.FakeBackend().forget("Nope"), False)


def test_cli_connect_save():
    print("\n== --connect --save --priority ==")
    args = auto_connect.build_parser().parse_args(
        ["--connect", "CampusWiFi", "--key", "kk", "--save", "--priority", "1"])
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "config.json"
        write_cfg(path)
        cfg = auto_connect.load_config(path)
        backend = wm.FakeBackend(visible=[wm.WifiNetwork("CampusWiFi", signal=80, security="wpa2")])
        with OfflinePortal(online=True):
            code = auto_connect.do_connect(cfg, path, quiet_log(), backend, args)
        eq("--connect --save 返回 0", code, 0)
        nets = json.loads(path.read_text(encoding="utf-8"))["wifi"]["networks"]
        eq("保存了 SSID", nets[0]["ssid"], "CampusWiFi")
        eq("保存了密码", nets[0]["key"], "kk")
        eq("保存了优先级", nets[0]["priority"], 1)


def test_cli_modes():
    print("\n== 命令行整体行为 ==")
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "config.json"
        write_cfg(path)
        with OfflinePortal(online=True):
            eq("--no-wifi 且已联网 → 0",
               auto_connect.main(["--no-wifi", "--config", str(path), "-q"]), 0)
        eq("--list 能正常跑完（没有后端也不报错）",
           auto_connect.main(["--list", "--config", str(path), "-q"]), 0)
        try:
            auto_connect.build_parser().parse_args(["--version"])
        except SystemExit as exc:
            eq("--version 退出码 0", exc.code, 0)


def main():
    tests = [
        test_parsing,
        test_config_helpers,
        test_connect_saved,
        test_boot_without_saved,
        test_wizard_saves_network,
        test_wizard_single_connection,
        test_wizard_open_network,
        test_wizard_skip,
        test_apply_portal_block,
        test_ensure_online_asks_credentials,
        test_ensure_online_non_interactive,
        test_route_and_ipv4_parsing,
        test_portal_bind_address,
        test_portal_session_bind,
        test_bound_socket_ipv4_only,
        test_portal_opt_out,
        test_forget,
        test_cli_connect_save,
        test_cli_modes,
    ]
    print("Wi-Fi / 自动连接自测（不需要真实网卡，也不联网）")
    print("=" * 62)
    for func in tests:
        try:
            func()
        except Exception as exc:  # 自测脚本：任何异常都记一笔并继续
            import traceback
            traceback.print_exc()
            check("%s 未抛异常" % func.__name__, False, repr(exc))
    print("\n" + "=" * 62)
    print("通过 %d 项 / 失败 %d 项" % (len(PASSED), len(FAILED)))
    if FAILED:
        print("失败项：")
        for name in FAILED:
            print("  - %s" % name)
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



