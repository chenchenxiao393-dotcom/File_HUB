#!/bin/bash
# 停止服务（依据 .aiproject/app.pid）
cd "$(dirname "$0")" || exit 1
PIDFILE=".aiproject/app.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  PID=$(cat "$PIDFILE")
  kill "$PID" 2>/dev/null
  for _ in 1 2 3 4 5; do
    kill -0 "$PID" 2>/dev/null || break
    sleep 1
  done
  kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null
  rm -f "$PIDFILE"
  echo "FileHub 已停止 (pid: $PID)"
else
  rm -f "$PIDFILE"
  echo "FileHub 未在运行"
fi
