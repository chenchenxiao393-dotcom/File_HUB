#!/bin/bash
# 前台启动服务（供面板调用，日志写入 .aiproject/app.log）
cd "$(dirname "$0")" || exit 1
mkdir -p .aiproject storage instance
exec .venv/bin/python -u app.py >> .aiproject/app.log 2>&1
