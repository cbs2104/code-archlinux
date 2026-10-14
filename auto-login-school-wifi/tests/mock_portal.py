#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地「模拟校园网门户」，用于端到端自测 portal_login.py（不会访问真实网络）。

特性（尽量贴近真实门户）：
  * 未登录时把探测请求 302 跳转到认证页面（使用相对 Location，顺便测试 URL 解析）；
  * 认证页面用 GB2312 编码（国内门户常见），并带隐藏字段 token / wlanuserip / wlanacname；
  * POST 必须带正确的隐藏字段 token，否则失败（用来验证隐藏字段有没有被保留）；
  * 额外兼容深澜 /eportal/portal/login 接口（base64 密码 + JSONP），可测试 srun 模式。

单独手动使用：

    python3 tests/mock_portal.py --port 18080
    python3 portal_login.py --probe-url http://127.0.0.1:18080/generate_204 --config my.json
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = "T0KEN-abc123"
DEFAULT_USERNAME = "20240001"
DEFAULT_PASSWORD = "test-pass"

# 登录状态（自测脚本可直接修改这个字典来重置状态）
STATE = {"authed": False, "logins": 0}

LOGIN_HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="gb2312"><title>校园网认证（模拟）</title></head>
<body>
<h2>校园网认证系统（模拟门户）</h2>
<p>{message}</p>
<form name="loginform" method="post" action="/portal/login">
  <input type="hidden" name="token" value="{token}">
  <input type="hidden" name="wlanuserip" value="{ip}">
  <input type="hidden" name="wlanacname" value="AC-1">
  <label>学号 <input type="text" name="username" value="" size="24"></label><br>
  <label>密码 <input type="password" name="password" value="" size="24"></label><br>
  <label><input type="checkbox" name="remember" value="1">记住我</label><br>
  <input type="submit" name="login" value="登录">
</form>
</body></html>
"""

SUCCESS_HTML = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="gb2312"><title>认证成功</title></head>
<body><h2>登录成功</h2><p>认证成功，正在打开网络……</p>
<script>window.location.href = "http://www.example.com/";</script>
</body></html>
"""


def build_handler(username: str, password: str):
    """生成绑定了正确账号密码的请求处理器。"""

    class MockPortalHandler(BaseHTTPRequestHandler):
        server_version = "MockPortal/1.0"
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # 静默，避免污染测试输出
            pass

        # ---------- 内部小工具 ----------
        def _send(self, status, body=b"", content_type="text/html; charset=gb2312", extra_headers=None):
            self.send_response(status)
            if body:
                self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            for key, value in (extra_headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            if body:
                self.wfile.write(body)

        def _login_page(self, message=""):
            ip = self.client_address[0]
            return LOGIN_HTML.format(message=message, token=TOKEN, ip=ip).encode("gb2312", "replace")

        def _redirect_to_portal(self):
            target = "/portal/login?wlanuserip=%s&wlanacname=AC-1" % urllib.parse.quote(self.client_address[0])
            self.send_response(302)
            self.send_header("Location", target)
            self.send_header("Content-Length", "0")
            self.end_headers()

    return MockPortalHandler


def _query_handler(handler_cls, mode):
    """给 MockPortalHandler 挂上 do_GET / do_POST（放在 build_handler 外面以保持可读性）。"""

    if mode == "get":
        def do_GET(self):  # noqa: N802
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            query = urllib.parse.parse_qs(parsed.query)

            if path == "/generate_204":
                if STATE["authed"]:
                    self.send_response(204)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                else:
                    self._redirect_to_portal()
                return

            if path == "/portal/login":
                self._send(200, self._login_page())
                return

            if path == "/eportal/portal/login":
                account = (query.get("user_account") or [""])[0]
                encoded = (query.get("user_password") or [""])[0]
                try:
                    plain = base64.b64decode(encoded).decode("utf-8")
                except Exception:
                    plain = ""
                if account == self.server.username and plain == self.server.password:
                    STATE["authed"] = True
                    STATE["logins"] += 1
                    payload = {"result": 1, "msg": "登录成功", "ret_code": 0}
                else:
                    payload = {"result": 0, "msg": "账号或密码错误", "ret_code": 1}
                body = ("dr1004(" + json.dumps(payload, ensure_ascii=False) + ")").encode("utf-8")
                self._send(200, body, "application/javascript; charset=utf-8")
                return

            if path == "/status":
                body = json.dumps({"authed": STATE["authed"], "logins": STATE["logins"]}).encode()
                self._send(200, body, "application/json")
                return

            self._send(404, b"not found")

        handler_cls.do_GET = do_GET
    else:
        def do_POST(self):  # noqa: N802
            parsed = urllib.parse.urlparse(self.path)
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length).decode("utf-8", "replace")
            form = {k: v[0] for k, v in urllib.parse.parse_qs(raw, keep_blank_values=True).items()}

            if parsed.path != "/portal/login":
                self._send(404, b"not found")
                return
            if form.get("token") != TOKEN:
                # 隐藏字段没被带上 -> 明确失败，便于自测发现问题
                self._send(200, self._login_page("会话已过期，请重新登录"))
                return
            if form.get("username") == self.server.username and form.get("password") == self.server.password:
                STATE["authed"] = True
                STATE["logins"] += 1
                self._send(200, SUCCESS_HTML.encode("gb2312", "replace"),
                           "text/html; charset=gb2312", {"Set-Cookie": "portal_session=ok; Path=/"})
            else:
                self._send(200, self._login_page("用户名或密码错误"))

        handler_cls.do_POST = do_POST


def make_server(port: int = 0, username: str = DEFAULT_USERNAME, password: str = DEFAULT_PASSWORD):
    """创建并返回 ThreadingHTTPServer（port=0 时由系统分配端口）。"""
    handler = build_handler(username, password)
    _query_handler(handler, "get")
    _query_handler(handler, "post")
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.username = username  # type: ignore[attr-defined]
    server.password = password  # type: ignore[attr-defined]
    server.daemon_threads = True
    return server


def main() -> int:
    parser = argparse.ArgumentParser(description="本地模拟校园网门户（仅用于测试）")
    parser.add_argument("--port", type=int, default=18080)
    parser.add_argument("--username", default=DEFAULT_USERNAME)
    parser.add_argument("--password", default=DEFAULT_PASSWORD)
    args = parser.parse_args()

    server = make_server(args.port, args.username, args.password)
    url = "http://127.0.0.1:%d" % server.server_address[1]
    print("模拟门户已启动: %s" % url)
    print("  探测地址 : %s/generate_204" % url)
    print("  认证页面 : %s/portal/login" % url)
    print("  测试账号 : %s / %s" % (args.username, args.password))
    print("按 Ctrl+C 退出")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

