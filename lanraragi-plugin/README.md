# LANraragi nHentai 元数据插件（nHentaiCustom 3.2）

单文件 `nHentaiCustom.pm` —— 在原版基础上新增 **[ID] 三级回退识别**（即原 NHentaiByTitleID 的逻辑，已合并回本文件），
3.1 补上 **Cloudflare 挑战诊断**，3.2 改为 **官方 v2 API 优先 + HTML DOM 回退**：
**元数据默认走 JSON 接口，不再依赖 `cf_clearance` Cookie**。

> v1 接口 `api/gallery/*` 已下线（返回 403「Use new API https://nhentai.net/api/v2/docs」），
> 现在只剩 v2：`api/v2/galleries/{id}`、`api/v2/search`（纯 JSON、不受 Cloudflare 托管挑战影响，仅有限流）。

## 3.2：API 优先（推荐，无需 Cookie）

`HTTP GET https://nhentai.net/api/v2/galleries/{id}` 实测**不带任何 Cookie/UA 也返回 200**，
响应里直接就有 `title{english,japanese,pretty}`、`tags[{type,name,slug}]`、`media_id`、`num_pages` ——
元数据所需字段齐全，所以默认链路变成了：

```
[id] 识别 → v2 API 详情 → （失败/限流）→ v2 搜索 → （失败）→ HTML DOM（3.1 的 CF 诊断逻辑）
```

### 实测频率上限（2026-11，匿名 IP 连续打满）

| 端点 | 匿名（每 IP） | 带 API Key |
| --- | --- | --- |
| `GET /api/v2/galleries/{id}`（单本详情，**元数据主用**） | **20 次/分钟** | 45 次/分钟 |
| `GET /api/v2/search`（按标题搜索） | 10 次/分钟 | 20 次/分钟 |
| `GET /api/v2/galleries`（列表） | 15 次/分钟 | 30 次/分钟 |
| `GET /api/v2/galleries/{id}/related` | 12 次/分钟 | 30 次/分钟 |
| `GET /api/v2/galleries/popular` | 8 次/分钟 | 8 次/分钟 |

越过上限的表现（已实测）：

```
HTTP/2 429
x-ratelimit-limit: 20
x-ratelimit-remaining: 0
retry-after: 60
{"error":"Rate limit exceeded"}
```

第 **21** 次连打即 429，之后一分钟内全部 429 —— 但**不会被 Cloudflare 挑战**，`retry-after` 到了就恢复。

### 插件内置的保护

- **本地节流**：相邻两次 API 请求至少间隔固定/自动值——**没配 API Key 时 3.2s（≈20/分钟），配了 Key 自动放宽到 1.5s（≈40/分钟）**，批量打标签也不会自杀
- **429 自适应退避**：读 `retry-after`，等得起就等待重试（最多 3 次）；`retry-after` 超过 `NHENTAI_API_MAX_WAIT`（默认 20s）则**立刻回退 HTML**，不卡死 LRR 队列
- **404 立即失败**：明确报「本子不存在或已删除」，不再无谓重试
- **API 无标签 / 不可用**：自动回退 3.1 的 HTML DOM 抓取（此时才需要 Cookie）
- 命名空间规则与 HTML 路径完全一致：`tag` 无前缀，`language:` / `category:` / `character:` / `parody:` / `artist:` / `group:` 带前缀；并附带 `source:nhentai.net/g/{id}`

### 填写 API Key（可选：把限流从 20 次/分钟提到 45 次/分钟）

**方式 A（推荐，不用重启）：直接填在 LANraragi 插件设置页**

插件配置 → `nHentai (Custom Fixed)` → 参数 **`nhentai API Key (optional; raises v2 API limit from 20 to 45 req/min)`** → 粘贴 Key → 保存。

> 填了 Key 之后**节流会自动从 3.2s 放宽到 1.5s**（≈40 次/分钟），**不需要**再去改 `NHENTAI_API_MIN_INTERVAL`；
> 想更快/更保守再显式设置该环境变量即可（显式值优先）。

**方式 B：环境变量**

```yaml
# docker-compose.yml（LANraragi 容器）
environment:
  - NHENTAI_API_KEY=你的key          # 可选，45 次/分钟
  - NHENTAI_BASE_URL=https://nhentai.你的反代.com   # 可选
```

改完 `docker compose up -d` 重建容器（环境变量在进程启动时注入，热改无效）。

**Key 从哪来**：登录 nhentai.net → 右上头像 → **Settings → API Keys**
（<https://nhentai.net/user/settings#apikeys>）→ 新建 → 复制。

> ⚠️ 别和 Web 控制台「设置 → LANraragi」里的 **API Key** 搞混：那个是 **LANraragi 自己的上传密钥**（`PUT /api/archives/upload` 用），
> 这里的 `nhentai API Key` 是 **nhentai.net 账号**的，只给这个元数据插件用。

**优先级**：插件设置页参数 > 环境变量 `NHENTAI_API_KEY` > 不带认证（20 次/分钟）。

**怎么确认生效**：插件日志里出现 `v2 API 命中：gallery xxx（tags=…, media_id=…, pages=…）` 即正常；
若日志频繁出现 `v2 API 触发限流（429）`，说明 Key 没生效（检查是否多打了空格）或批量太大。

### 环境变量一览

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NHENTAI_API_KEY` | 空 | nhentai.net 账号 API Key；也可直接填在插件设置页（优先级更高），填写后 45 次/分钟（可把 `NHENTAI_API_MIN_INTERVAL` 调到 1.4） |
| `NHENTAI_BASE_URL` | `https://nhentai.net` | 镜像或自建反代，API 与 HTML 请求都会走它 |
| `NHENTAI_API_MIN_INTERVAL` | 自动 | 本地最小请求间隔（秒）；**不设置时自动**：配了 API Key → `1.5`（≈40 次/分钟），没配 → `3.2`（≈20 次/分钟）；显式设置则覆盖（`0` = 不节流） |
| `NHENTAI_API_MAX_WAIT` | `20` | 429 时最多等多久；更大的 `retry-after` 直接回退 HTML |
| `NHENTAI_API_DISABLE` | 空 | 设为 `1` 则完全不用 API，只走 HTML（旧行为/排查用） |

> **什么时候仍然需要 Cookie**：只有回退到 HTML 时才需要（拉 `#info h1` 标题和 `.tag-container` 标签）。
> 正常元数据抓取已不再需要 `cf_clearance`，也就不再受它「几分钟就过期」的影响。

## 403 排障：`Error retrieving gallery from nHentai! (Code: 403)` 是什么

日志停在这里：

```
[nHentai (Custom Fixed)] [info] Fetching HTML DOM to extract tags (V2 API bypassed to avoid 429 limits)...
处理文档 xxx 出错：(Error retrieving gallery from nHentai! (Code: 403)
```

**这不是 nhentai 页面结构变化**（改版只会导致「解析不到标签」，不会返回 403）。
实测 `https://nhentai.net/g/{id}/` 与 `/search` 在无有效 `cf_clearance` 时一律返回
**Cloudflare 托管挑战页**（响应体 5KB 左右、标题 `<title>Just a moment...</title>`），
即使把 UA / Accept / sec-ch-ua / sec-fetch-* 全部伪装成 Chrome 也一样被挑战。
旧接口 `https://nhentai.net/api/gallery/{id}` 则返回 403 + `Use new API https://nhentai.net/api/v2/docs`。

3.1 版本会在日志里打印完整诊断（UA、cookie 数量与名称、是否带 `cf_clearance`、`cf-mitigated` 响应头、URL），并重试 3 次。

### 逐项排查（按概率排序）

1. **`cf_clearance` 过期**：有效期很短（通常几十分钟），重新从浏览器复制 Cookie 即可
2. **UA 与 Cookie 不匹配**：`cf_clearance` 与获取它的 UA 强绑定；「nHentai Custom CF Bypass」插件传入的 UA
   必须与浏览器完全一致（含 Chrome 版本号）
3. **出口 IP 不一致**（最常见）：cf_clearance 绑定公网 IP。浏览器开了代理 / VPN，
   或 LRR 跑在另一台机器（NAS/Docker）走不同线路时，必然 403
4. **TLS 指纹**：Cloudflare 会校验非浏览器 TLS/HTTP2 指纹（JA3/JA4），
   Mojo::UserAgent 不是 Chrome 指纹，策略收紧后会直接挑战
5. **镜像 / 反代兜底**：设置环境变量 `NHENTAI_BASE_URL`（如自建反代或可用镜像）后重启 LRR 容器，
   插件所有请求都会走该地址：

   ```yaml
   # docker-compose.yml
   environment:
     - NHENTAI_BASE_URL=https://nhentai.你的反代.com
   ```

### 日志能看到的判定

| 日志 | 含义 |
| --- | --- |
| `第 N/3 次请求被 Cloudflare 拦截：HTTP 403 Cloudflare 挑战页（Just a moment...）` | 挑战页，不是本子不存在 |
| `cf-mitigated=challenge（Cloudflare 托管挑战）` | 响应头明确标记挑战 |
| `(Code: 404) — 本子不存在或已删除` | 真 404，不重试 |
| `未解析到任何标签：页面可能是挑战页/改版` | 200 但 DOM 里没有 `.tag-container` / `#tags` |
| `cookie 数=0/1[__cf_bm] | cf_clearance=缺失` | Cookie 没注入成功 |

## 三级回退（2.0 起）

| 优先级 | 条件 | 行为 |
| --- | --- | --- |
| ① | 压缩包名称**末端有 `[id]`**（也支持 `【id】`/`(id)`） | 按 ID 直接抓取 `https://nhentai.net/g/{id}/` |
| ② | 名称**没有 `[id]`** | 用整个名称搜索，取第一个结果 |
| ③ | 有 `[id]` 但**按 ID 抓不到** | **去掉末端 `[id]`**，用剩余名称搜索 |

> 识别规则与 nHentai 下载服务的文件夹/压缩包命名一致：`本子名 [本子id]`。

## 3.1 变更（Cloudflare 诊断）

1. **浏览器化请求头**：`Accept` / `Accept-Language` / `Referer` / `Upgrade-Insecure-Requests` / `Sec-Fetch-*`，
   并按 UA 自动生成**与之完全一致**的 `sec-ch-ua` / `sec-ch-ua-platform` / `User-Agent`（CF 会校验一致性）
2. **挑战页识别与重试**：识别 `<title>Just a moment...</title>`、`cf-mitigated: challenge`、`challenge-platform` 脚本；
   最多重试 3 次（3s/6s 退避）
3. **可操作报错**：403 不再只报 `(Code: 403)`，而是输出「Cloudflare 挑战页拦截 + 5 条排查清单 + 请求诊断（UA/cookie/cf_clearance）」；
   404 单独明确提示「本子不存在或已删除」
4. **标签选择器兼容**：`.tag-container a` / `#tags a` / `.tagchip` 三种结构；标题选择器兼容 `.pretty-format` 与 `#info h1`
5. **镜像/反代支持**：环境变量 `NHENTAI_BASE_URL`（不改代码即可切换站点根地址）
6. 解析不到标签时输出警告日志（便于区分「改版」与「被拦截」）

## 与原版（2.15）的差异（2.0 时代）

1. `get_tags` 的 ID 识别链新增「末端 `[id]`」分支（在 oneshot / `source:` 标签之后、标题搜索之前）
2. `get_tags_from_NH` 失败时的回退块（③）
3. 扩展名剥离 `.zip…` 提前一行（保证 `标题 [123].zip` 能匹配末端 `[id]`）

**其余全部原样保留**：DOM 标签解析（官方 `.tag` + 社区 `.tagchip`）、`tag:` 省略命名空间规则、
`source:` 标签、`{id}` 语法、Save archive title 参数、`login_from => "nhcustomcf"`、icon、
旧式调用兼容 shim、`get_gallery_dom_by_title` / `get_gallery_id_from_title` / `get_html_from_NH` / `get_tags_from_NH`。

## 安装

LANraragi → 插件配置 → 上传 `nHentaiCustom.pm`（覆盖旧版即可，namespace `nhcustom` 不变，配置保留）。

## 验证

桩模块 + Mock DOM 全链路 19 项断言通过：末端 `[id]` 识别、①②③三级回退、oneshot URL、
`source:` 标签、`{id}` 语法、Save archive title、失败报错等。

### 自检脚本（无需安装 Mojo / LANraragi）

```bash
perl lanraragi-plugin/test/cf-diagnostics-test.pl
```

覆盖 **47 项断言**：

- **API 通道（3.2）**：JSON → tags 映射（tag 无前缀 / category·language·artist 带前缀 / source 标签）、`pretty` 标题、
  429 按 `retry-after` 退避重试、404 不重试且明确报错、限流超阈值自动回退 HTML、v2 搜索选中最匹配候选、`{id}` 语法零请求、标题归一化、
  **API Key 优先级（插件设置页 > 环境变量 > 不认证）与节流自动放宽（1.5s / 3.2s）**
- **Cloudflare 诊断（3.1）**：挑战页识别（403 挑战页 / 普通 403 / 404 / `cf-mitigated` 头）、
  浏览器化请求头与 UA 一致性、`_nh_get` 重试（先挑战后成功）、连续挑战的报错清单、诊断信息（cookie 数量与 `cf_clearance` 有无）、404 不重试



## 识别逻辑（三级回退）

| 优先级 | 条件 | 行为 |
| --- | --- | --- |
| ① | 压缩包名称**末端有 `[id]`**（也支持 `【id】`/`(id)`） | 按 ID 直接抓取 `https://nhentai.net/g/{id}/` 元数据 |
| ② | 名称**没有 `[id]`** | 用整个压缩包名称在 nHentai 搜索，取第一个结果的元数据 |
| ③ | 有 `[id]` 但**按 ID 抓不到**（删除/404/解析失败） | **去掉末端 `[id]`**，用剩余名称搜索抓取 |

> 识别规则与 nHentai 下载服务的命名一致：`本子名 [本子id]`（含 zip 压缩包同样适用）。
> 另支持「一次性参数」强制指定：填本子 ID / 本子 URL / 搜索关键词均可。

## 返回的元数据

- **title**：本子标题（可选优先日文标题 `preferJapaneseTitle`）
- **tags**：带命名空间标签，如 `artist:authora, tag:female, language:chinese, source:https://nhentai.net/g/123456/`
  - `addSourceTag` 可关闭 `source:` 标签

## 安装

任选其一：

1. **Web 界面**：LANraragi → 插件配置 → 上传插件 → 选择 `NHentaiByTitleID.pm`
2. **手动**：把 `NHentaiByTitleID.pm` 放进 LANraragi 的插件目录（源码安装为 `lanraragi/lib/plugins/`，Docker 为容器内 `/home/koyomi/lanraragi/lib/plugins/`，挂载出来放进去再重启容器）

启用后在「插件配置」中勾选并可设置参数。

## 自检（无需安装 LANraragi）

```bash
perl NHentaiByTitleID.pm
```

自检**内嵌在同一个 .pm 文件中**（含 mock user_agent），直接执行即走完整识别链路（19 项断言）：
末端 `[id]` 提取、①②③三级回退、一次性参数、日文标题优先、全部失败时报错等。
被 LANraragi `require` 加载时自检不会执行；日志在 LRR 内自动用官方 logger，脱离 LRR 时降级为内置 logger。

## 与本项目其他部分的配合

- nHentai 下载服务（`server/`）下载的文件夹为 `本子名 [本子id]`，完整性校验后自动压缩为 `本子名 [本子id].zip`
- 把这些 zip 导入 LANraragi 后，本插件即可通过末端 `[id]` 精确抓取元数据
