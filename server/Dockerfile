# ==========================================================
# nHentai 本地下载服务镜像
# 构建并推送 Docker Hub:  ./build-and-push.sh
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

CMD ["node", "server.js"]
