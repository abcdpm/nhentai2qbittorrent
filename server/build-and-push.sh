#!/bin/sh
# ==========================================================
# 构建 Docker 镜像并推送到 Docker Hub
#
# 每次推送固定上传两个标签：
#   <版本号>（.env 中的 IMAGE_TAG，如 1.0.0）与 latest
#
# 用法:
#   ./build-and-push.sh                # 使用 .env / 默认值
#   ./build-and-push.sh 1.1.0          # 指定版本号（同步写回 .env）
#   ./build-and-push.sh 1.1.0 myuser   # 指定 [版本号] [DockerHub用户名]
#
# 取值优先级: 命令行参数 > 环境变量(DOCKERHUB_USER/IMAGE_TAG) > .env > 默认值
#   默认用户: llllalex    默认版本: 1.0.0
#
# docker-compose.yml 不参与镜像构建，仅拉取运行：
#   docker compose pull && docker compose up -d
# ==========================================================
set -eu

cd "$(dirname "$0")"

DEFAULT_USER="llllalex"
DEFAULT_TAG="1.0.0"

ENV_USER="${DOCKERHUB_USER:-}"
ENV_TAG="${IMAGE_TAG:-}"
FILE_USER=""
FILE_TAG=""
if [ -f .env ]; then
    FILE_USER=$(sed -n 's/^DOCKERHUB_USER=//p' .env | head -1 | tr -d "\"' ")
    FILE_TAG=$(sed -n 's/^IMAGE_TAG=//p' .env | head -1 | tr -d "\"' ")
fi

USER_NAME="${2:-${ENV_USER:-${FILE_USER:-$DEFAULT_USER}}}"
TAG="${1:-${ENV_TAG:-${FILE_TAG:-$DEFAULT_TAG}}}"

command -v docker >/dev/null 2>&1 || {
    echo "错误: 未找到 docker，请先安装 Docker"
    exit 1
}

IMAGE="$USER_NAME/nh-download-server"
PLATFORM_ARGS=""
[ -n "${BUILD_PLATFORM:-}" ] && PLATFORM_ARGS="--platform $BUILD_PLATFORM"

echo "==> 构建镜像: $IMAGE:$TAG 与 $IMAGE:latest"
# shellcheck disable=SC2086
docker build $PLATFORM_ARGS --build-arg APP_VERSION="$TAG" -t "$IMAGE:$TAG" -t "$IMAGE:latest" .

# 未登录 Docker Hub 时先登录（config.json 中无 docker.io 记录视为未登录）
if ! grep -q "index.docker.io" "$HOME/.docker/config.json" 2>/dev/null; then
    echo "==> 未检测到 Docker Hub 登录态，请按提示登录"
    docker login
fi

echo "==> 推送 $IMAGE:$TAG"
docker push "$IMAGE:$TAG"
if [ "$TAG" != "latest" ]; then
    echo "==> 推送 $IMAGE:latest"
    docker push "$IMAGE:latest"
fi

# 版本号与用户名写回 .env，供 docker-compose.yml 使用
{
    echo "DOCKERHUB_USER=$USER_NAME"
    echo "IMAGE_TAG=$TAG"
} > .env
echo "==> 已写入 .env: DOCKERHUB_USER=$USER_NAME, IMAGE_TAG=$TAG"

echo ""
echo "完成！已推送双标签: $IMAGE:$TAG 与 $IMAGE:latest"
echo "  部署:          docker compose pull && docker compose up -d"
echo "  查看 API 密钥: docker logs nh-download-server   (或 ./data/INITIAL_API_KEY.txt)"
