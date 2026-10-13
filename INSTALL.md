# DSH NovelAI Atelier 0.15.3 安装

## 推荐：桌面 GUI

1. 将 `dsh-novelai-atelier-0.15.3.tgz` 放到本机任意稳定目录。不要解压，不需要下载源码或运行构建命令。
2. 打开 DeepSeek Harness 左侧的「插件」页面，点击「添加插件」。
3. 在「包名或地址」填写文件的绝对路径，例如 `D:\Downloads\dsh-novelai-atelier-0.15.3.tgz`，然后执行安装。该界面使用路径输入，不提供文件上传控件；相对路径不支持。
4. 安装完成后点击「立即启用」。GUI 的添加操作默认只安装，不自动启用。
5. 首次安装通常可热应用。为确认 Host、原生依赖及网页构建版本一致，建议完整退出 DSH 再打开。升级已有同名插件、界面提示「下次启动生效」或入口未出现时，必须完整重启；刷新浏览器页面不可靠。
6. 在会话右侧栏打开「NovelAI 生图工作台」，设置自己的 NovelAI `pst-…` 令牌。AI 构思默认跟随 DSH 已配置模型，不需要另配语言模型 Key。
7. 让 Agent 按需启用 NAI 工具并调用 `nai_workbench_status({info:true})`，确认 `runtime_version` 为 `0.15.3`。新建默认计划应先保持停用，确认请求、张数和执行次数后再启用。

首次安装需要联网下载依赖。安装文件不包含 NovelAI 订阅、额度、令牌、个人资料库或图片。不需要 Python，也不需要全局安装 Node / pnpm 开发工具；DSH 使用自己的运行环境。

## 桌面自带 CLI

普通独立安装的 DSH CLI 不管理保留的 `desktop` profile，应使用桌面程序自带的启动脚本。以默认 Windows 安装位置为例，在 PowerShell 执行：

```powershell
& 'D:\Program Files\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'D:\Downloads\dsh-novelai-atelier-0.15.3.tgz'
```

安装位置不同，替换启动脚本路径；插件路径必须替换成实际的压缩包绝对路径。

**`--profile desktop` 必须放在 `add` 前面。** `plugin add --profile desktop ...` 会把后面的参数转交包管理器，不能正确选择 profile。

CLI 首次添加新的 bundle 依赖会自动登记启用；已有但被关闭的 bundle 再次 `add` 不会自动恢复启用，请在 GUI「插件」页启用。安装覆盖现有同名依赖后完整退出并重新打开 DSH。

## 兼容与迁移

- 验证宿主：DSH `0.2.0-rc.2`、Cordis `4.0.4`，Node `^22.19.0 || >=24.0.0`。Sharp `0.35.5` 与验证宿主的 libvips `8.18.7` 对齐。
- 遇到 peer dependency 不兼容时不要强行开版本豁免；先核对 DSH 与插件版本。其他宿主版本尚未宣称全部兼容。
- 已有工作台数据默认仍在 `~/.novelai-workbench`，输出仍在用户配置目录。升级不导入开发者的测试数据，不删除用户数据，也不改变默认 Agent 模式。
- 插件默认工具有 15 项。普通模式只有 `nai_use_tools` 入口，调用 `nai_use_tools({enabled:true})` 在当前会话加载完整工具；也可以新建「NovelAI Atelier」模式会话。
- 内置指南使用统一的 `prompting` 通用核心，模型和构图详情按需读取。
- 旧 AI 计划若已经将资料词写进手工基准提示词，升级不会猜测并删除这些文字。取消绑定时也应核对基准草稿与固定片段。新计划把资料身份保持在冻结配方中，不再污染基准请求。

## 卸载与隐私

停用插件前先停用计划、暂停队列，并等待已提交请求结清。取消或关闭 DSH 不代表 NovelAI 服务端没有执行或扣费。移除插件依赖不会自动删除个人数据和图片；备份或清理应由用户明确决定。

分发与安装时只需提供标准的 `.tgz` 发布包。请勿将本机的私有工作台目录（`~/.novelai-workbench`）、凭据目录（`secrets/`）或全库备份对外传播。此外，从画廊或资料库导出的作品原图可能保留了生成提示词、EXIF 信息、PNG 文本块和隐藏 Alpha 元数据，对外公开前请自行核对。
