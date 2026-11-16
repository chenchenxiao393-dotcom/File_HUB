# FileHub · 轻量化文件管理

浏览器端的私有文件空间：宣传页 + 登录鉴权的文件管理台，支持上传、下载、目录树浏览、重命名、删除。支持多用户自助注册、管理员审批，每个用户拥有独立的私有目录与容量上限。

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 后端 | Python 3.12 + Flask 3.0 | 轻量、无 ORM、无数据库，直接操作本地磁盘 |
| WSGI | waitress | 纯 Python 生产级 WSGI，单进程多线程，无编译依赖 |
| 前端 | 原生 HTML/CSS/JS | 无构建步骤、无外部 CDN，页面离线可用 |
| 接入 | Nginx 反向代理 | 由宝塔 AI 项目管理模块生成配置，可通过公网 IP 或自定义域名访问 |

## 访问入口

| 地址 | 说明 |
|---|---|
| `http://<your-server-ip>:85` | 公网 IP + 85 端口（示例，请替换为你的地址） |
| `http://<your-domain>/` | 自定义域名访问（示例，需先完成 DNS 解析） |
|'http://47.93.12.90:85' | 运行中的项目


## 目录结构

```
/www/wwwroot/file_hub/
├── app.py                  # Flask 应用：页面路由 + 文件 API + 鉴权
├── requirements.txt        # flask / waitress
├── start.sh                # 前台启动（面板 start_cmd 调用），日志写 .aiproject/app.log
├── stop.sh                 # 按 .aiproject/app.pid 停止
├── tools/init_auth.py      # 初始化/重置管理员账号（写 instance/auth.json）
├── templates/
│   ├── landing.html        # 宣传页（入口页）
│   ├── login.html          # 登录页
│   ├── register.html       # 注册页（提交后待审批）
│   ├── manager.html        # 文件管理页（资源管理器式布局）
│   └── admin.html          # 用户管理页（仅管理员）
├── static/
│   ├── css/style.css       # 基础样式 + 宣传页 + 登录/注册页
│   ├── css/manager.css     # 管理页 + 用户管理页样式
│   ├── js/manager.js       # 管理页交互：目录树、列表、上传、弹窗
│   └── js/admin.js         # 用户管理页交互
├── storage/                # 用户文件根目录，每人一个子目录
│   └── <用户名>/           # 该用户可见的全部文件（无法越界访问他人目录）
├── instance/
│   ├── auth.json           # 账号表 + 会话密钥（600 权限）
│   └── tmp/               # 文件夹打包 ZIP 的临时文件
├── .venv/                  # 虚拟环境（Python 3.12）
└── .aiproject/
    ├── ai_config.json      # 面板 AI 项目配置
    ├── app.log             # 业务日志
    └── app.pid             # 运行进程号
```

## 运行方式

```bash
cd /www/wwwroot/file_hub
bash start.sh          # 前台启动，监听 127.0.0.1:8010
bash stop.sh           # 停止
```

- 端口：`8010`，仅绑定 `127.0.0.1`，对外统一走 Nginx 反代（`ai_file_hub.conf`）
- 运行用户：`www`
- 环境变量：`HOST`（默认 127.0.0.1）、`PORT`（默认 8010）
- 依赖安装：`.venv/bin/pip install -r requirements.txt`
- 重置管理员：`.venv/bin/python tools/init_auth.py <用户名> <密码>`（同名则重置密码并置为正常，不存在则新建管理员）

## 页面与路由

| 路由 | 说明 |
|---|---|
| `GET /` | 宣传页，含功能介绍与「打开文件管理」入口 |
| `GET /login` / `POST /login` | 登录页，失败 5 次锁定 5 分钟（按 IP）；非 `active` 状态给出对应提示 |
| `GET /register` / `POST /register` | 自助注册，提交后状态为 `pending`（待审批），此时无法登录 |
| `POST /logout` | 退出登录 |
| `GET /app` | 文件管理页，未登录跳转 `/login?next=/app`；仅展示当前用户自己的目录 |
| `GET /admin` | 用户管理页（仅管理员）：审批、禁用/启用、重置密码、调整容量 |
| `POST /api/password` | 修改登录密码（校验旧密码，新密码≥8 位） |

## 用户权限与管理

| 项目 | 说明 |
|---|---|
| 注册 | 用户名 + 密码自助注册；用户名 3-32 位，仅字母数字 `_ . -`；密码≥8 位 |
| 审批 | 管理员在 `/admin` 点「通过」后账号变为 `active`，方可登录 |
| 状态 | `pending` 待审批 / `active` 正常 / `disabled` 已禁用 / `rejected` 已拒绝 |
| 隔离 | 每个用户只能访问 `storage/<用户名>/`，越界路径一律 400；管理员同样看不到他人文件 |
| 容量 | 默认每用户 5GB，管理员可按 GB 调整；上传超限时该文件被拒并提示剩余容量 |
| 禁用 | 立即失效：已登录会话在下一次请求时被清除并跳转登录页 |
| 密码重置 | 管理员生成临时密码（一次性展示），用户登录后自行修改 |
| 删除保护 | 不提供删除账号入口（避免误删文件）；如需清理可禁用账号并手动处理目录 |

> 管理员账号在 `instance/auth.json` 的 `role` 字段为 `admin`，其余为 `user`。

## 文件 API

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/list?path=` | GET | 列出目录内容、面包屑、上级路径、已用容量 |
| `/api/tree?path=` | GET | 目录树懒加载：直属子目录 |
| `/api/upload?path=` | POST | 多文件上传（字段名 `files`），重名自动追加 ` (1)`，超出容量上限的文件单独报错 |
| `/api/download?path=` | GET | 文件直接下载；目录按需打包 ZIP |
| `/api/mkdir` | POST | 新建文件夹 `{path, name}` |
| `/api/rename` | POST | 重命名 `{path, name}` |
| `/api/delete` | POST | 批量删除 `{paths: []}` |
| `/api/admin/user` | POST | 管理员操作 `{action: approve\|reject\|disable\|enable\|quota\|reset, username, quota_gb}` |

## 关键业务流程

1. **访问控制**：所有 `/api/*` 与 `/app` 经 `login_required` 校验 session，并实时校验账号状态；未登录返回 401（接口）或 302（页面），被禁用/拒绝则清空会话。
2. **管理员校验**：`/admin` 与 `/api/admin/user` 额外经 `admin_required` 校验 `role=admin`。
3. **CSRF 防护**：非 GET 请求必须携带 `X-CSRF-Token`（或表单字段 `csrf_token`），值取自 session；登录、注册除外。
4. **路径安全**：`abs_path()` 以 `storage/<当前用户名>/` 为根解析并 `resolve()`，越界或符号链接逃逸一律 400；文件名过滤 `\ / : * ? " < > |` 与控制字符。
5. **上传**：`request.files.getlist("files")` 逐个落盘，单次请求上限 2GB（Flask `MAX_CONTENT_LENGTH` + waitress `max_request_body_size`）；落盘前按「已用 + 文件大小 > 配额」拒绝。
6. **下载**：文件用 `send_file` 流式输出；目录用 `zipfile` 写入 `instance/tmp` 临时文件，响应结束即删除。
7. **前端交互**：目录树懒加载并高亮当前路径；列表支持单击/多选/Shift 连选、双击进目录或下载、列排序、目录内筛选、拖拽上传与 XHR 进度条。

## 安全建议

- `instance/auth.json` 保存密码哈希与会话密钥，务必保持 `600` 且不对外暴露；Nginx 已拦截项目内 `.aiproject/`（`.venv`、`instance` 不在静态托管路径下）。
- 首次部署后请登录并在界面「修改密码」处更换初始密码。
- 如需 HTTPS，可在面板为该站点申请 Let's Encrypt 证书。

## 依赖

- Python 3.12（venv）
- flask 3.0.3、waitress 3.0.0
- Nginx 1.30（由面板生成反代配置）
