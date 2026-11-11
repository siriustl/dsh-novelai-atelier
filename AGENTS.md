# AGENTS.md

给在本仓库动手的编码 Agent。这里只放**会反复踩的约束**：不放教程，不放版本号，不放会腐烂的数字。
需要具体数值时用命令查或看指针文件（版本 → `package.json`；工具清单 → `README.md`；测试数 → `vitest run` 的真实输出）。

## 按任务路由

| 要做什么 | 先读 |
| --- | --- |
| 接手、恢复上下文 | `HANDOFF.md`：当前状态、安装方式、未做项、已知陷阱 |
| 改工具、请求、计费、存储、队列 | 对应的 `src/core` 或 `src/workbench` 模块 + `tests/` 里同名用例 |
| 改右侧工作台界面 | `client/panels/*.tsx` 与 `client/styles.ts`，复用既有组件 |
| 查某个决定怎么来的 | `CHANGELOG.md`、`docs/verification-*.md` |

`HANDOFF.md`、`CHANGELOG.md`、`docs/` 是本地文件，`.gitignore` 有意排除，缺失属于正常情况。

## 接活先立目标

用户每派一轮活，**先用 `create_goal` 把这一轮的要求写成一条目标再动手**：按条列出要做什么、不要做什么，别只记在对话里。改到一半不确定时用 `get_goal` 对一遍原话，防止漏项。

- 用户中途补充要求：用 `update_goal` 的 `edit` 把新要求并进目标，别只在心里记。
- 会话重启或续聊后目标是未激活的：用户说"继续"就先 `update_goal` 的 `resume`，然后接着做，不要重头再来。
- 目标里的约束（不花 Anlas、不碰用户数据、不自动提交）与下文硬约束同等生效。

## 代码地图

`src/index.ts` 宿主入口（`name`/`inject`/`Config`/`apply`）；`src/tools.ts` 模型可见工具；`src/core/` 请求与计费；`src/workbench/` 工作台后端；`src/bootstrap.ts` 按需启用；`src/agent.ts` preset 变体；`client/` 浏览器 UI；`tests/` vitest；`lib/` 构建产物（不要手改）；`assets/` 随包发布的资源。

工作区被桌面 profile 用 `link:` 挂载，`lib/` 就是用户正在跑的代码：构建失败必须当轮说清楚。

## 硬约束

- **不花真实费用**：未经用户同意不调用 `nai_generate_image` / `nai_edit_image`（真实请求扣 Anlas）。验证用 `nai_quote`（离线）、`nai_prepare_image`、测试桩或本地合成图。
- **不碰用户数据**：`~/.novelai-workbench`、`~/Pictures/NovelAI`、`secrets/`、profile 里其它插件的配置。删除、迁移、批量改资料一律先问。
- **不动用户进程**：不重启、不杀 DSH，不另起替代服务器占用现有端口。
- **不伪造回执**：失败就报失败，不静默降级（例如 img2img 失败转 txt2img）、不把部分成功说成完成。
- **不改对外契约**：工具名、参数名、返回结构、激活状态键改名等于破坏已装用户，先确认再改。
- **不堆防御性代码**：不为不可能失败的分支包 try/catch，不为假想需求加开关，不重复多层校验。

## 命令

Node.js 与 pnpm 需安装并加入 PATH。依赖版本约束见 `package.json`。

`typecheck`、`test`、`build`（`& $node $pnpm run <script>`）；`verify:package`、`verify:ui`（后者支持 `--smoke`，报告写 `.nai-verification/<版本>/`）。`verify:package` 与 `verify:ui` 需要先 `build`。

## 验证梯度

| 改动 | 至少做到 |
| --- | --- |
| 文档、注释 | 不跑测试；动了随包发布的 `README.md` / `INSTALL.md` 则必须重新打包 |
| 局部 UI、文案、样式 | `build` + 相关 `vitest run tests/<文件>`，视觉不确定时 `verify:ui --smoke` |
| 工具、核心请求、存储、计费、队列 | 全量 `test` + `typecheck` + `build` + `verify:package` |
| scope、preset 组合、宿主兼容层 | 上面全部 + Electron 运行时探针 + 真实重启验证 |

以真实退出码判定，不看输出尾部；已知假失败见下节。不许只跑一个用例就说"全绿"。

## 发布

`pack --pack-destination release` → `verify:package` → 用 tgz 装一次并重启验证 → 把字节数与 SHA256 记进 `HANDOFF.md` 和对应 `docs/verification-<版本>.md`。改过 `README.md` / `INSTALL.md` 必须重新打包，否则包内文档过期。

版本号两处同步：`package.json` 与 `src/version.ts`，只在发布批次递增。

## 代码与提交

提交由用户明确要求触发：默认攒成批次留在工作区，不自动 commit、不推送。提交信息英文、Conventional Commits、一行、小写开头、无句号。代码与文档用中文，风格跟随周边实现，不做无关重构。

工具变化同步三处：`src/tools.ts`、`README.md` 工具表、`tests/` 用例。

## 本机陷阱

- PowerShell 5.1 不支持 `??` / `?.`；判定退出码用 `$out = & $node $pnpm test 2>&1 | Out-String; $LASTEXITCODE`。
- 命令接进 `| Select-Object` 会把成功命令报成 `[exit code: 1]`，是管道假象。
- 控制台把 UTF-8 中文显示成乱码，文件本身正常；用 read 工具看文件。
- `.tgz` 不是 zip，用 `tar -tzf` 列内容。
- `dsh.cmd plugin ...` 每次都会因 `dsh-find-plugin` 与本宿主不兼容的告警以退出码 1 结束，操作其实成功；`--profile desktop` 必须在子命令前。
- 桌面 profile 不能 `--dump-config`，宿主行为只能靠重启验证。
- 删除或移动前先打印并核对解析后的绝对路径。

## 写文档的规矩

- 不写版本号、文件数、测试数、行数；用指针或命令代替，避免下次改动就要同步一遍。
- 同一事实只写一遍，其余用链接引用，不复制。
- 只写实际踩过会再犯的坑；不写"以防万一"的规则。
- 用户可见文档写动作和结果，不用 emoji、不写营销词、不复述同一个限制。
- 本文件保持一屏左右；超了先删，再考虑移出到子文件。
