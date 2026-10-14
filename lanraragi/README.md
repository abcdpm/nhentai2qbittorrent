# LANraragi nHentai 元数据插件（单文件 · 三级回退识别）

`NHentaiByTitleID.pm` —— 按 LANraragi 官方 Metadata Plugin 规范编写的 nHentai 元数据插件。
**完全自包含的单个 .pm 文件**，无任何附属文件，拷贝即用。

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
