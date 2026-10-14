#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""校园网自动登录（网页认证 / Captive Portal）—— Windows + Arch Linux 通用。

只依赖 Python 3 标准库（无需 pip / 无需 root），工作流程：

  1. 访问探测地址（generate_204 之类）判断是否已经联网；
  2. 未联网时，跟随网关/服务器跳转找到校园网认证页面；
  3. 自动解析页面里的 ``<form>``（含隐藏字段），填入学号 / 密码并提交；
  4. 再次探测，确认是否真的联网成功（以联网结果为准，而不是只看页面提示）。

校园网认证方式各不相同，脚本内置了几种常见协议 + 一个通用表单自适应模式：

  * ``auto``   : 通用表单自适应（默认，绝大多数网页认证可直接用）
  * ``srun``   : 深澜 / Srun（密码 base64，``/eportal/portal/login``）
  * ``drcom``  : Dr.COM（``DDDDD`` / ``upass``）
  * ``h3c``    : H3C ePortal（``userid`` / ``passwd``）
  * ``ruijie`` : 锐捷 ePortal（``userName`` / ``pwd``）

任何模式都可以用 config.json 里的 ``username_field`` / ``password_field`` /
``extra_fields`` / ``password_encoding`` 去覆盖字段名与密码编码方式，
配合 ``--debug`` / ``--capture`` 抓取真实请求，就能适配任意门户。

详细用法见同目录 README.md。
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.client
import http.cookiejar
import json
import os
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

APP_NAME = "auto-login-school-wifi"
VERSION = "1.0.0"
SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG_PATH = SCRIPT_DIR / "config.json"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# 默认探测地址。只要能正常访问其中一个，就认为“已经联网”。
# 这些地址是各厂商用于判断是否需要登录的轻量接口，即使没有外网也能拿到 302。
DEFAULT_PROBES: List[Dict[str, str]] = [
    {"url": "http://connect.rom.miui.com/generate_204", "expect": "204"},
    {"url": "http://www.gstatic.com/generate_204", "expect": "204"},
    {"url": "http://www.msftconnecttest.com/connecttest.txt", "expect": "body:Microsoft Connect Test"},
    {"url": "http://detectportal.firefox.com/success.txt", "expect": "body:success"},
]

# 表单字段名猜测表（全部按小写比较）
_USERNAME_FIELDS = (
    "username", "user_name", "userid", "user_id", "user", "user_account",
    "account", "loginname", "login_name", "login", "uname", "netid", "net_id",
    "stu_no", "stuno", "student_id", "studentid", "sid", "cardno", "card_no",
    "id", "name", "ddddd", "0mkkey", "userid",
)
_PASSWORD_FIELDS = (
    "password", "passwd", "pass", "pwd", "psw", "upass", "user_password",
    "passcode", "passwd1", "loginpwd",
)

# 首次运行自动生成的配置模板（键的含义见 README.md）
CONFIG_TEMPLATE: Dict[str, object] = {
    "username": "",
    "password": "",
    "type": "auto",
    "portal_url": "",
    "username_field": "",
    "password_field": "",
    "password_encoding": "auto",
    "extra_fields": {},
    "method": "",
    "probe_urls": [],
    "local_ip": "",
    "user_agent": DEFAULT_USER_AGENT,
    "insecure_tls": True,
    "use_env_proxy": False,
    "timeout": 8,
    "interval": 30,
    "verify_interval": 2,
    "log_file": "",
}

# 常见认证系统的字段名预设（仅作为默认值，config.json 里显式写的值优先）
PRESETS: Dict[str, Dict[str, object]] = {
    "drcom": {
        "username_field": "DDDDD",
        "password_field": "upass",
        "password_encoding": "plain",
        "extra_fields": {"0MKKey": "123456"},
    },
    "h3c": {
        "username_field": "userid",
        "password_field": "passwd",
        "password_encoding": "plain",
    },
    "ruijie": {
        "username_field": "userName",
        "password_field": "pwd",
        "password_encoding": "plain",
    },
}


class ConfigError(Exception):
    """配置文件缺失或非法。"""


class NetworkError(Exception):
    """网络层错误（连接失败 / 超时 / TLS 失败）。"""


# --------------------------------------------------------------------------- #
# 日志
# --------------------------------------------------------------------------- #
class Logger:
    """极简 logger：同时写到控制台和日志文件（追加模式）。"""

    def __init__(self, path: Optional[str] = None, quiet: bool = False, debug: bool = False) -> None:
        self.quiet = quiet
        self.debug_enabled = debug
        self._fh = None
        if path:
            try:
                p = Path(path).expanduser()
                p.parent.mkdir(parents=True, exist_ok=True)
                self._fh = p.open("a", encoding="utf-8")
            except OSError as exc:
                print("[WARN] 无法写入日志文件 %s: %s" % (path, exc), file=sys.stderr)

    def _write(self, level: str, msg: str) -> None:
        line = "%s [%s] %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), level, msg)
        if not self.quiet or level in ("ERROR", "WARN"):
            try:
                print(line, flush=True)
            except (UnicodeEncodeError, OSError):
                print(line.encode("utf-8", "replace").decode("ascii", "replace"), flush=True)
        if self._fh is not None:
            try:
                self._fh.write(line + "\n")
                self._fh.flush()
            except OSError:
                pass

    def info(self, msg: str) -> None:
        self._write("INFO", msg)

    def warn(self, msg: str) -> None:
        self._write("WARN", msg)

    def error(self, msg: str) -> None:
        self._write("ERROR", msg)

    def debug(self, msg: str) -> None:
        if self.debug_enabled:
            self._write("DEBUG", msg)

    def close(self) -> None:
        if self._fh is not None:
            try:
                self._fh.close()
            finally:
                self._fh = None


# --------------------------------------------------------------------------- #
# 通用工具
# --------------------------------------------------------------------------- #
def default_log_path() -> str:
    """跨平台默认日志路径。"""
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        return str(Path(base) / APP_NAME / "login.log")
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state")
    return str(Path(base) / APP_NAME / "login.log")


def decode_body(body: bytes, content_type: str = "") -> str:
    """按 Content-Type 里的 charset 解码，猜不到就依次尝试 utf-8 / gb18030。"""
    charset = ""
    m = re.search(r"charset\s*=\s*[\"']?([\w\-]+)", content_type or "", re.I)
    if m:
        charset = m.group(1)
    for enc in (charset, "utf-8", "gb18030", "big5", "latin-1"):
        if not enc:
            continue
        try:
            return body.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return body.decode("utf-8", errors="replace")


def encode_password(password: str, mode: str) -> str:
    """按门户要求编码密码。"""
    mode = (mode or "plain").strip().lower()
    raw = password.encode("utf-8")
    if mode in ("", "plain", "text", "auto"):
        return password
    if mode == "base64":
        return base64.b64encode(raw).decode("ascii")
    if mode in ("md5", "md5-lower"):
        return hashlib.md5(raw).hexdigest()
    if mode == "md5-upper":
        return hashlib.md5(raw).hexdigest().upper()
    if mode in ("md5-16", "md5-16-lower"):
        return hashlib.md5(raw).hexdigest()[:16]
    if mode == "md5-16-upper":
        return hashlib.md5(raw).hexdigest()[:16].upper()
    if mode == "sha1":
        return hashlib.sha1(raw).hexdigest()
    if mode in ("url", "urlencode", "quote"):
        return urllib.parse.quote(password)
    raise ConfigError("未知的 password_encoding: %s" % mode)


def get_local_ip(host: str, port: int = 80) -> str:
    """通过 UDP connect 拿到本机在对应网段的出口 IP（不会真的发包）。"""
    sock = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(2.0)
        sock.connect((host, port))
        return sock.getsockname()[0]
    except OSError:
        return ""
    finally:
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass


_META_REFRESH_RE = re.compile(
    r"""<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["']?[^"'>]*?url\s*=\s*([^"'>\s]+)""",
    re.I,
)
_JS_REDIRECT_RES = (
    re.compile(r"""(?:window|top|self|parent|document)?\.?location(?:\.href|\.replace\s*\(|\s*=)\s*["']([^"']+)["']""", re.I),
    re.compile(r"""location\.replace\s*\(\s*["']([^"']+)["']""", re.I),
)


def find_redirect_target(html: str, base_url: str) -> str:
    """从 HTML 里的 meta refresh / JS location 中提取跳转目标。"""
    m = _META_REFRESH_RE.search(html or "")
    if m:
        return urllib.parse.urljoin(base_url, m.group(1).strip())
    for rx in _JS_REDIRECT_RES:
        m = rx.search(html or "")
        if m:
            target = m.group(1).strip()
            if target and not target.startswith(("javascript:", "#")):
                return urllib.parse.urljoin(base_url, target)
    return ""


def same_host(url_a: str, url_b: str) -> bool:
    try:
        ha = urllib.parse.urlparse(url_a).hostname or ""
        hb = urllib.parse.urlparse(url_b).hostname or ""
    except ValueError:
        return False
    return ha.lower() == hb.lower()


def base_of(url: str) -> str:
    """取 scheme://host:port（深澜接口需要用它拼 /eportal/portal/login）。"""
    try:
        p = urllib.parse.urlparse(url)
    except ValueError:
        return ""
    if not p.scheme or not p.hostname:
        return ""
    netloc = p.hostname
    if p.port:
        netloc += ":%d" % p.port
    return "%s://%s" % (p.scheme, netloc)


def looks_like_login_page(text: str) -> bool:
    """粗略判断一段 HTML / 文本是不是认证页面。"""
    if not text:
        return False
    low = text.lower()
    if "<form" in low and any(k in low for k in ("password", "passwd", "pwd", "upass", "pass")):
        return True
    if "dr100" in low or "eportal" in low or "portal" in low:
        return True
    return any(k in text for k in ("认证", "登录", "上网", "校园网", "网络接入"))


# --------------------------------------------------------------------------- #
# 配置
# --------------------------------------------------------------------------- #
def write_config_template(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(CONFIG_TEMPLATE, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)  # POSIX 下只允许本人读写（里面有密码）
    except OSError:
        pass


def load_config(path: Path) -> Dict[str, object]:
    if not path.exists():
        raise ConfigError("配置文件不存在: %s" % path)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise ConfigError("配置文件不是合法 JSON: %s" % exc)
    if not isinstance(raw, dict):
        raise ConfigError("配置文件顶层必须是 JSON 对象")
    cfg: Dict[str, object] = dict(CONFIG_TEMPLATE)
    cfg.update(raw)
    return cfg


def apply_overrides(cfg: Dict[str, object], args: argparse.Namespace) -> Dict[str, object]:
    """环境变量 < 命令行，优先级更高者覆盖配置。"""
    env_user = os.environ.get("CAMPUS_PORTAL_USERNAME")
    env_pass = os.environ.get("CAMPUS_PORTAL_PASSWORD")
    if env_user:
        cfg["username"] = env_user
    if env_pass:
        cfg["password"] = env_pass
    if args.username:
        cfg["username"] = args.username
    if args.password:
        cfg["password"] = args.password
    if args.type:
        cfg["type"] = args.type
    if args.portal_url:
        cfg["portal_url"] = args.portal_url
    if args.log_file:
        cfg["log_file"] = args.log_file
    if args.interval is not None:
        cfg["interval"] = args.interval
    if args.probe_url:
        cfg["probe_urls"] = [{"url": u, "expect": "204"} for u in args.probe_url]
    if args.bind_address:
        cfg["bind_address"] = args.bind_address.strip()
    if args.password_encoding:
        cfg["password_encoding"] = args.password_encoding
    cfg["type"] = str(cfg.get("type") or "auto").strip().lower()
    return cfg


def apply_preset(cfg: Dict[str, object], kind: str) -> Dict[str, object]:
    """把认证系统的字段名预设作为默认值合并进来（用户显式配置优先）。"""
    preset = PRESETS.get(kind)
    if not preset:
        return cfg
    for key, value in preset.items():
        if key == "extra_fields":
            merged: Dict[str, object] = dict(value)  # type: ignore[arg-type]
            merged.update(cfg.get("extra_fields") or {})  # type: ignore[arg-type]
            cfg["extra_fields"] = merged
        elif not cfg.get(key) or cfg.get(key) == "auto":
            cfg[key] = value
    return cfg


def validate_config(cfg: Dict[str, object], need_credentials: bool = True) -> Dict[str, object]:
    if need_credentials:
        if not str(cfg.get("username") or "").strip():
            raise ConfigError("缺少账号：请在 config.json 里填写 username，或使用 -u/--username")
        if not str(cfg.get("password") or ""):
            raise ConfigError("缺少密码：请在 config.json 里填写 password，或使用 -p/--password")
    return cfg


# --------------------------------------------------------------------------- #
# HTML 表单解析与自动识别
# --------------------------------------------------------------------------- #
@dataclass
class HtmlForm:
    action: str = ""
    method: str = "post"
    base_url: str = ""
    index: int = 0
    inputs: List[Dict[str, str]] = field(default_factory=list)

    def names(self) -> List[str]:
        return [i["name"] for i in self.inputs if i.get("name")]

    def data(self) -> Dict[str, str]:
        """取出浏览器会提交的字段（跳过按钮/复选框/单选，它们交给 extra_fields 控制）。"""
        out: Dict[str, str] = {}
        for item in self.inputs:
            name = item.get("name") or ""
            if not name:
                continue
            itype = (item.get("type") or "").lower()
            if itype in ("submit", "button", "reset", "image", "file", "checkbox", "radio"):
                continue
            out[name] = item.get("value") or ""
        return out

    def action_url(self) -> str:
        action = (self.action or "").strip()
        if action.lower().startswith("javascript:"):
            action = ""
        target = action or self.base_url.split("#")[0]
        return urllib.parse.urljoin(self.base_url, target)


class _FormParser(HTMLParser):
    """把 HTML 里的 form / input 抽出来，保留隐藏字段的默认值。"""

    def __init__(self, base_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.forms: List[HtmlForm] = []
        self._current: Optional[HtmlForm] = None
        self._select: Optional[Dict[str, str]] = None
        self._in_option = False
        self._option_text: List[str] = []

    def handle_starttag(self, tag, attrs):  # noqa: D102
        a = {str(k).lower(): (v or "") for k, v in attrs}
        tag = tag.lower()
        if tag == "form":
            self._current = HtmlForm(action=a.get("action", ""), method=(a.get("method") or "post").lower(),
                                     base_url=self.base_url, index=len(self.forms))
            self.forms.append(self._current)
        elif self._current is None:
            return
        elif tag == "input":
            self._current.inputs.append({"name": a.get("name", ""),
                                         "type": (a.get("type") or "text").lower(),
                                         "value": a.get("value", "")})
        elif tag == "select":
            item = {"name": a.get("name", ""), "type": "select", "value": ""}
            self._current.inputs.append(item)
            self._select = item
        elif tag == "option" and self._select is not None:
            self._in_option = True
            self._option_text = []
            if "selected" in a or not self._select["value"]:
                self._select["value"] = a.get("value", "")
        elif tag == "textarea":
            self._current.inputs.append({"name": a.get("name", ""), "type": "textarea", "value": a.get("value", "")})
        elif tag == "button":
            self._current.inputs.append({"name": a.get("name", ""),
                                         "type": (a.get("type") or "submit").lower(),
                                         "value": a.get("value", "")})

    def handle_data(self, data):  # noqa: D102
        if self._in_option:
            self._option_text.append(data)

    def handle_endtag(self, tag):  # noqa: D102
        tag = tag.lower()
        if tag == "form":
            self._current = None
        elif tag == "select":
            self._select = None
        elif tag == "option":
            if self._select is not None and not self._select["value"]:
                self._select["value"] = "".join(self._option_text).strip()
            self._in_option = False


def parse_forms(html: str, base_url: str) -> List[HtmlForm]:
    parser = _FormParser(base_url)
    try:
        parser.feed(html or "")
        parser.close()
    except Exception:  # 门户页面千奇百怪，解析失败就当没表单
        pass
    return parser.forms


def _guess_username(form: HtmlForm) -> str:
    for item in form.inputs:
        name = item.get("name") or ""
        if name and name.lower() in _USERNAME_FIELDS:
            return name
    for item in form.inputs:
        name = item.get("name") or ""
        low = name.lower()
        if not name or any(bad in low for bad in ("password", "passwd", "pwd", "pass", "captcha", "verify", "code")):
            continue
        if any(k in low for k in ("user", "account", "login", "netid", "stu", "card", "uname", "name", "id")):
            return name
    return ""


def _guess_password(form: HtmlForm) -> str:
    for item in form.inputs:
        if (item.get("type") or "") == "password" and item.get("name"):
            return item["name"]
    for item in form.inputs:
        name = item.get("name") or ""
        if name and name.lower() in _PASSWORD_FIELDS:
            return name
    for item in form.inputs:
        name = item.get("name") or ""
        if name and any(k in name.lower() for k in ("pass", "pwd", "psw")):
            return name
    return ""


def pick_form(forms: Sequence[HtmlForm], cfg: Dict[str, object]) -> Tuple[Optional[HtmlForm], str, str]:
    """挑选最像登录表单的一个，返回 (表单, 用户名字段, 密码字段)。"""
    user_override = str(cfg.get("username_field") or "").strip()
    pass_override = str(cfg.get("password_field") or "").strip()
    best: Optional[HtmlForm] = None
    best_user = best_pass = ""
    best_score = -1
    for form in forms:
        lower_names = {n.lower(): n for n in form.names()}
        user = lower_names.get(user_override.lower(), "") if user_override else ""
        pwd = lower_names.get(pass_override.lower(), "") if pass_override else ""
        if not user:
            user = _guess_username(form)
        if not pwd:
            pwd = _guess_password(form)
        score = (4 if user else 0) + (5 if pwd else 0)
        if any((i.get("type") or "") == "password" for i in form.inputs):
            score += 2
        if str(form.method).lower() == "post":
            score += 1
        if score > best_score:
            best, best_score, best_user, best_pass = form, score, user, pwd
    if best is None or best_score <= 0:
        return None, "", ""
    return best, best_user, best_pass


# --------------------------------------------------------------------------- #
# HTTP 会话
# --------------------------------------------------------------------------- #
def _lower_headers(headers) -> Dict[str, str]:
    out: Dict[str, str] = {}
    if headers is None:
        return out
    for key, value in headers.items():
        out[str(key).lower()] = str(value)
    return out


@dataclass
class Resp:
    url: str
    status: int
    headers: Dict[str, str]
    body: bytes

    @property
    def text(self) -> str:
        return decode_body(self.body, self.headers.get("content-type", ""))


class _RedirectHandler(urllib.request.HTTPRedirectHandler):
    """可按需关闭自动跟随跳转（用于观察 302 的 Location）。"""

    def __init__(self, session: "PortalSession") -> None:
        self.session = session

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        if not self.session.follow_redirects:
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _create_bound_socket(host: str, port: int, timeout, source_address: Tuple[str, int]) -> socket.socket:
    """按「源地址的地址族」解析并连接，返回已连上的 socket。

    这里必须自己解析，不能直接用 ``socket.create_connection``：后者会把 AAAA
    记录也当候选，而在 AF_INET6 的 socket 上 bind 一个 IPv4 源地址会直接抛
    ``gaierror: [Errno -9] Address family for hostname not supported``
    （实测：校园网 DNS 只给 AAAA、或解析结果把 IPv6 排在前面时就会出现，
    日志里表现为「连接失败([Errno -9] Address family for hostname not
    supported)」）。绑定 IPv4 时只解析 IPv4；确实没有 IPv4 地址时，
    给出看得懂的错误，而不是那句莫名其妙的 Errno -9。
    """
    family = socket.AF_INET6 if ":" in str(source_address[0]) else socket.AF_INET
    if timeout is None or timeout is getattr(socket, "_GLOBAL_DEFAULT_TIMEOUT", None):
        timeout = None
    errors: List[OSError] = []
    for af, socktype, proto, _canon, sockaddr in socket.getaddrinfo(
            host, port, family, socket.SOCK_STREAM):
        sock = None
        try:
            sock = socket.socket(af, socktype, proto)
            sock.settimeout(timeout)
            sock.bind(source_address)
            sock.connect(sockaddr)
            return sock
        except OSError as exc:
            errors.append(exc)
            if sock is not None:
                sock.close()
    if errors:
        raise errors[0]
    raise OSError("域名 %s 没有 %s 地址（请求已绑定源地址 %s）"
                  % (host, "IPv6" if family == socket.AF_INET6 else "IPv4", source_address[0]))


class _BoundConnectionMixin:
    """让 http.client 的连接把 TCP 源地址钉在指定网卡的 IP 上。

    接入点说明：Python 3.13+ 在 ``HTTPConnection.__init__`` 里把
    ``socket.create_connection`` 存成了**实例属性**（标准库注释原话就是
    "stored as an instance variable to allow unit tests to replace it"），
    所以既要定义类级 ``_create_connection``（3.12 及更早用它），
    也要在 ``super().__init__()`` 之后把实例属性覆盖回来（否则会被它顶掉）。
    """

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._create_connection = self._create_bound_connection

    def _create_bound_connection(self, address, timeout=None, source_address=None):
        if not source_address:
            return socket.create_connection(address, timeout)
        return _create_bound_socket(address[0], address[1], timeout, source_address)

    _create_connection = _create_bound_connection   # 兼容 3.12 及更早版本


class _BoundHTTPConnection(_BoundConnectionMixin, http.client.HTTPConnection):
    """绑定源地址的 HTTP 连接。"""


class _BoundHTTPSConnection(_BoundConnectionMixin, http.client.HTTPSConnection):
    """绑定源地址的 HTTPS 连接。"""


class _SourceBoundHTTPHandler(urllib.request.HTTPHandler):
    """把 TCP 源地址钉在指定网卡的 IP 上。

    多网卡机器（有线 + 无线同时在线）上，请求默认从「默认路由」那张网卡出去；
    绑定源地址后，探测和认证才会真的走无线网卡。
    """

    def __init__(self, source_address: Tuple[str, int]) -> None:
        super().__init__()
        self._source_address = source_address

    def http_open(self, req):  # noqa: D102
        return self.do_open(_BoundHTTPConnection, req,
                            source_address=self._source_address)


class _SourceBoundHTTPSHandler(urllib.request.HTTPSHandler):
    """同上，HTTPS 版本。"""

    def __init__(self, context: "ssl.SSLContext", source_address: Tuple[str, int]) -> None:
        super().__init__(context=context)
        self._source_address = source_address

    def https_open(self, req):  # noqa: D102
        return self.do_open(_BoundHTTPSConnection, req, context=self._context,
                            source_address=self._source_address)


class PortalSession:
    """带 Cookie / 重定向 / 超时 / 抓包能力的 HTTP 会话。"""

    def __init__(self, cfg: Dict[str, object], log: Logger, capture_dir: Optional[str] = None) -> None:
        self.cfg = cfg
        self.log = log
        self.follow_redirects = True
        self.capture_dir = Path(capture_dir) if capture_dir else None
        self._capture_index = 0
        self.cookies = http.cookiejar.CookieJar()
        self.timeout = float(cfg.get("timeout") or 8)
        context = ssl.create_default_context()
        if cfg.get("insecure_tls", True):
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
        handlers: List[urllib.request.BaseHandler] = [
            _RedirectHandler(self),
            urllib.request.HTTPCookieProcessor(self.cookies),
        ]
        # 指定了源地址就绑定它（多网卡机器上强制走无线网卡），否则跟随系统默认路由
        bind = str(cfg.get("bind_address") or cfg.get("_bind_address") or "").strip()
        self.bind_address = bind
        if bind:
            handlers.append(_SourceBoundHTTPHandler((bind, 0)))
            handlers.append(_SourceBoundHTTPSHandler(context, (bind, 0)))
        else:
            handlers.append(urllib.request.HTTPSHandler(context=context))
        if not cfg.get("use_env_proxy", False):
            # 校园网认证走内网直连，禁止系统/环境代理干扰
            handlers.append(urllib.request.ProxyHandler({}))
        self.opener = urllib.request.build_opener(*handlers)
        if bind:
            self.log.debug("门户请求已绑定源地址: %s" % bind)

    def request(self, url: str, method: str = "GET", data: Optional[bytes] = None, referer: str = "",
                content_type: str = "", extra_headers: Optional[Dict[str, str]] = None) -> Resp:
        headers = {
            "User-Agent": str(self.cfg.get("user_agent") or DEFAULT_USER_AGENT),
            "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Connection": "close",
        }
        if referer:
            headers["Referer"] = referer
        if data is not None:
            headers["Content-Type"] = content_type or "application/x-www-form-urlencoded"
        if extra_headers:
            headers.update(extra_headers)
        req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
        self.log.debug("--> %s %s%s" % (method.upper(), url, (" body=%r" % data) if data else ""))
        try:
            with self.opener.open(req, timeout=self.timeout) as raw:
                status = getattr(raw, "status", None)
                if status is None:
                    status = raw.getcode()
                result = Resp(raw.geturl(), int(status), _lower_headers(raw.headers), raw.read())
        except urllib.error.HTTPError as exc:
            body = b""
            try:
                body = exc.read()
            except Exception:
                pass
            result = Resp(exc.geturl() or url, int(exc.code), _lower_headers(exc.headers), body)
        except (urllib.error.URLError, socket.timeout, TimeoutError, OSError, ValueError) as exc:
            raise NetworkError(str(getattr(exc, "reason", exc)))
        self.log.debug("<-- %s %s (%d 字节)" % (result.status, result.url, len(result.body)))
        self._capture(req, result)
        return result

    def _capture(self, req: urllib.request.Request, resp: Resp) -> None:
        """把请求/响应落到文件，便于适配真实门户（--capture）。"""
        if not self.capture_dir:
            return
        self._capture_index += 1
        try:
            self.capture_dir.mkdir(parents=True, exist_ok=True)
            safe = re.sub(r"[^A-Za-z0-9._-]+", "_", "%s_%s" % (req.get_method(), req.full_url))[:120]
            name = "%03d-%s.txt" % (self._capture_index, safe)
            lines = ["# ---------- 请求 ----------", "%s %s" % (req.get_method(), req.full_url), "--- 请求头 ---"]
            lines += ["%s: %s" % (k, v) for k, v in req.header_items()]
            if req.data:
                lines.append("--- 请求体 ---")
                lines.append(decode_body(req.data, "application/x-www-form-urlencoded"))
            lines += ["", "# ---------- 响应 ----------", "HTTP %s  (最终地址: %s)" % (resp.status, resp.url),
                      "--- 响应头 ---"]
            lines += ["%s: %s" % (k, v) for k, v in resp.headers.items()]
            lines += ["--- 响应体（最多 20000 字符）---", resp.text[:20000]]
            (self.capture_dir / name).write_text("\n".join(lines) + "\n", encoding="utf-8")
        except OSError as exc:
            self.log.warn("写入抓包文件失败: %s" % exc)


# --------------------------------------------------------------------------- #
# 联网探测 / 认证页面发现
# --------------------------------------------------------------------------- #
@dataclass
class ProbeResult:
    online: bool
    portal_url: str = ""
    detail: str = ""
    endpoint: str = ""


def _probe_ok(resp: Resp, expect: str) -> bool:
    expect = (expect or "204").strip().lower()
    if expect == "204":
        return resp.status == 204
    if expect == "200":
        return resp.status == 200
    if expect.startswith("body:"):
        return resp.status == 200 and expect[5:] in resp.text.lower()
    return resp.status == 204


def portal_from_response(resp: Resp, probe_url: str, log: Logger) -> str:
    """从一个「非预期」响应里推断出认证页面地址。"""
    hint = find_redirect_target(resp.text, resp.url)
    if hint:
        log.debug("页面内跳转提示: %s" % hint)
        return hint
    location = resp.headers.get("location", "")
    if location and not same_host(resp.url, probe_url):
        return urllib.parse.urljoin(resp.url, location)
    if not same_host(resp.url, probe_url):
        # 被 302 到了别的地址（urllib 已自动跟随）
        return resp.url
    if looks_like_login_page(resp.text):
        # 地址没变但内容被劫持成了认证页
        return resp.url
    return ""


def probe_connectivity(session: PortalSession, cfg: Dict[str, object], log: Logger) -> ProbeResult:
    """依次访问探测地址；任意一个符合预期即认为「已联网」。"""
    probes = cfg.get("probe_urls") or DEFAULT_PROBES
    details: List[str] = []
    for item in probes:
        if isinstance(item, str):
            item = {"url": item, "expect": "204"}
        url = str(item.get("url") or "")
        if not url:
            continue
        expect = str(item.get("expect") or "204")
        log.debug("探测 %s（期望 %s）" % (url, expect))
        try:
            resp = session.request(url, "GET")
        except NetworkError as exc:
            details.append("%s: 连接失败(%s)" % (url, exc))
            continue
        if _probe_ok(resp, expect):
            return ProbeResult(True, "", "%s 判定为已联网（HTTP %s）" % (url, resp.status), url)
        details.append("%s: HTTP %s" % (url, resp.status))
        portal = portal_from_response(resp, url, log)
        if portal:
            return ProbeResult(False, portal, "%s 被重定向到认证页面" % url, url)
    return ProbeResult(False, "", "；".join(details) or "所有探测地址均不可用", "")


def fetch_login_page(session: PortalSession, cfg: Dict[str, object], url: str,
                     log: Logger, max_hops: int = 6) -> Tuple[str, str, List[HtmlForm]]:
    """跟随 meta refresh / JS 跳转，直到找到带表单的认证页面。"""
    seen = set()
    current = url
    page_url = url
    html = ""
    for hop in range(max_hops):
        resp = session.request(current, "GET", referer=str(cfg.get("portal_url") or ""))
        page_url, html = resp.url, resp.text
        forms = parse_forms(html, page_url)
        if forms:
            return page_url, html, forms
        hint = find_redirect_target(html, page_url)
        if not hint or hint in seen:
            break
        seen.add(hint)
        log.debug("跟随第 %d 跳 -> %s" % (hop + 1, hint))
        current = hint
    return page_url, html, []


# --------------------------------------------------------------------------- #
# 登录结果判定 / 通用表单登录
# --------------------------------------------------------------------------- #
_SUCCESS_WORDS = (
    "登录成功", "认证成功", "上线成功", "成功登录", "您已成功", "连接成功",
    "login success", "loginsuccess", "success", '"result":1', '"result": 1',
    '"ret_code":0', '"code":0', '"code": 0', '"success":true',
)
_FAILURE_WORDS = (
    "密码错误", "用户名或密码错误", "账号或密码错误", "用户不存在", "认证失败", "登录失败",
    "认证不通过", "账号被锁定", "密码不正确", "已被锁定", "invalid password",
    "authentication failed", "login failed", '"result":0', '"result": 0',
    '"ret_code":1', '"success":false',
)


def classify_login_text(text: str) -> Tuple[str, str]:
    """根据返回内容粗略判断登录结果（最终仍以联网探测为准）。"""
    if not text:
        return "unknown", ""
    low = text.lower()
    for word in _FAILURE_WORDS:
        if word in text or word in low:
            return "failure", word
    for word in _SUCCESS_WORDS:
        if word in text or word in low:
            return "success", word
    return "unknown", ""


def detect_password_encoding(page_html: str, cfg: Dict[str, object]) -> str:
    """password_encoding=auto 时，根据页面里的 JS 线索猜一下密码编码方式。"""
    mode = str(cfg.get("password_encoding") or "auto").strip().lower()
    if mode not in ("", "auto"):
        return mode
    low = (page_html or "").lower()
    if "btoa" in low or "base64" in low:
        return "base64"
    if "md5" in low:
        return "md5"
    return "plain"


def login_generic(session: PortalSession, cfg: Dict[str, object], log: Logger,
                  portal_url: str) -> Tuple[bool, str]:
    """通用表单登录：解析认证页 -> 填账号密码（含隐藏字段）-> 提交。"""
    page_url, html, forms = fetch_login_page(session, cfg, portal_url, log)
    if not forms:
        return False, "在 %s 没有找到登录表单（可用 --capture 看看这个页面）" % page_url
    form, user_field, pass_field = pick_form(forms, cfg)
    if form is None or not user_field or not pass_field:
        return False, "没能自动识别账号/密码字段，请在 config.json 设置 username_field / password_field"
    data = form.data()
    encoding = detect_password_encoding(html, cfg)
    data[user_field] = str(cfg.get("username") or "")
    data[pass_field] = encode_password(str(cfg.get("password") or ""), encoding)
    for key, value in (cfg.get("extra_fields") or {}).items():  # type: ignore[union-attr]
        data[str(key)] = str(value)
    action = form.action_url()
    others = sorted(set(data) - {user_field, pass_field})
    log.info("识别到表单: 账号字段=%s 密码字段=%s 密码编码=%s 提交地址=%s"
             % (user_field, pass_field, encoding, action))
    log.info("随同提交的字段: %s" % (", ".join(others) or "(无)"))
    method = str(cfg.get("method") or form.method or "post").upper()
    payload = urllib.parse.urlencode(data, encoding="utf-8").encode()
    if method == "GET":
        sep = "&" if "?" in action else "?"
        resp = session.request(action + sep + payload.decode(), "GET", referer=page_url)
    else:
        resp = session.request(action, "POST", data=payload, referer=page_url)
    verdict, word = classify_login_text(resp.text)
    detail = "HTTP %s" % resp.status
    if word:
        detail += "，页面提示: %s" % word
    if verdict == "failure":
        return False, detail
    return True, detail


# --------------------------------------------------------------------------- #
# 深澜 / Srun 专用适配器
# --------------------------------------------------------------------------- #
def login_srun(session: PortalSession, cfg: Dict[str, object], log: Logger,
               portal_url: str) -> Tuple[bool, str]:
    """深澜（Srun）eportal 接口：密码 base64，GET 提交，返回 JSONP 回调。"""
    base = base_of(str(cfg.get("portal_url") or portal_url or ""))
    if not base:
        return False, "无法确定深澜认证服务器地址，请在 config.json 填 portal_url（例如 http://10.0.0.2）"
    parsed = urllib.parse.urlparse(base)
    host = parsed.hostname or ""
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    local_ip = str(cfg.get("local_ip") or "") or get_local_ip(host, port)
    account = str(cfg.get("username") or "")
    domain = str(cfg.get("srun_domain") or "")
    if domain and "@" not in account:
        account += domain
    params = {
        "callback": "dr1004",
        "login_method": "1",
        "user_account": account,
        "user_password": base64.b64encode(str(cfg.get("password") or "").encode("utf-8")).decode("ascii"),
        "wlan_user_ip": local_ip,
        "wlan_user_ipv6": "",
        "wlan_user_mac": str(cfg.get("local_mac") or "000000000000"),
        "wlan_ac_ip": str(cfg.get("srun_ac_ip") or ""),
        "wlan_ac_name": str(cfg.get("srun_ac_name") or ""),
        "jsVersion": "4.2.1",
        "terminal_type": "1",
        "lang": "zh-cn",
        "v": str(int(time.time() * 1000)),
    }
    url = base.rstrip("/") + "/eportal/portal/login?" + urllib.parse.urlencode(params)
    log.info("深澜认证: 服务器=%s 本机IP=%s 账号=%s" % (base, local_ip or "(未知)", account))
    resp = session.request(url, "GET", referer=portal_url or base)
    body = resp.text.strip()
    payload = body
    wrapped = re.search(r"\((.*)\)\s*;?\s*$", body, re.S)
    if wrapped:
        payload = wrapped.group(1)
    result = None
    message = payload[:200]
    try:
        obj = json.loads(payload)
        result = obj.get("result")
        message = str(obj.get("msg") or obj.get("message") or message)
    except ValueError:
        m = re.search(r'"result"\s*:\s*(-?\d+)', body)
        if m:
            result = int(m.group(1))
        m = re.search(r'"msg"\s*:\s*"((?:[^"\\]|\\.)*)"', body)
        if m:
            try:
                message = json.loads('"%s"' % m.group(1))
            except ValueError:
                message = m.group(1)
    detail = "HTTP %s，result=%s，msg=%s" % (resp.status, result, message)
    if result == 1:
        return True, detail
    if result is None:
        verdict, word = classify_login_text(body)
        if verdict == "success":
            return True, detail
        if verdict == "failure":
            return False, detail
    return False, detail


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def run_once(cfg: Dict[str, object], log: Logger) -> int:
    """执行一次「探测 -> 登录 -> 复检」。返回 0 成功 / 1 失败 / 2 配置或环境问题。"""
    session = PortalSession(cfg, log, capture_dir=cfg.get("_capture_dir"))  # type: ignore[arg-type]
    state = probe_connectivity(session, cfg, log)
    if state.online:
        log.info("[OK] 网络已连接，无需登录（%s）" % state.detail)
        return 0
    log.info("检测到未联网：%s" % state.detail)
    kind = str(cfg.get("type") or "auto").lower()
    portal_url = str(cfg.get("portal_url") or state.portal_url or "")
    if not portal_url and kind != "srun":
        log.error("找不到认证页面，请把认证页面地址填到 config.json 的 portal_url")
        return 2
    try:
        if kind == "srun":
            ok, detail = login_srun(session, cfg, log, portal_url)
        else:
            apply_preset(cfg, kind)
            ok, detail = login_generic(session, cfg, log, portal_url)
    except ConfigError as exc:
        log.error(str(exc))
        return 2
    except NetworkError as exc:
        log.error("请求认证服务器失败: %s" % exc)
        return 2
    log.info("提交结果: %s（%s）" % ("成功" if ok else "失败", detail))
    # 复检：以真实联网结果为准，而不是只看页面提示
    for attempt in range(3):
        if attempt:
            time.sleep(max(float(cfg.get("verify_interval") or 2), 0.1))
        again = probe_connectivity(session, cfg, log)
        if again.online:
            log.info("[OK] 校园网自动登录成功")
            return 0
    log.error("[失败] 登录请求已发出但仍未联网；用 --capture 抓包核对字段（见 README「适配你自己的门户」）")
    return 1


EXAMPLES = """\
常用示例:
  python3 portal_login.py --init                      生成 config.json 模板
  python3 portal_login.py                             登录一次（默认行为）
  python3 portal_login.py --status                    只看现在联网了没有（不登录）
  python3 portal_login.py --watch --interval 15       常驻运行，掉线自动重连
  python3 portal_login.py --debug --capture ./capture 抓取真实请求，用于适配自家门户
  python3 portal_login.py --type srun --portal-url http://10.0.0.2

退出码: 0 = 已联网/登录成功   1 = 登录失败   2 = 配置或网络环境问题
"""


def run_watch(cfg: Dict[str, object], log: Logger) -> int:
    """常驻模式：每隔一段时间检查一次，掉线就自动重连。"""
    interval = max(float(cfg.get("interval") or 30), 3.0)
    log.info("守护模式启动：每 %g 秒检查一次（Ctrl+C 退出）" % interval)
    while True:
        try:
            run_once(cfg, log)
        except KeyboardInterrupt:
            log.info("已退出守护模式")
            return 0
        except Exception as exc:  # 网络环境千奇百怪，单轮异常不该终止守护
            log.error("本轮执行异常: %s" % exc)
        try:
            time.sleep(interval)
        except KeyboardInterrupt:
            log.info("已退出守护模式")
            return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="portal_login.py",
        description="校园网自动登录（网页认证）：Windows / Arch Linux 通用，纯 Python 标准库实现。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=EXAMPLES,
    )
    parser.add_argument("-c", "--config", default=str(DEFAULT_CONFIG_PATH),
                        help="配置文件路径（默认：脚本目录下的 config.json）")
    parser.add_argument("--init", action="store_true", help="生成配置模板后退出")
    parser.add_argument("-u", "--username", help="学号/账号（覆盖配置文件）")
    parser.add_argument("-p", "--password", help="密码（覆盖配置文件；注意会留在命令历史里）")
    parser.add_argument("-t", "--type", choices=["auto", "srun", "drcom", "h3c", "ruijie"],
                        help="认证类型，默认 auto（通用表单自适应）")
    parser.add_argument("--portal-url", help="认证页面地址（覆盖配置文件）")
    parser.add_argument("--password-encoding",
                        help="密码编码：auto|plain|base64|md5|md5-upper|md5-16|sha1|url")
    parser.add_argument("--watch", action="store_true", help="常驻运行，掉线自动重连")
    parser.add_argument("--interval", type=float, help="--watch 的检测间隔秒数")
    parser.add_argument("--status", action="store_true", help="只检测联网状态，不登录")
    parser.add_argument("--probe-url", action="append", default=[], metavar="URL",
                        help="自定义探测地址，可重复使用（特殊校园网/测试用）")
    parser.add_argument("--bind-address", metavar="IP",
                        help="把探测/认证的源地址绑定到该 IPv4（多网卡时用来指定走无线网卡，"
                             "如 --bind-address 10.150.175.108）")
    parser.add_argument("--capture", metavar="DIR", help="把所有 HTTP 请求/响应保存到目录（适配门户用）")
    parser.add_argument("--log", dest="log_file", help="日志文件路径")
    parser.add_argument("-q", "--quiet", action="store_true", help="只在出错时输出（适合放进定时任务）")
    parser.add_argument("--debug", action="store_true", help="输出调试信息")
    parser.add_argument("--version", action="version", version="%(prog)s " + VERSION)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    # Windows 控制台默认可能是 GBK，统一成 UTF-8，避免中文输出报编码错误
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except (AttributeError, OSError, ValueError):
            pass

    args = build_parser().parse_args(argv)
    config_path = Path(args.config).expanduser()

    if args.init:
        write_config_template(config_path)
        print("已生成配置模板: %s" % config_path)
        print("请填写 username / password（type 一般保持 auto）后重新运行。")
        return 0

    try:
        if not config_path.exists():
            write_config_template(config_path)
            print("[!] 没找到配置文件，已生成模板: %s" % config_path, file=sys.stderr)
            print("    请填写 username / password 后再运行。", file=sys.stderr)
            return 2
        cfg = apply_overrides(load_config(config_path), args)
        validate_config(cfg, need_credentials=not args.status)
        if args.capture:
            cfg["_capture_dir"] = args.capture
    except ConfigError as exc:
        print("[ERROR] %s" % exc, file=sys.stderr)
        return 2

    log_path = str(cfg.get("log_file") or "") or default_log_path()
    log = Logger(log_path, quiet=args.quiet, debug=args.debug)
    log.debug("配置文件: %s" % config_path)
    log.debug("日志文件: %s" % log_path)
    try:
        if args.status:
            session = PortalSession(cfg, log, capture_dir=cfg.get("_capture_dir"))  # type: ignore[arg-type]
            state = probe_connectivity(session, cfg, log)
            if state.online:
                log.info("[OK] 当前已联网（%s）" % state.detail)
                return 0
            log.warn("[!] 当前未联网（%s）" % state.detail)
            if state.portal_url:
                log.warn("    认证页面: %s" % state.portal_url)
            return 1
        if args.watch:
            return run_watch(cfg, log)
        return run_once(cfg, log)
    except KeyboardInterrupt:
        log.warn("已被用户取消")
        return 130
    finally:
        log.close()


if __name__ == "__main__":
    sys.exit(main())










