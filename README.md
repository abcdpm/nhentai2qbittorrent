# nHentai → 本地下载服务 / 原图直刮

在 nHentai 页面添加按钮，支持批量推送下载任务到本地 Web 下载服务（排队下载）或浏览器直接下载；带美观通知栏、设置弹窗、自动记忆复选框状态、封面右下角快捷复制链接等。

## 组成

| 部分 | 说明 |
| --- | --- |
| `nh2qb.js` | 油猴脚本：勾选本子 → 推送到本地服务队列 / 浏览器直接下载原图 |
| `server/` | 本地 Web 下载服务：任务队列 + 现代化管理界面 + API Key 鉴权 |
| `lanraragi-plugin/` | LANraragi 元数据插件：按压缩包末端 `[id]` / 名称三级回退抓取 nHentai 元数据 |

## 本地下载服务（server/）

**环境**：Node.js ≥ 18.17（推荐 20）。核心零依赖，直接启动即可。

```bash
cd server
node server.js          # 启动（默认 http://127.0.0.1:8787）
npm install sharp       # 可选：启用“统一 WebP 转换”（含 gif → 动态 webp）
npm test                # 运行自动化测试（mock 源站全链路验证）
```

### Docker Compose 部署（推荐）

镜像内置 `sharp`（WebP 统一转换开箱即用），配置与下载内容均通过数据卷持久化。

```bash
cd server

# 1) 构建镜像并推送到 Docker Hub（每次推送 <版本号> + latest 两个标签；首次会提示 docker login）
./build-and-push.sh                     # 默认用户 llllalex，版本号取自 .env 的 IMAGE_TAG
./build-and-push.sh 1.1.0 我的用户名    # 也可指定 [版本号] [用户名]，并同步写回 .env

# 2) 部署（compose 不参与镜像构建，仅拉取镜像运行）
docker compose pull && docker compose up -d   # 从 Docker Hub 拉取部署
docker compose up -d                          # 本机刚推送过则直接运行本地镜像
```

- **镜像版本**：`.env` 中 `DOCKERHUB_USER=llllalex`、`IMAGE_TAG=1.0.0`，推送脚本与 compose 共用；每次推送固定上传 `:1.0.0`（当前版本号）与 `:latest` 两个标签
- **持久化**：`./data`（配置 / API 密钥 / 任务队列）、`./downloads`（本子，格式 `本子名 [本子id]`）
- **首次 API Key**：`docker logs nh-download-server` 或 `./data/INITIAL_API_KEY.txt`
- **Web 控制台**：`http://部署机IP:8787`（宿主机端口可改：`NH_HOST_PORT=8080 docker compose up -d`）
- **环境变量**：所有配置项都可用 `NH_` 前缀环境变量固定（如 `NH_REQUEST_INTERVAL_MS`、`NH_CONVERT_TO_WEBP`、`NH_CDN_BASE_URLS` 逗号分隔），**优先级高于 Web 界面保存值**；compose 默认仅固定 `NH_HOST`/`NH_PORT`（监听相关，界面中不可改）


**首次启动**会自动生成一枚 API Key，打印在日志里，并写入 `server/data/INITIAL_API_KEY.txt`（复制后建议删除该文件）。
浏览器打开 `http://127.0.0.1:8787`，输入 API Key 进入控制台。**所有 `/api/*` 均需密钥**（请求头 `X-API-Key`），公网暴露也不会被陌生人刷任务；密钥可随时在控制台生成 / 吊销（磁盘只存 SHA-256 哈希）。

### 功能

- **下载队列**：推送后自动排队下载，可暂停/继续、取消、重试；任务持久化，服务重启自动恢复未完成任务
- **完整性校验**：每本下载完成后校验页数 + 文件头魔数（jpg/png/gif/webp），缺损自动进入补齐轮重传
- **超时重传**：单次请求超时自动重试（`timeoutMs`）
- **多 CDN 轮询**：每轮把所有 CDN 节点轮询一遍（i.nhentai.net / i1 / i2 / i3 / i5 / i7…），失败自动换节点；429 限流自动退避
- **元数据（原逻辑，避开官方 API 限流）**：油猴脚本推送时**自动附带元数据**（页面解析 `media_id` / `Pages: N` / 后缀表），服务端**直接请求 CDN 下载图片、零元数据请求**；无 meta 的任务按原逻辑抓详情页 HTML 解析；官方 v2 API **默认禁用**（限流严重，`apiUrlTemplate` 留空即不使用，可选配置为备用源）
- **多图片格式**：webp / jpg / png / gif 全支持；开启“统一 WebP”后 jpg、png → webp，**gif → 动态 WebP（保留动画）**
  - 未安装 `sharp` 时自动降级为保留原格式（不会失败）
- **间隔下载**：`requestIntervalMs` 图片请求间隔（防限流）+ `galleryIntervalMs` 任务间隔
- **文件夹命名**：`本子名 [本子id]`（如 `本子名 [123456]`），内部为 `1.jpg`、`2.webp` …
  - 已适配 **Windows/Linux 双平台限制**：非法字符/控制符/保留设备名（CON、NUL…）/结尾点空格自动清洗；超长时按 UTF-8 字节**截掉标题最后面的文字**（整体 ≤180 字节，保留末端 `[id]` 标记）
- **自动打包 ZIP**：完整性校验通过后自动压缩为 `本子名 [本子id].zip`（条目按页码排序，可直接导入 LANraragi）；默认删除原图片文件夹（可设置保留）
- **Web 管理界面**：深色现代 UI、实时进度、设置面板、API 密钥管理、运行日志

### API 速览（均需 `X-API-Key`）

```bash
# 提交任务（油猴脚本即调用此接口）
curl -X POST http://127.0.0.1:8787/api/tasks \
  -H "Content-Type: application/json" -H "X-API-Key: nhk_xxx" \
  -d '{"items":[{"gid":"123456","title":"本子标题"}]}'

# 查询任务 / 统计 / 日志 / 设置 / 密钥
GET    /api/tasks?status=&gid=        GET  /api/stats        GET  /api/logs?since=
GET    /api/tasks/:id                 POST /api/tasks/:id/retry|cancel    DELETE /api/tasks/:id
POST   /api/queue/pause|resume|retry-failed
GET/PUT /api/settings                 GET/POST /api/keys     DELETE /api/keys/:id
```

## 油猴脚本（nh2qb.js）v5.5.0

- 列表页右下角按钮组（三按钮等距）：「推送到下载服务」（绿色）「批量下载到本地」「设置」
- 详情页右下角按钮组（三按钮等距）：「提取原图下载」「推送到下载服务」（绿色）「设置」
- **推送自动附带元数据**：脚本按原逻辑解析页面拿 `media_id` / `Pages: N` / 后缀表随任务上传，服务端纯 CDN 下载（避开官方 API 限流）
- **自动同步浏览器 Cookie**：脚本自动抓取 nhentai 的 Cookie（`GM_cookie` 可拿 HttpOnly 的 `cf_clearance`）通过 `POST /api/cookie` 传给下载服务；页面加载后与每 60s 自动同步，推送前强制刷新
- 设置：下载根目录、本地服务地址 + API Key、🔌 测试连接、🔄 从服务同步已下载记录、历史记录备份/恢复
- **自动标记已下载**：下载服务完成下载 + 完整性校验通过后，页面自动标记「已下载」（角标 + 封面变暗 + 取消勾选，与本地下载一致，每 60s 自动同步）
- 与服务端一致的文件夹格式：`【根目录】/【本子名 [本子id]】/【页码.后缀】`

## 更新日志

### v5.5.0
- **放弃官方 v2 API（限流严重）**：恢复原逻辑——脚本推送时自动附带元数据（页面解析 `media_id` / `Pages: N` / 后缀表），服务端**直接请求 CDN 下载图片、零元数据请求**；无 meta 的任务按原逻辑抓详情页 HTML；`apiUrlTemplate` 默认留空=不使用官方 API（可选配置为备用源）
- 任务接口支持 `meta` 字段（含合法性校验）

### v5.4.0
- **修复「元数据 HTTP 403」根因**：nhentai 已废弃旧 `/api/gallery/` 接口（403 "Use new API"），元数据首选源切换为**官方 v2 API**（`/api/v2/galleries/{gid}`，不受 Cloudflare 挑战、无需认证即可读取），并解析 `pages[].path` 得到每页精确扩展名；详情页 HTML 降为后备源
- 支持可选 nhentai API Key（`nhApiKey`，`Authorization: Key xxx`，账户设置生成），防止官方未来收紧
- 按钮等距：列表页「推送到下载服务/批量下载到本地/设置」、详情页「提取原图下载/推送到下载服务/设置」各自同一按钮组统一间距，删除重复的独立设置按钮

### v5.3.0
- 油猴脚本**自动获取浏览器 Cookie 并同步给下载服务**（新增 `POST /api/cookie` 接口）：优先 `GM_cookie` 拿 HttpOnly 的 `cf_clearance`，推送前强制刷新、每 60s 自动同步——彻底解决「元数据 HTTP 403」
- 「推送到下载服务」按钮改为绿色，右下角按钮组与「设置」按钮间距收紧
- `/api/stats` 新增 `cookieSet` 状态

### v5.2.0
- 修复推送任务「元数据 HTTP 403」：详情页被拦时自动回退官方 JSON API 备用源；新增 `nhCookie` 配置（填浏览器 Cookie 解 Cloudflare 拦截），请求头补全为浏览器风格；403 时错误信息给出明确排障引导
- Web 控制台新增站点图标（favicon），高级设置新增备用 API 模板与浏览器 Cookie 字段
- 油猴脚本按钮调整：列表页/详情页按钮统一移至右下角按钮组；「推送到下载服务」改名并与「提取原图下载」同款样式
- 下载服务完成下载 + 完整性校验通过后，nHentai 页面**自动标记「已下载」**（与本地下载标记逻辑一致）

### v5.1.0
- 文件夹命名适配 Windows/Linux 限制：非法字符/保留设备名/结尾点空格清洗，超长按 UTF-8 字节截掉标题尾部文字（保留末端 `[id]`），整体 ≤180 字节
- 完整性校验通过后自动压缩为 `本子名 [本子id].zip`（零依赖 deflate，条目按页码排序，默认清理原文件夹，可设置保留）
- 新增 LANraragi 元数据插件（`lanraragi-plugin/NHentaiByTitleID.pm`，**单个 .pm 文件自包含**，内嵌自检）：① 优先识别压缩包末端 `[id]` 按 ID 抓取 → ② 无 `[id]` 按名称搜索 → ③ 有 `[id]` 但抓不到时去掉 `[id]` 按名称搜索

### v5.0.0
- 新增本地 Web 下载服务（server/）：任务队列、完整性校验、超时重传、多 CDN 轮询、WebP 统一转换（gif → 动态 webp）、请求/任务间隔
- 新增 Web 管理界面 + API Key 生成/吊销鉴权（防公网骚扰）
- 新增 Docker 部署：Dockerfile / docker-compose.yml / build-and-push.sh（构建并推送 Docker Hub，每次推送 `<版本号>`+`latest` 双标签，默认用户 llllalex、版本号存于 `.env`；compose 仅拉取运行不参与构建），支持 `NH_*` 环境变量配置
- 油猴脚本新增「📤 推送到下载服务」（列表页/详情页）、服务地址与 API Key 配置、测试连接、从服务同步已下载
- 文件夹命名调整为「本子名 [本子id]」

### v2.4
添加备份/恢复按钮，防止浏览器缓存清理导致历史已下载记录数据丢失

### v2.2
修复单人页按钮消失问题

### v2.1
添加 updateURL 和 downloadURL

### v2.0
在下载本子前先和历史已下载记录进行比对进行去重，利用浏览器的 localStorage 本地存储一份“已下载清单”。


