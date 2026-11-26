# DSH NovelAI Atelier

面向 DeepSeek Harness 的 NovelAI V5 / V4.5 生图插件：提供 16 项 Agent 工具与嵌入右侧栏的本地可视化工作台，支持对话驱动生图与工作台精细编辑协作。

## 为什么用它

- **完整覆盖 NovelAI V5 / V4.5 能力**：支持文生图、图生图、局部重绘（含聚焦重绘）、四向扩图、增强、2 倍放大、导演工具（线稿/上色/去背景等）、V5 & V4.5 精确参考（Precise Reference，V5 支持角色/风格/服装参考与同款服装开关）、V4.5 Vibe 编码。
- **对话与右侧工作台共享状态**：在聊天里让 Agent 构思、生图或整理资料，在右侧工作台用自适应瀑布流逛画廊、画遮罩、管草稿、改接口，两边实时互通，无需另起网页服务。
- **多接口与拼车友好**：可保存多条官方或中转接口，独立管理令牌、启停、优先级、拼车人数（V5 额度按 1/N 估算）与自定义额度查询；单条失败不会自动切到别的接口。
- **本地优先，数据归你**：工作台数据存在 `~/.novelai-workbench`，图片默认保存在 `~/Pictures/NovelAI`，支持整库 ZIP 备份与 PNG 元数据清洗；卸载插件不会删除任何个人数据。

## 快速上手（3 步）

### 1. 安装插件

从 Releases 下载 `dsh-novelai-atelier-<version>.tgz`（不要解压），在 DeepSeek Harness 中打开左侧「设置 → 插件 → 添加插件」，填入该 `.tgz` 的绝对路径，安装后点击「立即启用」，然后完整退出并重开 DSH。

详细安装、升级与开发挂载说明见 [INSTALL.md](INSTALL.md)。

### 2. 配置接口

在会话右侧栏打开「NovelAI 生图工作台」，进入「设置 → 添加接口」：

- **官方接口**：地址填 `https://image.novelai.net`，令牌填你的 `pst-…` Persistent API Token。
- **中转 / 拼车接口**：地址填服务商提供的地址（通常以 `/v1` 结尾）与对应 key；按需勾选「小图免费（类 Opus）」并填写拼车人数。

填好后点击「测试连接」，即可看到当前 Anlas 余额与 V5 额度状态。

### 3. 开始创作

在对话中直接提出需求即可——普通模式下插件只挂载轻量入口 `nai_use_tools`，Agent 会在需要时自动按需加载完整工具与内置提示词指南，平时不占用上下文：

- **直接生图**：「帮我用 V5 画一张雨后森林里的白发少女，竖图，电影光影」
- **角色/画师复用**：「把这个角色存进资料库，叫 Mira」「用资料库里的 Mira 换一套冬装再画一张」
- **V5 精确参考**：「参考 `D:/refs/char.png` 的角色和 `D:/refs/outfit.png` 的服装，画一张在咖啡馆看书的场景」
- **局部重绘 / 扩图**：在右侧工作台选中画廊里的作品，用遮罩工具涂抹需要重绘的区域，或直接让 Agent 对指定图片执行 `inpaint` / `outpaint` / `upscale`
- **定时生图**：「每天早上 9 点按我资料库里的角色随机画一张日常图」（接入 DSH 原生定时任务，新建默认停用，核对后再开启）

## 进阶用法与细节

- **默认参数与省额度模式**：默认使用 V5 Full、23 步、Euler Ancestral、Karras、CFG 7。快速草稿或批量试构图时可使用 `v5_tier: "medium"`（仅 V5 Full 可用，固定 14 步与 Euler A，额度约省 42%）。
- **单人 vs 多人构图**：单人画面直接写在主提示词最自然；多人互动时把人数与场景放主提示词，各自身份与动作放角色槽。
- **画廊与资料库**：画廊与资料库共用自适应瀑布流，卡片按原图比例完整展示；画廊支持按角色/画师提示词 tag 筛选、收藏、参数回溯（从 PNG 元数据或回执恢复完整配方）与脱敏导出（清除 PNG 文本块与 Alpha 隐写元数据）。
- **底图替换不丢配方**：在工作台点「仅更换底图」只替换 `image_path`，保留当前草稿的全部提示词与参数；「覆盖草稿（完整配方）」为独立操作，需二次确认。

## Agent 工具一览

默认仅暴露 `nai_use_tools`，调用 `nai_use_tools({ enabled: true })` 后启用其余 15 项工具：

| 工具 | 用途 | 费用/副作用 |
| --- | --- | --- |
| `nai_generate_image` | 文生图（支持角色槽、V5/V4.5 精确参考、V4.5 Vibe、透明背景、画面文字、`endpoint` 指定接口） | 扣 Anlas / V5 额度 |
| `nai_edit_image` | `img2img`（支持精确参考） / `inpaint` / `outpaint` / `enhance` / `upscale` / `augment` / `encode_vibe` | 扣 Anlas / V5 额度 |
| `nai_prepare_image` | 本地裁切、缩放、垫画布、生成矩形或多边形遮罩 | 纯本地 |
| `nai_image_info` | 读取 PNG 元数据与透明度、查询操作回执、恢复请求配方、清洗元数据导出安全副本 | 纯本地 |
| `nai_check_credits` | 逐接口查询订阅、Anlas 余额、V5 余量与各模型免费资格 | 只读联网 |
| `nai_quote` | 离线校验参数或计算预计费用 | 只读 |
| `nai_get_presets` | 查看质量/负面模板及各操作的完整参数契约 | 只读 |
| `nai_get_prompt_guide` | 按主题读取内置 NovelAI 提示词与工作台指南 | 只读 |
| `nai_suggest_tags` | 标签、中英词库与社区素材（Pixiv / Danbooru / AITag）建议 | 只读 |
| `nai_workbench_status` | 查看运行版本、工具清单、草稿、作品与队列状态 | 只读 |
| `nai_gallery_read` | 按关键词、模型、角色/画师标签或 ID 检索画廊历史 | 只读 |
| `nai_library_read` | 检索与精读资料库条目（角色/分支/画师/混合/预设），返回合成提示词与分面计数 | 只读 |
| `nai_draft` | 读写共享草稿，支持将资料库条目组装进草稿 | 写本地 |
| `nai_library_save` | 新建、更新或删除资料库条目（含标签与收藏） | 写本地 |
| `nai_gallery_curate` | 收藏或归档画廊作品 | 写本地 |
| `nai_schedule_save` | 桥接 DSH 原生定时任务（`ctx.schedule`），创建、查看、触发或删除定时生图任务 | 写宿主调度 |

## 开发与验证

```bash
pnpm run build          # 构建 Host 与前端工作台 bundle
pnpm run typecheck      # 前后端 TypeScript 类型检查
pnpm test               # 全量回归测试
pnpm run verify:package # 校验发布包导出、资产与文档
```

先 `build` 再 `test`，两者不要并行运行。日常开发可在 DSH 插件页用 `link:<工作区绝对路径>` 挂载源码，发布前用 `pnpm pack` 生成 `.tgz` 并验证。

## 兼容性

- **宿主**：DeepSeek Harness 桌面版（已在 `0.2.2-rc.5` 验证，兼容 `@deepseek-ai/dsh-scope ^0.2.0-rc.2`、`@deepseek-ai/dsh-tools ^0.2.0-rc.2`）
- **运行时与 peer 依赖**：Node `^22.19.0 || >=24.0.0`、Cordis `^4.0.4`、Schemastery `^3.18.4`（详见 [package.json](package.json)）

## 许可

[MIT](LICENSE)
