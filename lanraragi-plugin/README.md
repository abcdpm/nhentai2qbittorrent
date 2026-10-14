# LANraragi nHentai 元数据插件

## 文件说明

| 文件 | 说明 |
| --- | --- |
| `nHentaiCustom.pm` | **你的基准插件**（DOM 解析标签、支持社区标签、`{id}` 语法、source 标签识别、登录插件 `nhcustomcf`） |
| `NHentaiByTitleID.pm` | 在你的基础上**最小程度修改**的版本：ID 识别改为三级回退 |

## NHentaiByTitleID 的三级回退（相对 nHentaiCustom 的全部改动）

| 优先级 | 条件 | 行为 |
| --- | --- | --- |
| ① | 压缩包名称**末端有 `[id]`**（也支持 `【id】`/`(id)`） | 按 ID 直接抓取 `https://nhentai.net/g/{id}/` |
| ② | 名称**没有 `[id]`** | 用整个名称搜索，取第一个结果 |
| ③ | 有 `[id]` 但**按 ID 抓不到** | **去掉末端 `[id]`**，用剩余名称搜索 |

**未改动（与你的完全一致）**：`use` 语句、`login_from`、icon、参数面板（Save archive title）、
旧式调用兼容 shim、`get_gallery_dom_by_title` / `get_gallery_id_from_title`（含 `{id}` 语法）/
`get_html_from_NH` / `get_tags_from_NH`（DOM 标签解析、社区标签、source 标签、标题保存）。

`get_tags` 内的差异仅有：
1. ID 识别链新增「末端 `[id]`」分支（在 oneshot / source 标签之后、标题搜索之前）
2. `get_tags_from_NH` 失败时的回退块（③）
3. 扩展名剥离 `.zip…` 提前一行（保证 `标题 [123].zip` 能匹配到末端 `[id]`）

## 安装

任选其一：LANraragi → 插件配置 → 上传 `NHentaiByTitleID.pm`；或放入插件目录后重启。
与 `nHentaiCustom.pm` 可共存（namespace 不同：`nhtitleid` / `nhcustom`）。

## 验证

已用桩模块 + Mock DOM 对 `get_tags` 全链路断言 19 项全部通过：
末端 `[id]` 识别（含全角/圆括号）、①②③三级回退、oneshot URL、source 标签、`{id}` 语法、
标题保存、失败报错等。


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
