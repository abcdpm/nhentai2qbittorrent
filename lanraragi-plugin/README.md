# LANraragi nHentai 元数据插件（nHentaiCustom 3.1）

单文件 `nHentaiCustom.pm` —— 在原版基础上新增 **[ID] 三级回退识别**（即原 NHentaiByTitleID 的逻辑，已合并回本文件），
并在 **3.1** 上补齐了 **Cloudflare 挑战诊断**（浏览器化请求头、挑战页识别与重试、可操作的报错日志）。

> **不使用任何官方 API**（v1 `api/gallery/*` 已下线返回 403「Use new API」，v2 有严格限流 20/分钟），
> 标签始终从 HTML DOM 抓取。

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

### 3.1 新增：Cloudflare 诊断自检（无需安装 Mojo / LANraragi）

```bash
perl lanraragi-plugin/test/cf-diagnostics-test.pl
```

覆盖 18 项断言：挑战页识别（403 挑战页 / 普通 403 / 404 / `cf-mitigated` 头）、
浏览器化请求头与 UA 一致性、`_nh_get` 重试（先挑战后成功）、连续挑战的报错清单、
诊断信息（cookie 数量与 `cf_clearance` 有无）、404 不重试。



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
