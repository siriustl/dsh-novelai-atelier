# DSH NovelAI Atelier

DeepSeek Harness 的 NovelAI V5 / V4.5 图像插件：16 项 Agent 工具 + 嵌入右侧栏的工作台。MIT 许可。

## 能做什么

- **生图与编辑**：文生图、图生图、局部重绘、四向扩图、增强、2 倍放大、导演工具（线稿/上色/去背景等）、V4.5 Vibe 编码。
- **参数回溯**：从 PNG 元数据或操作回执恢复完整请求，报告可复用性与不支持字段。
- **工作台**：画廊（自适应瀑布流、大图检查、筛选、收藏、ZIP 导出）、资料库（角色 / 形态分支 / 画师 / 混合 / 预设）、共享草稿、灵感检索（Pixiv / Danbooru / AITag）、定时计划。
- **自适应瀑布流**：画廊和资料库共用一套按面板宽度自动分栏的瀑布流，卡片高度跟随作品比例，例图完整显示不裁切；画廊按时间顺序从左向右铺排，悬停才出现收藏与详情按钮，不遮挡画面。
- **资料库检索**：按类型、标签、收藏筛选，支持名称/最近使用排序、分面计数与分页；条目带使用次数和最近使用时间。分支在筛选器中显示为「角色 · 分支」，同名分支不再混淆。
- **画廊筛选**：角色、画师两个独立筛选框，按资料提示词标签匹配作品内容（角色取主提示词第一个 tag，画师取主提示词），不区分大小写。
- **本地优先**：可保存多条 NovelAI 接口（官方或中转），每条独立令牌、启停、优先级、拼车人数（V5 额度按 1/N 估算）、订阅备注与额度查询预设；令牌明文保存在本机设置里，备份可整包带走。工作台数据在 `~/.novelai-workbench`，图片在 `~/Pictures/NovelAI`。卸载插件不会删除它们。

## 安装

在 DeepSeek Harness 的「插件」页选择「添加插件」，填入下载后的 `.tgz` 包绝对路径，安装后启用，再完整重启 DSH。

首次安装需要联网下载依赖；插件本身不含你的令牌、资料或图片。详见 [INSTALL.md](INSTALL.md)。

## 工具

普通模式只挂轻量入口 `nai_use_tools`，调用 `nai_use_tools({enabled:true})` 后才加载其余 15 项，避免无谓占用上下文。

| 工具 | 用途 | 联网/扣费 |
| --- | --- | --- |
| `nai_generate_image` | 文生图，支持角色槽、Vibe / Precise 参考、透明背景、画面文字；可用 `endpoint` 指定接口；返回 `gallery_job_id` | 扣 Anlas |
| `nai_edit_image` | img2img / inpaint / outpaint / enhance / upscale / augment / encode_vibe；可用 `endpoint` 指定接口 | 扣 Anlas |
| `nai_prepare_image` | 本地裁切、缩放、垫画布、生成矩形或多边形遮罩 | 否 |
| `nai_image_info` | 读 PNG 元数据、查回执、恢复请求、清洗元数据 | 否 |
| `nai_check_credits` | 逐个接口查订阅、Anlas 余额、V5 用量与各模型免费资格；非官方接口按你声明的「小图免费」规则判断 | 只读 |
| `nai_quote` | 离线校验参数或查询预计费用 | 只读 |
| `nai_get_presets` | 质量/负面模板与各操作的完整参数契约 | 只读 |
| `nai_get_prompt_guide` | 内置提示词指南（核心、模型、构图、参数） | 只读 |
| `nai_suggest_tags` | 标签、中英词库与社区素材建议 | 只读 |
| `nai_workbench_status` | 工作台版本、草稿、作品、计划与任务状态 | 只读 |
| `nai_gallery_read` | 画廊历史查询，支持精确 ID、角色/画师标签筛选，默认只回摘要与图片路径 | 只读 |
| `nai_library_read` | 资料库检索与精读，返回类型/标签/收藏分面，含合成后的提示词；`ids` 支持批量精读 | 只读 |
| `nai_draft` | 共享草稿读写，含按资料库单条/`entry_ids` 批量组装提示词 | 写本地 |
| `nai_library_save` | 保存或删除角色、分支、画师、混合、预设，含标签与收藏 | 写本地 |
| `nai_gallery_curate` | 收藏或归档画廊任务 | 写本地 |
| `nai_schedule_save` | 管理定时生图计划 | 写本地 |

## 使用要点

- 默认参数：V5 Full、23 步、Euler Ancestral、Karras、CFG 7；`v5_tier: "medium"` 仅 V5 Full 可用，固定 14 步与 Euler A，额度约省 42%。
- 单人画面直接用主提示词最自然，非必要不填角色坐标与角色专属负面词。
- 资料库条目在编辑器里可写标签、收藏和使用备注；筛选器按类型/标签/收藏组合过滤，分支会带上所属角色名。
- 画廊的「角色」「画师」筛选只按 tag 文本匹配作品提示词，可同时选择（需同时命中）；不复用任务里记录的资料来源。
- 「仅更换底图」保留当前请求的全部提示词与参数，只换 `image_path`；「覆盖草稿（完整配方）」是另一条命令，需确认。
- `output_subdir` 按任务分类到图片输出目录下，没有全局默认分类。
- 参考项目 `nai-atelier` 只是参考，不是上游；未实施的能力不按 README 承诺。

## 开发

```bash
pnpm run typecheck     # 前后端 TypeScript
pnpm test              # 全量回归
pnpm run build         # tsdown + 客户端 bundle
pnpm run verify:package
```

先 `build` 再 `test`，两者不要并行运行。日常迭代建议用 `link:` 装到 profile，发布时再 `pnpm pack` 出 tgz。

## 兼容

DSH `0.2.1-rc.2`、Cordis `4.0.5`、Schemastery `3.18.5`，Node `^22.19.0 || >=24.0.0`；peer 依赖允许同系列 Cordis `^4.0.4` 与 Schemastery `^3.18.4`。

## 许可

[MIT](LICENSE)
