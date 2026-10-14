# LANraragi nHentai 元数据插件（nHentaiCustom 2.0）

单文件 `nHentaiCustom.pm` —— 在原版基础上新增 **[ID] 三级回退识别**（即原 NHentaiByTitleID 的逻辑，已合并回本文件作为 2.0 版本）。

## 三级回退（2.0 新增）

| 优先级 | 条件 | 行为 |
| --- | --- | --- |
| ① | 压缩包名称**末端有 `[id]`**（也支持 `【id】`/`(id)`） | 按 ID 直接抓取 `https://nhentai.net/g/{id}/` |
| ② | 名称**没有 `[id]`** | 用整个名称搜索，取第一个结果 |
| ③ | 有 `[id]` 但**按 ID 抓不到** | **去掉末端 `[id]`**，用剩余名称搜索 |

> 识别规则与 nHentai 下载服务的文件夹/压缩包命名一致：`本子名 [本子id]`。

## 与原版（2.15）的差异（仅 3 处）

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
