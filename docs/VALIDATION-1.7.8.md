# AI Buddy 1.7.8 验收记录 / Validation

本轮为本机更新；未上传 GitHub。构建：`v1.7.8-2026-10-14T17-12-24-212Z`。

## 素材范围

- 11 位角色 × 18 套独立动作，共 198 段透明视频。待机、挥手、开心独立，审查中和认真独立。
- Claude 18 套已批准透明成品按原哈希复用。其余九位采用锁定的 162 套已批准源片与最新候选，连续 alpha、局部边缘修复、固定 BICUBIC 缩放后编码。四项节奏修订复用已批准时间映射。
- DeepSeek 保留 15 套原资源，恢复旧挥手，按授权新增独立开心和认真。两项新增动作通过技术和抽样视觉检查，不称为另一次用户审核。
- 80 张新表情按批准原图哈希接入；DeepSeek 原表情保留。
- 运行画布 576×624，约 60fps、透明 VP9 / CRF 18；视线使用无损方向静帧。动作运行资源合计 **2188.70 MiB**。

## 检查方法与界限

源片用户审核、透明成品检查、真实 App 验证分别记录。透明成品逐动作检查多个时间点的姿态，并查看原尺寸头部、应用尺寸棋盘、实际 VP9 解码的浅色与深色背景。内部颜色未改写、输出未越界等记录覆盖全部处理帧；编码透明度和颜色误差另有采样记录。

198 段均在 Chromium 中完整播放一轮，检查 100% / 75% / 50% / 25% 速度、暂停、恢复、情绪静帧和释放解码器。所有视频逐帧解码检查未发现空白帧，循环接头诊断未出现超出设定阈值的异常。自动指标不等于逐帧人工审美验收。

保留两处已批准源片的画面边界限制：Grok 跳跃的斧尖、GPT 看向鼠标的角尖在原视频中个别帧触顶。没有为补画这些像素擅自重新生成动作。

## 真实 Electron 与业务回归

- 11 位角色、198 个动作均通过桌宠演示；三轮切换和滚动检查解码资源释放及内存，没有持续增长到检查阈值。
- 跟随 / 固定、快速切换、资源失败保留当前角色、演示恢复，以及拖动和任务反馈期间的切换通过。
- 11 位角色 × 3 档显示缩放 × 跟随 / 固定，**66 个重启显示检查**通过。窗口宽度覆盖 900 / 1180 / 1600 / 1920，中英文设置布局正常。
- 实际桌宠窗口的快速绕圈输入测试覆盖 11 位，稳定阶段目标方向帧命中率均高于 90%，无持续视频 seek；另有独立渲染器三轮方向缓存检查。
- 首轮静止方向检查曾把 Seed 低头的闭眼锚帧 155 当作应显示帧；实际播放器按已登记避眨眼规则显示睁眼帧 148。已核对两张图和生产映射，修正测试预期后重跑，保留原失败记录；未修改素材或放宽播放判定。
- 全角色八表情、自定义立绘优先、CG 背景显隐、独立背景及多人剧场通过；固定 Claude 接收 Qwen 情绪时保持原回复，无角色前缀、无额外分类请求。
- 任务完成两轮跳跃、失败一轮、手动演示 / 拖动排队、隐藏 / 重现、去重及内部请求排除通过。
- DeepSeek Harness 已确认记录保持 **7,565 + 178 = 7,743 Token，只计一次**；原日志哈希不变，历史补录不庆祝。
- 费用刷新 1054 次画面采样，卡片位置变化 0，加载提示闪烁 0 次；估算口径保持按 Token 计算。
- **257 项自动测试通过，0 失败**。业务验收使用独立存档和模拟事件，未调用付费聊天或绘图服务；本地 H3 / RIFE 属于已授权素材制作。

## 交付与恢复

便携包包含软件运行资源、使用说明和可直接打开的“动作审核.html”。原片、透明原帧、失败候选、个人存档、密钥及测试缓存不进入便携包。

ZIP 逐文件校验、中文及空格路径解压启动、根目录 AI Buddy.exe、单实例，以及正式切换前的 1.7.7 归档和恢复启动，均在最终交付回执中单独记录。SHA-256 文件与 ZIP 一同交付。现有存档沿用 `local/data-v003`。

## English summary

This local update adds eleven switchable pets with eighteen independent actions each and eighty approved portrait expressions. Source acceptance, sampled transparency review, complete Chromium playback and actual Electron integration checks are recorded separately. All 257 automated tests pass. Runtime validation uses isolated profiles and mock events with no paid model calls. DeepSeek's new happiness and seriousness are authorized additions, not a new user-approval claim. The archive, restore and extracted-portable results are provided in the final delivery receipt. GitHub publication is separate.
