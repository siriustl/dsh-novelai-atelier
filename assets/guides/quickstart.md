# NovelAI Atelier 快速使用

NovelAI Atelier 是 DeepSeek Harness 插件。工作台与对话工具共用草稿、资料库、作品和连接设置，不需要另起网页服务。

## 开始创作

1. 启用插件，在工作台设置中配置 NovelAI Token 和输出目录；凭据只留在本机。
2. 用 `nai_workbench_status({"info":true})` 查看运行版本和实际工具列表；需要账户信息时用 `nai_check_credits`。
3. 先读 `nai_get_prompt_guide` 的 `prompting` 核心，模型和构图主题按需读取。
4. 用户要求生图时直接调用 `nai_generate_image({"prompt":"scenery, forest, morning light"})`，等待并展示最终图片。无需先报价或校验，多张逐次调用。

默认 V5、23 步、Euler Ancestral、Karras、标准质量与 Heavy 负面模板；V5 引导为7，V4.5为5。`nai_get_presets` 可查看模板。多人图把场景、人数和风格放基础词，身份和动作放角色槽。`vibes` 或 `precise_references` 非空时自动走参考生图，默认 V4.5；显式模型不被替换，两种参考不可混用。

## 编辑和草稿

`nai_edit_image` 用 `operation` 选择 `img2img`、`inpaint`、`enhance`、`upscale`、`augment` 或 `encode_vibe`，配 `image_path`、`prompt` 和更多 `request` 字段。局部重绘加 `mask_path`（白重绘、黑保留），导演工具加 `tool`。`nai_prepare_image` 本地裁切、缩放或做遮罩，不生图、不联网。完整操作字段按需用 `nai_get_presets({"operation":"inpaint"})`。

用 `nai_draft({"action":"list"})` 找草稿，再 `nai_draft({"action":"read","draft_id":"实际ID"})` 读内容和版本；更新时调用 `nai_draft({"action":"update","draft_id":"实际ID","base_revision":3,"prompt":"scenery, forest"})`。保存不生图，冲突时重新读取。生成和编辑参数可平铺或放 `request`，重复字段以内层为准。

`nai_quote` 只在需要费用信息时调用，不是生成前置步骤；`offline:true` 本地校验参数。生成与远程编辑可能付费，遵循用户意图，未知费用不当作0。未知 POST 不手动重试；`nai_image_info({"action":"operation","record_path":"C:/images/receipt.json"})` 查看已有回执。`action:"recover"` 配 `source_path` 恢复可用请求，`action:"inspect"` 配 `path` 检查元数据与透明度，都不生图。

## 记住可复用资料

用户要求“记住/保存这个角色、画师、风格、预设”时，实际调用 `nai_library_save`，不要只在对话答应。先 `nai_library_read({"query":"森林水彩","kind":"preset"})` 查重；新建示例：

```json
{"name":"森林水彩","kind":"preset","prompt":"watercolor, soft edges, muted greens","notes":"森林背景用"}
```

将此对象传给 `nai_library_save`。角色用 `kind:"character"`，画师用 `artist`，风格用 `preset`。更新先 `nai_library_read({"id":"实际资料ID"})`，再传已读 `expected_revision`；删除用 `nai_library_save({"action":"delete","id":"实际资料ID","expected_revision":2})`。省略字段保留，数组整体替换。

`nai_gallery_curate` 收藏或归档作品；工作台 UI 负责浏览、导入导出和队列管理。Agent 没有持久队列提交、暂停或取消工具。仅在用户要求定时生图时用 `nai_schedule_save`，保存需 `schedule`；删除用 `{"action":"delete","id":"实际计划ID"}`，无需 schedule。先明确次数、张数和自动执行意图，未授权自动执行时保存为 disabled。

详细流程见 [工作台协作](workbench.md)。历史图像与费用观察仅按其证据范围解读，不能保证当前账户或新请求，见 [来源说明](sources.md)。
