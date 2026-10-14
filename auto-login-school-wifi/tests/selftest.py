#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""端到端自测：启动本地「模拟校园网门户」，验证 portal_login.py 的完整流程。

用法::

    python3 tests/selftest.py

全部通过退出码为 0，否则为 1。整个过程只访问 127.0.0.1，不会碰真实校园网。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mock_portal  # noqa: E402  （同级目录）

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "portal_login.py"
USERNAME = mock_portal.DEFAULT_USERNAME
PASSWORD = mock_portal.DEFAULT_PASSWORD

PASSED: list = []
FAILED: list = []


def check(name: str, ok: bool, detail: str = "") -> None:
    (PASSED if ok else FAILED).append(name)
    print("  %s %s%s" % ("[PASS]" if ok else "[FAIL]", name, ("  -> " + detail) if detail else ""))


def last_line(text: str) -> str:
    lines = [ln for ln in (text or "").strip().splitlines() if ln.strip()]
    return lines[-1] if lines else ""


def run_login(args, env=None, timeout=90):
    env2 = dict(os.environ)
    env2["PYTHONIOENCODING"] = "utf-8"
    if env:
        env2.update(env)
    return subprocess.run([sys.executable, str(SCRIPT)] + args,
                          capture_output=True, text=True, env=env2, timeout=timeout)


def main() -> int:
    if not SCRIPT.exists():
        print("找不到 %s" % SCRIPT)
        return 1

    server = mock_portal.make_server(0, USERNAME, PASSWORD)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    probe = "http://127.0.0.1:%d/generate_204" % port
    print("模拟门户: http://127.0.0.1:%d" % port)
    print("被测脚本: %s" % SCRIPT)

    with tempfile.TemporaryDirectory() as tmp_name:
        tmp = Path(tmp_name)
        log_file = tmp / "selftest.log"
        base_cfg = {
            "username": USERNAME,
            "password": PASSWORD,
            "type": "auto",
            "probe_urls": [{"url": probe, "expect": "204"}],
            "timeout": 5,
            "verify_interval": 0.2,
            "log_file": str(log_file),
        }
        cfg_ok = tmp / "config-ok.json"
        cfg_ok.write_text(json.dumps(base_cfg, ensure_ascii=False), encoding="utf-8")

        cfg_bad = tmp / "config-bad.json"
        bad = dict(base_cfg)
        bad["password"] = "wrong-password"
        cfg_bad.write_text(json.dumps(bad, ensure_ascii=False), encoding="utf-8")

        cfg_srun = tmp / "config-srun.json"
        srun = dict(base_cfg)
        srun["type"] = "srun"
        srun["portal_url"] = "http://127.0.0.1:%d" % port
        cfg_srun.write_text(json.dumps(srun, ensure_ascii=False), encoding="utf-8")

        cfg_drcom = tmp / "config-drcom.json"
        drcom = dict(base_cfg)
        drcom["type"] = "drcom"
        cfg_drcom.write_text(json.dumps(drcom, ensure_ascii=False), encoding="utf-8")

        print("\n[1/8] --init 生成配置模板")
        cfg_init = tmp / "config-init.json"
        proc = run_login(["--config", str(cfg_init), "--init"])
        check("--init 生成配置模板并返回 0", proc.returncode == 0 and cfg_init.exists(), last_line(proc.stdout))

        print("\n[2/8] 未登录时 --status 应返回 1")
        mock_portal.STATE["authed"] = False
        proc = run_login(["--config", str(cfg_ok), "--status"])
        check("--status 未登录返回 1", proc.returncode == 1, last_line(proc.stdout))

        print("\n[3/8] 通用表单自适应：正确账号密码登录")
        mock_portal.STATE["authed"] = False
        mock_portal.STATE["logins"] = 0
        proc = run_login(["--config", str(cfg_ok), "--debug"])
        check("登录成功返回 0", proc.returncode == 0, last_line(proc.stdout))
        check("门户侧确实收到登录请求", mock_portal.STATE["logins"] == 1)
        check("隐藏字段 token 被完整提交（否则门户会报会话过期）", mock_portal.STATE["authed"] is True)

        print("\n[4/8] 已登录时 --status 应返回 0，且不重复登录")
        proc = run_login(["--config", str(cfg_ok), "--status"])
        check("--status 已登录返回 0", proc.returncode == 0, last_line(proc.stdout))
        proc = run_login(["--config", str(cfg_ok)])
        check("已联网时直接跳过登录", proc.returncode == 0 and mock_portal.STATE["logins"] == 1,
              last_line(proc.stdout))

        print("\n[5/8] 密码错误时应返回 1 且不会误判为已联网")
        mock_portal.STATE["authed"] = False
        proc = run_login(["--config", str(cfg_bad)])
        check("错误密码返回 1", proc.returncode == 1, last_line(proc.stdout))
        check("错误密码不会把门户状态改成已登录", mock_portal.STATE["authed"] is False)

        print("\n[6/8] 深澜 srun 模式（base64 密码 + JSONP 接口）")
        mock_portal.STATE["authed"] = False
        proc = run_login(["--config", str(cfg_srun)])
        check("srun 模式登录成功", proc.returncode == 0 and mock_portal.STATE["authed"], last_line(proc.stdout))

        print("\n[7/8] drcom 预设（预设字段名不存在时回退到自动识别）")
        mock_portal.STATE["authed"] = False
        proc = run_login(["--config", str(cfg_drcom)])
        check("预设 + 自动识别仍能登录", proc.returncode == 0 and mock_portal.STATE["authed"],
              last_line(proc.stdout))

        print("\n[8/8] --capture 抓包 / 日志文件")
        mock_portal.STATE["authed"] = False
        cap = tmp / "capture"
        proc = run_login(["--config", str(cfg_ok), "--capture", str(cap)])
        files = sorted(cap.glob("*.txt")) if cap.exists() else []
        check("--capture 生成了抓包文件", len(files) >= 3, "%d 个文件" % len(files))
        check("日志文件被写入", log_file.exists() and log_file.stat().st_size > 0)

        print("\n" + "=" * 62)
        print("结果：通过 %d 项，失败 %d 项" % (len(PASSED), len(FAILED)))
        for name in FAILED:
            print("  [FAIL] %s" % name)

    server.shutdown()
    server.server_close()
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())

