"""初始化/重置管理员账号：维护 instance/auth.json（多用户结构 + 会话密钥）。

用法：
    .venv/bin/python tools/init_auth.py <用户名> <密码>

已有文件时：
- 若为旧版单账号结构，自动迁移为多用户；
- 同名账号存在则重置其密码并置为正常状态；
- 不存在则新增一个管理员账号。
"""

import json
import secrets
import sys
from datetime import datetime
from pathlib import Path

from werkzeug.security import generate_password_hash

BASE_DIR = Path(__file__).resolve().parent.parent
AUTH_FILE = BASE_DIR / "instance" / "auth.json"
DEFAULT_QUOTA = 5 * 1024 * 1024 * 1024


def main():
    if len(sys.argv) != 3:
        print("用法: python tools/init_auth.py <用户名> <密码>")
        return 1
    username, password = sys.argv[1].strip(), sys.argv[2]
    if not username or len(password) < 8:
        print("用户名不能为空，密码至少 8 位")
        return 1

    AUTH_FILE.parent.mkdir(parents=True, exist_ok=True)
    data = {}
    if AUTH_FILE.exists():
        try:
            data = json.loads(AUTH_FILE.read_text("utf-8"))
        except ValueError:
            data = {}

    if "users" not in data:
        users = {}
        if data.get("username") and data.get("password_hash"):
            users[data["username"]] = {
                "password_hash": data["password_hash"],
                "role": "admin",
                "status": "active",
                "quota": DEFAULT_QUOTA,
                "created": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            }
        data = {"secret": data.get("secret") or secrets.token_hex(32), "users": users}

    record = data["users"].get(username)
    if record:
        record["password_hash"] = generate_password_hash(password)
        record["status"] = "active"
        record.setdefault("role", "admin")
        action = "密码已重置"
    else:
        data["users"][username] = {
            "password_hash": generate_password_hash(password),
            "role": "admin",
            "status": "active",
            "quota": DEFAULT_QUOTA,
            "created": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        action = "账号已创建（管理员）"

    AUTH_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=4), "utf-8")
    AUTH_FILE.chmod(0o600)
    (BASE_DIR / "storage" / username).mkdir(parents=True, exist_ok=True)
    print(f"{action}：{username}（{AUTH_FILE}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())