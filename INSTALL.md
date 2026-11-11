# 安装与升级

适用于当前发布版本。tgz 包不含令牌、资料或图片，也不需要 Python、Node 或 pnpm——DSH 自带运行环境。

## 首次安装

### 桌面 GUI

1. 把下载的 `dsh-novelai-atelier-<version>.tgz` 放到本机一个稳定目录。**不要解压。**
2. 打开 DSH 左侧「插件」页 → 「添加插件」。
3. 「包名或地址」填该 `.tgz` 文件的绝对路径。该输入框只接受路径，不支持相对路径或上传。
4. 安装完成后点「立即启用」——添加和启用是两步。
5. 完整退出并重新打开 DSH。首次安装常常能热应用，但 Host、原生依赖和前端模块要一起生效，刷新页面不算数。

### 命令行

DSH 桌面版保留的 `desktop` profile 只由桌面程序管理，独立安装的 CLI 管不到。用桌面自带的启动脚本：

将 `$dsh` 设为本机 DSH 安装目录下的 `resources/runtime/cli/bin/dsh.cmd`，再执行：

```powershell
& $dsh plugin --profile desktop add '<absolute-path-to-tgz>'
```

`--profile desktop` 必须写在 `add` 前面，否则参数会被直接转交给包管理器。CLI 首次添加新 bundle 会自动登记启用；已被手动停用的 bundle 再次 `add` 不会自动恢复启用。

## 装好之后

1. 在会话右侧栏打开「NovelAI 生图工作台」，在设置里添加接口：官方填 `https://image.novelai.net` 加自己的 `pst-…` 令牌；中转接口填它给的地址（通常以 `/v1` 结尾）和 key。可保存多条；非官方接口可勾选「小图免费（类 Opus）」、填拼车人数（V5 额度按 1/N 估算）和自填订阅备注；想让工作台读到 V5 百分比时，在「站点额度查询」选画喵预设并粘贴站点登录令牌。
2. 让 Agent 调 `nai_workbench_status({info:true})`，确认 `runtime_version` 为 `0.19.4` 且工具为 16 项。
3. AI 构思默认跟随 DSH 已配置的模型，不需要另配语言模型 Key。
4. 新建的计划默认停用，先核对请求、张数和执行次数再启用。

## 升级

覆盖安装同名插件后完整退出并重开 DSH；界面若提示「下次启动生效」，同样需要重启。

从旧包名 `nai-atelier` 迁移时：

1. 停用计划、等待队列结清，备份 profile 的 `package.json`、`pnpm-lock.yaml`、`cordis.patch.yml`。
2. 在「插件」页移除旧 bundle（或 `dsh plugin --profile desktop remove nai-atelier`）。
3. 若 profile 的 `cordis.patch.yml` 里有用 `file:///…/lib/host-live.js`、`lib/agent-live.js` 直接挂载工作区代码的条目，一并停用——它们不受包管理，会和 tgz 里的 Host 重复挂载。
4. 安装新 tgz 并启用，完整重启 DSH，再按上一节确认版本与工具数。

不要同时保留两个 bundle，也不要为此删除 `node_modules`、手改 Junction 或清理 `~/.novelai-workbench`。

## 开发安装

改代码时不必反复打包，直接把 profile 指向工作区：

```powershell
& $dsh plugin --profile desktop add 'link:<absolute-path-to-workspace>'
```

改完先 `pnpm run build`，Host 侧改动需要完整重启 DSH，客户端改动刷新页面即可。发布前用 `pnpm pack` 出 tgz，再按上面的流程验证一遍实际发布物。

## 兼容性

- 验证宿主：DSH `0.2.1-rc.2`、Cordis `4.0.5`、Schemastery `3.18.5`，Node `^22.19.0 || >=24.0.0`。
- peer 依赖允许同一兼容系列的 Cordis `^4.0.4`、Schemastery `^3.18.4`。遇到 peer 冲突先核对版本，不要强开版本豁免。
- 其他 DSH 版本尚未声明兼容。

## 数据与卸载

- 工作台数据：`~/.novelai-workbench`；图片输出目录在设置里配置，默认 `~/Pictures/NovelAI`。
- 卸载或移除插件不会删除这些数据，也不会删除令牌。需要清理请自行决定。
- 对外分享时只给 `.tgz`，不要带上私有工作台目录、`secrets/` 或整库备份。从画廊导出的原图可能保留提示词、EXIF、PNG 文本块和 Alpha 元数据。

## 常见问题

- **入口没出现**：确认 bundle 已在插件页启用，然后完整重启 DSH。
- **装的是旧版本**：`nai_workbench_status({info:true})` 的 `runtime_version` 是最终依据，界面缓存不可靠。
- **停用插件就算停了计费？** 不是。请求已提交到 NovelAI 就仍会执行和扣费，停用前先等队列结清。
