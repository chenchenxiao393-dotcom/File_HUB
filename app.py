"""FileHub —— 轻量化文件管理服务（Flask + 本地磁盘存储）。"""

import io
import json
import os
import re
import secrets
import shutil
import tempfile
import time
import zipfile
from datetime import datetime
from functools import wraps
from pathlib import Path

from flask import (
    Flask,
    abort,
    after_this_request,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    session,
    url_for,
)
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = Path(__file__).resolve().parent
STORAGE_DIR = BASE_DIR / "storage"
INSTANCE_DIR = BASE_DIR / "instance"
AUTH_FILE = INSTANCE_DIR / "auth.json"

MAX_UPLOAD_SIZE = 2 * 1024 * 1024 * 1024  # 单次请求 2GB
DEFAULT_QUOTA = 5 * 1024 * 1024 * 1024  # 每用户默认容量 5GB
ALLOWED_INVALID_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")
LOGIN_MAX_FAILS = 5
LOGIN_LOCK_SECONDS = 300
STATUS_TEXT = {"pending": "待审批", "active": "正常", "disabled": "已禁用", "rejected": "已拒绝"}

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_SIZE
app.config["JSON_AS_ASCII"] = False

_login_fails = {}  # ip -> [fail_count, first_fail_ts]


# --------------------------------------------------------------------------
# 账号配置（users: {用户名: {password_hash, role, status, quota, created}}）
# 状态：pending 待审批 / active 正常 / disabled 已禁用 / rejected 已拒绝
# --------------------------------------------------------------------------
def load_auth():
    if not AUTH_FILE.exists():
        raise RuntimeError(
            "缺少 instance/auth.json，请先执行: python tools/init_auth.py <管理员用户名> <密码>"
        )
    data = json.loads(AUTH_FILE.read_text("utf-8"))
    if "users" not in data:
        # 兼容旧版单账号结构：自动迁移为管理员账号
        data = {
            "secret": data["secret"],
            "users": {
                data["username"]: {
                    "password_hash": data["password_hash"],
                    "role": "admin",
                    "status": "active",
                    "quota": DEFAULT_QUOTA,
                    "created": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                }
            },
        }
        save_auth(data)
    return data


def save_auth(data):
    AUTH_FILE.parent.mkdir(parents=True, exist_ok=True)
    AUTH_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=4), "utf-8")
    os.chmod(AUTH_FILE, 0o600)


def get_user(username):
    if not username:
        return None
    return load_auth()["users"].get(username)


def init_app():
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    INSTANCE_DIR.mkdir(parents=True, exist_ok=True)
    auth = load_auth()
    app.secret_key = auth["secret"]


# --------------------------------------------------------------------------
# 存储根目录：每个用户一个私有根 storage/<用户名>
# --------------------------------------------------------------------------
def user_root(username):
    root = STORAGE_DIR / username
    root.mkdir(parents=True, exist_ok=True)
    return root


def current_root():
    return user_root(session.get("user"))


def dir_usage(path):
    total = 0
    if not path.exists():
        return 0
    for cur, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += (Path(cur) / name).lstat().st_size
            except OSError:
                continue
    return total


def fmt_size(num):
    val = float(num)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if val < 1024 or unit == "TB":
            return f"{val:.0f} {unit}" if unit == "B" else f"{val:.1f} {unit}"
        val /= 1024
    return f"{val:.1f} TB"


# --------------------------------------------------------------------------
# 路径与文件名安全
# --------------------------------------------------------------------------
def abs_path(rel):
    """把前端传来的相对路径解析为当前用户根目录内的绝对路径，越界则拒绝。"""
    rel = (rel or "").replace("\\", "/").strip().lstrip("/")
    root = current_root().resolve()
    target = (root / rel).resolve()
    if target != root and root not in target.parents:
        abort(400, "非法路径")
    return target


def rel_of(path):
    rel = path.relative_to(current_root().resolve()).as_posix()
    return "" if rel == "." else rel


def check_name(name):
    if not name or name in (".", "..") or len(name) > 255:
        abort(400, "名称不合法")
    if ALLOWED_INVALID_NAME.search(name):
        abort(400, "名称包含非法字符")
    return name


def unique_path(parent, name):
    """同名冲突时自动追加 (1)、(2)…，行为对齐 Windows 资源管理器。"""
    candidate = parent / name
    if not candidate.exists():
        return candidate
    stem, suffix = os.path.splitext(name)
    if not stem:
        stem, suffix = name, ""
    for i in range(1, 1000):
        candidate = parent / f"{stem} ({i}){suffix}"
        if not candidate.exists():
            return candidate
    abort(400, "同名文件过多")


# --------------------------------------------------------------------------
# 鉴权
# --------------------------------------------------------------------------
def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        user = get_user(session.get("user"))
        if not user or user.get("status") != "active":
            session.clear()
            if request.path.startswith("/api/"):
                return jsonify(ok=False, error="未登录或会话已过期", code="auth"), 401
            return redirect(url_for("login", next=request.path))
        return view(*args, **kwargs)

    return wrapper


def admin_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        user = get_user(session.get("user"))
        if not user or user.get("role") != "admin" or user.get("status") != "active":
            if request.path.startswith("/api/"):
                return jsonify(ok=False, error="需要管理员权限"), 403
            return redirect(url_for("manager"))
        return view(*args, **kwargs)

    return wrapper


@app.before_request
def csrf_guard():
    if request.method in ("GET", "HEAD", "OPTIONS") or request.endpoint in ("login", "register"):
        return
    token = session.get("csrf")
    provided = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token")
    if not token or not provided or token != provided:
        return jsonify(ok=False, error="会话校验失败，请刷新页面重试", code="csrf"), 403


@app.context_processor
def inject_globals():
    if not session.get("csrf"):
        session["csrf"] = secrets.token_urlsafe(24)
    return {"csrf_token": session["csrf"], "app_name": "FileHub"}


# --------------------------------------------------------------------------
# 页面
# --------------------------------------------------------------------------
@app.route("/")
def landing():
    return render_template("landing.html")


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "GET":
        if session.get("user"):
            return redirect(url_for("manager"))
        return render_template("login.html", error=None)

    ip = request.headers.get("X-Real-IP") or request.remote_addr or "-"
    fails, first_ts = _login_fails.get(ip, (0, 0))
    if fails >= LOGIN_MAX_FAILS and time.time() - first_ts < LOGIN_LOCK_SECONDS:
        left = int(LOGIN_LOCK_SECONDS - (time.time() - first_ts))
        return render_template("login.html", error=f"尝试次数过多，请 {left} 秒后再试"), 429

    username = (request.form.get("username") or "").strip()
    password = request.form.get("password") or ""
    record = load_auth()["users"].get(username)
    if record and check_password_hash(record["password_hash"], password):
        status = record.get("status", "pending")
        if status != "active":
            msg = {
                "pending": "账号待管理员审批，审批通过后即可登录",
                "rejected": "注册申请未通过，如有疑问请联系管理员",
                "disabled": "账号已被禁用，请联系管理员",
            }.get(status, "账号状态异常，请联系管理员")
            return render_template("login.html", error=msg), 403
        _login_fails.pop(ip, None)
        session.clear()
        session.permanent = True
        session["user"] = username
        session["csrf"] = secrets.token_urlsafe(24)
        target = request.args.get("next") or url_for("manager")
        if not target.startswith("/") or target.startswith("//"):
            target = url_for("manager")
        return redirect(target)

    _login_fails[ip] = (fails + 1, first_ts or time.time())
    return render_template("login.html", error="用户名或密码错误"), 401


@app.route("/register", methods=["GET", "POST"])
def register():
    if request.method == "GET":
        if session.get("user"):
            return redirect(url_for("manager"))
        return render_template("register.html", error=None, form={}, success=False)

    def fail(msg):
        return render_template("register.html", error=msg, form=form_keep, success=False), 400

    username = (request.form.get("username") or "").strip()
    password = request.form.get("password") or ""
    confirm = request.form.get("confirm") or ""
    form_keep = {"username": username}

    if not USERNAME_RE.match(username):
        return fail("用户名需 3-32 位，仅限字母、数字、下划线、点和短横线")
    if len(password) < 8:
        return fail("密码至少 8 位")
    if password != confirm:
        return fail("两次输入的密码不一致")

    auth = load_auth()
    if any(name.lower() == username.lower() for name in auth["users"]):
        return fail("用户名已被占用")

    auth["users"][username] = {
        "password_hash": generate_password_hash(password),
        "role": "user",
        "status": "pending",
        "quota": DEFAULT_QUOTA,
        "created": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    save_auth(auth)
    user_root(username)
    return render_template("register.html", error=None, form={}, success=True, username=username)


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return redirect(url_for("landing"))


@app.route("/app")
@login_required
def manager():
    record = get_user(session.get("user")) or {}
    used = dir_usage(current_root())
    quota = int(record.get("quota") or DEFAULT_QUOTA)
    return render_template(
        "manager.html",
        username=session.get("user"),
        is_admin=record.get("role") == "admin",
        usage_text=f"{fmt_size(used)} / {fmt_size(quota)}",
    )


@app.route("/admin")
@login_required
@admin_required
def admin_users():
    auth = load_auth()
    users = []
    for name, rec in auth["users"].items():
        users.append(
            {
                "username": name,
                "role": rec.get("role", "user"),
                "status": rec.get("status", "pending"),
                "status_text": STATUS_TEXT.get(rec.get("status", "pending"), "未知"),
                "quota": int(rec.get("quota") or DEFAULT_QUOTA),
                "used": dir_usage(STORAGE_DIR / name),
                "created": rec.get("created", ""),
            }
        )
    users.sort(key=lambda u: (u["status"] != "pending", u["username"].lower()))
    return render_template(
        "admin.html",
        users=users,
        username=session.get("user"),
        fmt_size=fmt_size,
    )


@app.post("/api/admin/user")
@login_required
@admin_required
def admin_user_action():
    data = request.get_json(silent=True) or {}
    action = (data.get("action") or "").strip()
    username = (data.get("username") or "").strip()
    auth = load_auth()
    record = auth["users"].get(username)
    if not record:
        return jsonify(ok=False, error="用户不存在"), 404

    if action in ("disable", "reject") and username == session.get("user"):
        return jsonify(ok=False, error="不能对自己的账号执行该操作"), 400

    if action == "approve":
        record["status"] = "active"
        msg = f"已通过 {username} 的注册申请"
    elif action == "reject":
        record["status"] = "rejected"
        msg = f"已拒绝 {username} 的注册申请"
    elif action == "disable":
        record["status"] = "disabled"
        msg = f"已禁用 {username}"
    elif action == "enable":
        record["status"] = "active"
        msg = f"已启用 {username}"
    elif action == "quota":
        try:
            gb = float(data.get("quota_gb"))
        except (TypeError, ValueError):
            return jsonify(ok=False, error="容量需为数字（GB）"), 400
        if gb <= 0 or gb > 10240:
            return jsonify(ok=False, error="容量需在 0.1 ~ 10240 GB 之间"), 400
        record["quota"] = int(gb * 1024 * 1024 * 1024)
        msg = f"已将 {username} 的容量上限设为 {gb:g} GB"
    elif action == "reset":
        new_password = secrets.token_urlsafe(9)
        record["password_hash"] = generate_password_hash(new_password)
        save_auth(auth)
        return jsonify(ok=True, msg=f"已重置 {username} 的密码", password=new_password)
    else:
        return jsonify(ok=False, error="未知操作"), 400

    save_auth(auth)
    return jsonify(ok=True, msg=msg)


@app.route("/api/password", methods=["POST"])
@login_required
def change_password():
    data = request.get_json(silent=True) or {}
    old = data.get("old_password") or ""
    new = data.get("new_password") or ""
    if len(new) < 8:
        return jsonify(ok=False, error="新密码至少 8 位"), 400
    auth = load_auth()
    record = auth["users"].get(session.get("user"))
    if not record:
        return jsonify(ok=False, error="账号不存在"), 404
    if not check_password_hash(record["password_hash"], old):
        return jsonify(ok=False, error="当前密码不正确"), 400
    record["password_hash"] = generate_password_hash(new)
    save_auth(auth)
    return jsonify(ok=True, msg="密码已更新")


# --------------------------------------------------------------------------
# 文件 API
# --------------------------------------------------------------------------
def describe(path):
    st = path.stat()
    is_dir = path.is_dir()
    return {
        "name": path.name,
        "path": rel_of(path),
        "type": "dir" if is_dir else "file",
        "size": 0 if is_dir else st.st_size,
        "mtime": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
        "ext": "" if is_dir else path.suffix.lower().lstrip("."),
    }


def breadcrumbs(target):
    root = current_root().resolve()
    items = [{"name": "根目录", "path": ""}]
    if target == root:
        return items
    acc = ""
    for part in target.relative_to(root).parts:
        acc = f"{acc}/{part}" if acc else part
        items.append({"name": part, "path": acc})
    return items


@app.get("/api/list")
@login_required
def api_list():
    target = abs_path(request.args.get("path"))
    if not target.exists():
        return jsonify(ok=False, error="目录不存在"), 404
    if not target.is_dir():
        return jsonify(ok=False, error="目标不是目录"), 400
    entries = []
    for child in target.iterdir():
        try:
            entries.append(describe(child))
        except OSError:
            continue
    entries.sort(key=lambda e: (e["type"] != "dir", e["name"].lower()))
    record = get_user(session.get("user")) or {}
    quota = int(record.get("quota") or DEFAULT_QUOTA)
    return jsonify(
        ok=True,
        path=rel_of(target),
        breadcrumbs=breadcrumbs(target),
        entries=entries,
        parent=None if target == current_root().resolve() else rel_of(target.parent),
        usage_text=f"{fmt_size(dir_usage(current_root()))} / {fmt_size(quota)}",
    )


@app.get("/api/tree")
@login_required
def api_tree():
    """侧边栏按需展开：返回指定目录的直属子目录。"""
    target = abs_path(request.args.get("path"))
    if not target.is_dir():
        return jsonify(ok=False, error="目录不存在"), 404
    dirs = []
    try:
        for child in target.iterdir():
            if child.is_dir():
                dirs.append({"name": child.name, "path": rel_of(child)})
    except OSError:
        pass
    dirs.sort(key=lambda d: d["name"].lower())
    return jsonify(ok=True, dirs=dirs)


@app.post("/api/upload")
@login_required
def api_upload():
    target = abs_path(request.args.get("path"))
    if not target.is_dir():
        return jsonify(ok=False, error="目标目录不存在"), 404
    files = request.files.getlist("files")
    if not files:
        return jsonify(ok=False, error="未选择文件"), 400
    record = get_user(session.get("user")) or {}
    quota = int(record.get("quota") or DEFAULT_QUOTA)
    used = dir_usage(current_root())
    saved, failed = [], []
    for item in files:
        raw = os.path.basename((item.filename or "").replace("\\", "/"))
        try:
            name = check_name(raw)
        except Exception:
            failed.append({"name": raw, "error": "文件名不合法"})
            continue
        try:
            item.stream.seek(0, os.SEEK_END)
            size = item.stream.tell()
            item.stream.seek(0)
        except OSError:
            size = 0
        if used + size > quota:
            failed.append(
                {"name": name, "error": f"超出容量上限，剩余 {fmt_size(max(quota - used, 0))}"}
            )
            continue
        dest = unique_path(target, name)
        try:
            item.save(dest)
            actual = dest.stat().st_size
            used += actual
            saved.append({"name": dest.name, "size": actual})
        except OSError as exc:
            failed.append({"name": name, "error": str(exc)})
    return jsonify(
        ok=bool(saved),
        saved=saved,
        failed=failed,
        used_quota_text=f"{fmt_size(used)} / {fmt_size(quota)}",
    )


@app.get("/api/download")
@login_required
def api_download():
    target = abs_path(request.args.get("path"))
    if not target.exists():
        return jsonify(ok=False, error="文件不存在"), 404
    if target.is_dir():
        return _send_zip(target)
    return send_file(target, as_attachment=True, download_name=target.name)


def _send_zip(folder):
    tmp_dir = INSTANCE_DIR / "tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(suffix=".zip", dir=tmp_dir)
    os.close(fd)
    with zipfile.ZipFile(tmp_name, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(folder):
            root_path = Path(root)
            for name in dirs:
                zf.write(root_path / name, (root_path / name).relative_to(folder).as_posix() + "/")
            for name in files:
                src = root_path / name
                try:
                    zf.write(src, src.relative_to(folder).as_posix())
                except OSError:
                    continue

    @after_this_request
    def cleanup(response):
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        return response

    return send_file(
        tmp_name,
        mimetype="application/zip",
        as_attachment=True,
        download_name=f"{folder.name or 'root'}.zip",
    )


@app.post("/api/mkdir")
@login_required
def api_mkdir():
    data = request.get_json(silent=True) or {}
    parent = abs_path(data.get("path"))
    name = check_name((data.get("name") or "").strip())
    if not parent.is_dir():
        return jsonify(ok=False, error="目标目录不存在"), 404
    dest = parent / name
    if dest.exists():
        return jsonify(ok=False, error="同名文件或文件夹已存在"), 400
    dest.mkdir()
    return jsonify(ok=True, entry=describe(dest))


@app.post("/api/rename")
@login_required
def api_rename():
    data = request.get_json(silent=True) or {}
    src = abs_path(data.get("path"))
    name = check_name((data.get("name") or "").strip())
    if not src.exists():
        return jsonify(ok=False, error="文件不存在"), 404
    if src.name == name:
        return jsonify(ok=True, entry=describe(src))
    dest = src.parent / name
    if dest.exists():
        return jsonify(ok=False, error="同名文件或文件夹已存在"), 400
    src.rename(dest)
    return jsonify(ok=True, entry=describe(dest))


@app.post("/api/delete")
@login_required
def api_delete():
    data = request.get_json(silent=True) or {}
    paths = data.get("paths") or []
    if not isinstance(paths, list) or not paths:
        return jsonify(ok=False, error="未选择文件"), 400
    deleted, failed = [], []
    for rel in paths:
        target = abs_path(rel)
        if target == current_root().resolve() or not target.exists():
            failed.append({"path": rel, "error": "目标不存在或不可删除"})
            continue
        try:
            if target.is_dir() and not target.is_symlink():
                shutil.rmtree(target)
            else:
                target.unlink()
            deleted.append(rel)
        except OSError as exc:
            failed.append({"path": rel, "error": str(exc)})
    return jsonify(ok=bool(deleted), deleted=deleted, failed=failed)


# --------------------------------------------------------------------------
# 错误处理
# --------------------------------------------------------------------------
@app.errorhandler(400)
def bad_request(err):
    msg = getattr(err, "description", "请求不合法")
    if request.path.startswith("/api/"):
        return jsonify(ok=False, error=msg), 400
    return msg, 400


@app.errorhandler(413)
def too_large(err):
    if request.path.startswith("/api/"):
        return jsonify(ok=False, error="文件过大，单次上传上限 2GB"), 413
    return "文件过大", 413


@app.errorhandler(404)
def not_found(err):
    if request.path.startswith("/api/"):
        return jsonify(ok=False, error="资源不存在"), 404
    return render_template("landing.html"), 404


init_app()


if __name__ == "__main__":
    import atexit

    from waitress import serve

    pid_file = BASE_DIR / ".aiproject" / "app.pid"
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    pid_file.write_text(str(os.getpid()), "utf-8")
    atexit.register(lambda: pid_file.unlink(missing_ok=True))

    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8010"))
    serve(app, host=host, port=port, threads=8, max_request_body_size=MAX_UPLOAD_SIZE)
