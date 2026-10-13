# DSH NovelAI Atelier

> 面向 **DeepSeek Harness** 智能体生态的 NovelAI V5 / V4.5 图像生成工具集与嵌入式工作台插件。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.15.3-green.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-DeepSeek%20Harness-orange.svg)](https://github.com/siriustl/dsh-novelai-atelier)
[![Tests](https://img.shields.io/badge/tests-596%20passed-brightgreen.svg)](tests/)

---

## 🌟 核心特性

- 🤖 **15 项 Agent 原生工具**：文生图（`nai_generate_image`）、全能图像编辑（`nai_edit_image`：含局部重绘、全图重绘、增强、2倍放大、导演线稿、Vibe编码）、参数回执恢复与检查（`nai_image_info`）、资料库与草稿管理等，专为大语言模型 Tool Calling 精心设计与压缩。
- 🎨 **无缝嵌入式右侧工作台**：深度注入 DSH 右侧栏抽屉（`sidebarRightTabs`），无需额外开启独立 Web 端口或后台服务，与当前 AI 会话实时共享内存草稿与上下文。
- 📚 **模块化资料库（Library）**：支持角色本体定义、形态分支（服装/外形差异化继承）、画师风格混合、负面提示词解耦与例图可视化管理。
- ⏱️ **自动化生图计划（Schedules）**：支持单次、每日、定时间隔以及固定请求/AI 智能构思的自动化任务队列，内置额度与运行次数安全预算保护。
- 🛡️ **工业级健壮性**：
  - 攻克 Windows 文件系统并发原子锁（`EPERM/EACCES/EBUSY`）重试机制，防止回执保存被文件系统瞬间竞争占用；
  - 完善的离线回执状态机校验与参数恢复能力，防止断网与未知结果时重复扣费；
  - 52 个测试套件、596 项自动化单元与集成测试全绿保障。
- 🔒 **本地优先与隐私安全**：NovelAI Token（`pst-...`）本机安全加密隔离存储；所有生成图片、元数据与工作台数据严格保存在本地用户目录。

---

## 📦 安装与配置

### 推荐：桌面客户端 GUI 一键安装

1. 从 [Releases 页面](https://github.com/siriustl/dsh-novelai-atelier/releases) 下载最新安装包 `dsh-novelai-atelier-0.15.3.tgz` 并保存到本地稳定路径。
2. 打开 DeepSeek Harness 左侧「插件」页面，点击「添加插件」。
3. 在「包名或地址」输入安装包的绝对路径（例如 `D:\Downloads\dsh-novelai-atelier-0.15.3.tgz`），点击安装。
4. 安装完成后点击「立即启用」。
5. **建议完整退出并重新打开 DSH**，以保证宿主进程、原生图片依赖与前端模块完全加载生效。
6. 打开右侧抽屉栏的「NovelAI 生图工作台」，在设置中配置你的 NovelAI `pst-…` 令牌。

### 命令行（CLI）安装

在桌面客户端自带的 CLI 环境中执行（PowerShell 示例）：

```powershell
& 'D:\Program Files\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'D:\Downloads\dsh-novelai-atelier-0.15.3.tgz'
```

> 详细的配置与版本迁移说明请参阅 [安装指南 (INSTALL.md)](INSTALL.md)。

---

## 🚀 常用生成与协作流程

### 1. 智能体按需启用
- 普通模式下默认仅加载轻量入口 `nai_use_tools`，不会占用额外 Context Token；
- 当需要生图或编辑时，AI 自动或手动调用 `nai_use_tools({enabled:true})` 挂载完整能力；
- 也可以直接新建「NovelAI Atelier」专属预设模式会话。

### 2. 文生图与编辑
- **单张文生图**：调用 `nai_generate_image`，默认采用 V5 Full、23 步、Euler Ancestral、Karras 调度、CFG 7，生成完毕直接返回图片路径。
- **图像编辑与重绘**：通过 `nai_edit_image` 完成全图重绘（`img2img`）、局部重绘（`inpaint`，白色涂抹重绘）、细节增强（`enhance`）、2倍无损放大（`upscale`）或风格提取（`encode_vibe`）。
- **参数与回执回溯**：使用 `nai_image_info` 的 `recover` 操作可直接从已生成的 PNG 或回执 JSON 中完美还原所有提示词、Seed、模型参数及参考图哈希。

### 3. 数据与隐私安全规范
- **默认工作台数据目录**：`~/.novelai-workbench`
- **默认图片保存目录**：`~/Pictures/NovelAI`
- **分发与共享提示**：对外分发插件时只需提供官方打出的 `.tgz` 发布包。请勿将本机的私有工作台目录、凭据目录（`secrets/`）或整库备份对外共享。从画廊导出的作品原图可能包含提示词、Seed 及 EXIF 元数据，对外公开发布前请注意核对。

---

## 🛠️ 本地开发与质量验证

本项目采用严格的工程规范与测试驱动验证：

```bash
# 类型检查
pnpm run typecheck

# 运行自动化测试（52 文件 / 596 测试用例）
pnpm test

# 构建客户端与服务端 bundle
pnpm run build

# 验证包导出与安装包完整性
pnpm run verify:package
```

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。
