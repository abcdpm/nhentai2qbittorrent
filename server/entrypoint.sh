#!/bin/sh
# 容器入口：支持 PUID / PGID 指定文件归属（linuxserver.io 风格）
#   docker run -e PUID=1000 -e PGID=100 ...
# 以 root 启动时：把内置 node 用户/组调整为 PUID/PGID，修正数据卷归属后降权运行；
# 以非 root（--user）启动时：直接运行。
set -e

PUID=${PUID:-1000}
PGID=${PGID:-100}

if [ "$(id -u)" = "0" ]; then
    # -o 允许与现有 uid/gid 重复（如 PGID=100 对应宿主机 users 组）
    groupmod -o -g "$PGID" node 2>/dev/null || true
    usermod  -o -u "$PUID" -g "$PGID" node 2>/dev/null || true

    mkdir -p /app/data /app/downloads
    chown -R "$PUID:$PGID" /app/data /app/downloads

    exec su -s /bin/sh -c 'exec node /app/server.js' node
fi

exec node /app/server.js
