# ==========================================================
# nHentai 本地下载服务镜像
# 构建并推送 Docker Hub:  ./build-and-push.sh  (Windows: build-and-push.bat)
# 本地构建运行:            docker compose up -d --build
# ==========================================================
FROM node:20-bookworm-slim

WORKDIR /app

# 安装依赖（含可选依赖 sharp：启用 WebP 统一转换，gif -> 动态 WebP；
# 若 sharp 安装失败 npm 会自动跳过，服务降级为保留原格式，仍可正常下载）
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY src ./src
COPY public ./public
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
# sed 兜底：即使宿主机/检出环境把 .sh 转成了 CRLF（core.autocrlf），
# 也在此清洗为 LF，避免 shebang 带 \r 导致 "exec ...: no such file or directory"
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh \
    && chmod +x /usr/local/bin/entrypoint.sh

# 容器内必须监听 0.0.0.0 才能做端口映射；
# 优先级：环境变量 > /app/data/config.json > 内置默认值（NH_ + 配置项全大写）
ENV NH_HOST=0.0.0.0 \
    NH_PORT=8787 \
    NODE_ENV=production

# /app/data      -> 配置 / API 密钥 / 任务队列持久化
# /app/downloads -> 下载的本子（文件夹格式：本子名 [本子id]）
VOLUME ["/app/data", "/app/downloads"]

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.NH_PORT+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 入口脚本支持 PUID/PGID（linuxserver.io 风格）：指定下载文件/配置的宿主归属并降权运行
# APP_VERSION 在构建时由 build-and-push.sh 传入（与镜像标签一致），Web 界面左下角展示
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
