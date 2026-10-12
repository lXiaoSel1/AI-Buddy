# AI 酱 · AI Buddy

**让每一份 AI 工作都有记录，也有陪伴。**

简体中文 · [English](README.en.md)

AI Buddy 是一个 Windows 桌面应用：只读本机 AI 工具日志，整理 Token、预估费用和项目统计；同时提供桌宠、多角色 Galgame、独立聊天 API 和 CG 绘图连接。角色形象与实际回复模型分别选择。

本项目在 [JAdpp/dsh-whale-galgame](https://github.com/JAdpp/dsh-whale-galgame) 的 Galgame 引擎和界面基础上改编。感谢 **JAdpp** 分享多角色陪伴、任务事件和存档实现，也感谢下文列出的创作者与开源社区。

![工作概览](docs/screenshots/overview-zh-CN.png)

## 下载与开始

从 [Releases](https://github.com/lXiaoSel1/ai-buddy/releases) 下载 `AI-Buddy-1.7.1-Windows-x64.zip`，完整解压到可写目录，双击 **AI Buddy.vbs**。也可运行 **AI Buddy.cmd**，或版本运行目录中的 **AI Buddy.exe**。

- Windows 10/11 x64；本轮为免安装 ZIP，不提供安装程序。
- 包含 Electron 运行时，不需要另装 Node.js、Python 或图像工具。
- 请先解压，不要在 ZIP 内直接运行。不要只复制 EXE，保留目录结构。
- 首次启动会发现当前用户的常见日志目录。没有安装相关工具时仍可使用离线陪伴。
- 聊天、CG 和在线额度分别配置。**联网聊天重启后默认关闭**，自动 CG 首次默认关闭。
- 下载页提供 SHA-256。未进行商业代码签名，Windows 可能显示未知发布者。
- 当前仓库为私有审阅，下载需要仓库访问权限；是否公开由维护者决定。

本轮便携目录约 **572 MiB**，下载 ZIP 约 **363 MiB**，相比 1.7.0 的 ZIP 缩小约 **77%**。精确字节数与 SHA-256 以 Release 附件为准。

## 本地用量、项目与历史

支持 **Codex、Claude Code、Gemini CLI、Kimi Code CLI、OpenCode、Cline、Roo Code、DeepSeek Harness**。读取日志里实际报告的用量，缺失字段明确显示“未提供”，不会按文本长度猜 Token。

| 页面 | 用途 |
|---|---|
| 工作概览 | 用量、费用、额度三页；大数字与工具卡片，最多五项最近工作 |
| 项目用量 | 按总 Token、输入、输出、项目名排序，支持升降序 |
| 历史统计 | 日、周、月趋势，日期范围与时区，CSV/JSON 导出 |
| Token 检测 | 自动发现、自定义来源、读取状态和服务归属管理 |

工具、模型厂商、服务平台分别记录。Codex 是工具，OpenAI 是厂商或服务平台；模型名本身不能证明用了官方 API。历史索引持久化，重新启动会核对新增记录；首次建立、日志替换或索引修复可能较慢。

![项目用量](docs/screenshots/projects-zh-CN.png)
![历史统计](docs/screenshots/history-zh-CN.png)
![Token 检测](docs/screenshots/tokens-zh-CN.png)

## 费用与模型价格

费用按 **输入、输出、缓存读取和缓存写入 Token × 对应单价** 估算，不按请求次数收费。订阅工具中的数字是 API 等价参考金额，不是套餐账单。覆盖率以已覆盖 Token / 已记录 Token 计算；缺少用量或价格时保留未知，不补成零。

“费用 → 价格设置”列出实际使用的价格目录：按服务平台、模型名称、全部 / 本机使用过 / 自定义筛选；每页 50 条，可查看币种、每百万 Token 单价、缓存、上下文阶梯、来源和版本。可覆盖价格或手动更新 models.dev 目录；每日更新默认关闭。

![模型价格](docs/screenshots/prices-en.png)

## 可选在线额度

API 配置中的额度连接独立于聊天和绘图。支持 Codex、Claude、GLM/Z.ai、Kimi Coding、MiniMax Coding、DeepSeek API 余额，以及受支持账号的 Gemini CLI 能力与额度。各服务能返回的字段不同；不支持的账号会提示原因。

仅在明确启用后查询；不通过发送模型对话探测额度，不读取浏览器 Cookie。认证失败提示重新登录；临时失败保留上次成功值及原更新时间。

![额度连接（English）](docs/screenshots/quotas-en.png)

## 十一位角色与 Galgame

**DeepSeek、Grok、Seed、Kimi、Qwen、MiniMax、GPT、Gemini、Claude、GLM、混元（Hunyuan）** 各有立绘、背景、性格、语气、首次问候与 CG 外观设定。角色和聊天 API 独立，例如使用 Qwen 形象与 Claude API 对话。

- 每位角色的等级、聊天、背景、CG 图鉴、回收站和立绘显示状态独立。
- 支持自定义角色设定、立绘和背景，以及多角色小剧场。
- 使用 CG 作背景时默认隐藏立绘，避免出现两个角色；工具栏可手动显示 / 隐藏，也可恢复自动模式。
- 切换角色恢复该角色自己的背景，不沿用上一位角色的 CG。
- CG 图鉴右键可移入回收站，支持撤销和恢复；本轮不自动永久删除图片。

![Galgame](docs/screenshots/galgame-zh-CN.png)
![CG 背景自动隐藏立绘](docs/screenshots/cg-background.png)

## 聊天与 CG 分别接入

在 **API 配置** 管理已保存连接；“保存并使用”立即激活，“仅保存”不切换。通用设置只负责选择当前连接及开关。

| 类型 | 支持的协议 / 通道 |
|---|---|
| 聊天 | 本机 Codex 登录、OpenAI Chat Completions / Responses、Gemini 原生、Anthropic Messages |
| CG | Codex 内置图像、OpenAI Images 兼容、Gemini Interactions、通义万相生成 / 编辑及异步接口 |

可选择预设或填写自定义兼容服务地址和模型 ID。第三方服务兼容程度、模型权限和参考图限制由服务端决定。外部密钥通过 Electron safeStorage 加密保存在本机；Codex 通道需要本机可用的 Codex 登录。

CG 自动生成可选择升级纪念图与剧场合影。联网聊天开启时，每张新的升级 CG 可额外调用一次聊天模型设计主题，失败使用本地角色主题组合。主题和绘图连接分别固定保存，重试复用已有主题。模型调用可能产生服务费用。

当前 CG 构图规则：男性第一人称，男性角色本人不入镜；允许合理的手部互动、文字及服装 Logo，不限制为一只男性手。

![CG 图鉴](docs/screenshots/cg-gallery.png)

![API 配置](docs/screenshots/api-zh-CN.png)

## 桌宠与动作

已确认的约 **60fps 透明 VP9 WebM**（画质优先 CRF 18），15 个展示动作、18 个兼容逻辑动作。支持拖动、透明区域点击穿透、缩放、25%–100% 播放速度。任务完成与失败分别排队，动作和气泡同步；拖动期间保留待播反馈。

动画由桌宠与展示页共用同一份视频；方向跟随和情绪静止画面保留少量无损 WebP。15 套视频约 38.8 MiB，加上静帧约 87.2 MiB，不在发行包中重复附带整套 PNG 动画。原始制作素材不随应用分发。

![动作展示](docs/screenshots/actions-zh-CN.png)

## 主题与语言

通用设置提供 11 个以角色命名的主题，配色来自对应立绘；可固定选择，也可跟随当前角色。**DeepSeek 保持原来的深蓝设计，其余 10 个主题使用柔和中深色。** 界面、窗口标题栏和桌宠气泡同步变化，人物图片本身不染色。

![柔和中深色：Claude](docs/screenshots/theme-claude.png)
![保留原色：DeepSeek](docs/screenshots/theme-deepseek.png)

支持简体中文和 English。切换影响界面、内置默认设定及之后的新对话；已有聊天、历史 CG 和用户自己填写的文案保持原文。

![通用设置](docs/screenshots/settings-zh-CN.png)
![English interface](docs/screenshots/settings-en.png)

## 数据与隐私

默认只读本机日志，监控本身不调用模型、不修改原工具文件。软件存档位于安装目录 `local/data-v003`；更新时保留此目录。分享日志、导出或截图前请自行检查项目路径和账号信息。

发行 ZIP 不包含开发者的存档、密钥、聊天、个人 CG、日志或浏览器配置。README 截图来自独立测试存档；空数据界面及开发验收 CG 不代表真实账号用量。

## 源码构建

本次测试范围与已知边界见 [1.7.1 验收记录](docs/VALIDATION-1.7.1.md)。

见 [构建说明](docs/BUILD.md)。源码需要 Node.js 24 和 npm，Windows 品牌运行包需要 Electron 44.6.0。动画与内置资源从同版本发行 ZIP 提取；不需要重新生成图片或视频。

## 致谢与许可

- [JAdpp/dsh-whale-galgame](https://github.com/JAdpp/dsh-whale-galgame)：核心 Galgame 来源，特别感谢原作者。
- [Small-tailqwq/dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale)、[f0909172434/dsh-deepseek-girl-pet](https://github.com/f0909172434/dsh-deepseek-girl-pet)：DeepSeek 角色素材、背景与桌宠来源链。
- [上善](https://www.pixiv.net/users/62155430)、[ZipZipPipe](https://www.pixiv.net/users/18604994) 及 [AI 拟人图库](https://genderswapai.com/zh-CN/ai-gijinka/gallery)：角色创作与形象参考。十套新增立绘及背景由图像模型基于已选参考制作，不是原作者重新授权的官方形象。
- [ccusage](https://github.com/ccusage/ccusage)：本地统计与计数对照；[CodexBar](https://github.com/steipete/CodexBar)：额度展示与提供方适配参考。
- [models.dev](https://models.dev)：价格目录；[Electron](https://www.electronjs.org/)、[React](https://react.dev/)、[esbuild](https://esbuild.github.io/)：运行和构建基础。
- [RIFE](https://github.com/hzwer/ECCV2022-RIFE)：动画补帧流程；MiniMax H3 用于已授权的动作生成，运行应用无需生成工具。

代码许可见 [LICENSE.md](LICENSE.md)。**图片不统一适用 MIT**：上游部分默认图片使用 CC BY-NC-SA 4.0；新增参考形象的权利与分发条件需按来源分别确认。详细作者链、许可正文及素材说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目与所列 AI 服务商无官方隶属或背书关系。
