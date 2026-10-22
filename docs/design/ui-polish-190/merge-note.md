# UI polish 1.9.0 · 合并说明（给 Codex）

分支 `claude/ui-polish-190`，基线 `codex/release-1.9.0` @ 39eee92（写这份说明时该分支没有新提交，可以直接快进合并）。分支上没有推送、没有改版本号、没有发版，这些仍由你和用户决定。

设计稿：https://claude.ai/artifact/VNnLBZuNRWH1fLWfouw4nt（59 个界面，用户已全部批准）。界面编号和批次的对应见同目录 `README.md`。

## 提交

| 提交 | 内容 |
|---|---|
| 378e505 | 合入「关于」卡片 97c25dd |
| c0ff87d | B0 地基：11 套色板 `src/theme-palettes.mjs`（由 `scripts/extract-theme-palettes.mjs` 从设计源生成）、`--buddy-*` 令牌、去掉 tone 机制、名牌色 `src/plate-colors.mjs`、`src/ui-icons.mjs`、`src/ui-controls.mjs`、`assets/theme/<id>/` |
| d485826 | B1 外壳与工作概览、5 个统计弹窗；窗口和托盘图标跟随桌宠（`src/brand-icons.mjs`、main.mjs `syncBrandIcons()`） |
| 4af9857 | B2 项目用量、历史统计、API 配置、Token 检测、通用设置、动作展示（`src/workspace.css`） |
| ddac4b2 | B3 Galgame 私聊（`src/galgame-design.mjs`）；旧小剧场挪进「对话历史」只读 |
| 3ba3e7c | B4 角色与对话、群聊（`src/companion-design.mjs`） |
| 64e8d1a | B5 桌宠（`src/pet-badge.mjs`、`src/pet-menu.mjs`、`assets/pet-glove-tint/`） |
| 4e693b1 | README 截图重拍（29 张，同名同尺寸） |

## 需要你留意的行为变化

- **群聊离线时不能发送**：群聊对话框在联网聊天关闭时禁用输入，并给「开启联网聊天」按钮。以前可以发出去再报错。
- **群聊的联网开关和「对话模型」移进群聊顶栏**；dashboard 里舞台上方的 `.game-mode` 条已删除。「管理群聊」「回到私聊」从对话框挪到顶栏工具栏。
- **成员聊天连接选完即保存**（`companion-character-save`），没有逐行「保存」按钮；保存失败会恢复原选择。
- **合影的提示词策划模型选完即保存**（`companion-group-photo-planner`），去掉了「保存选择」按钮。指定了连接但联网关闭、或连接失效时，「生成合影」禁用。
- **对话历史可以预览非当前会话**：通过 `companion-conversation-export {id}` 只读读取，不切换当前会话；收藏和更正只对当前会话开放。
- **桌宠气泡的 DOM 变了**：`.bubble` 的 textContent 不再等于反馈原文，原文保存在 `.bubble[data-text]`。`scripts/verify-dsh-app-180.cjs` 已改成读 `data-text`。
- **桌宠状态条文案**改为经过 `t()` 的短文案（「AI 酱 · 陪着你」「工作中 · 2 个会话」「等你回应 · Codex」），点状态条打开工作概览，日志出错的气泡点一下打开 Token 检测。
- **右键菜单**从 1 项扩成 5 项；新增 `PetActivityClock.sleepNow()`，只在醒着且空闲时生效。托盘菜单加了一条分隔线。
- **抛掷落点圈**来自新的 `PetMotion.landing()`，与真实飞行一致；`preview()` 仍是 13 个点，没有改。
- **`validation-feedback` 新增 `tool` 参数**（仅 `--validation=1`），让本地验证能发出和正式环境相同的气泡文案。

## 删除的代码

- B3：`PluginSettingsCard`、档案抽屉里的 profile 编辑器、`skitPicker`、castStage / sideStory 的界面路径（都已经进不去）。后端的 side-story 动作和测试没动。
- B4：群聊舞台里从未被打开的「全员总览」对话框。

## 样式结构

- 新样式都用主题令牌，`test/theme-css-190.test.mjs` 给每个文件设了颜色字面量上限（只降不升），并检查每个 `var(--x)` 都有定义。
- `GroupStageCSS` 和 `GroupCgCSS` 不再由组件自己注入 `<style>`，改为加入 Galgame 的 CSS 列表；`CompanionDesignCSS` 排在最后。
- CompanionCSS 里旧的 `.buddy-dialog button` 规则已收窄为只作用于普通按钮（`:where(:not([role])…)`），否则会覆盖分段控件和开关。
- `appearance.css` 里旧的 `:is(...)` 覆盖层特异性很高，新加样式时注意先清掉对应选择器（B0–B2 已清理过一轮）。

## 构建

`scripts/build-public.mjs` 复制 `assets/theme/` 和 `assets/pet-glove-tint/`，并写进 install index 的 shared。`assets/pet-glove-v2/` 原样保留，作为未着色的后备。袖口着色图由 `docs/design/ui-polish-190/tools/make_glove_tints.py` 生成。

## 验证

- `npm test`：725/725。
- 隔离实例截图脚本（独立 `--data`、空 `--roots`、独立 `--pipe`、透明窗口、本地假模型，无外网、无 API key）：B4 23 项、B5 14 项检查全部通过。脚本在 `E:\AI-Video-Project\integration\ai-buddy-190-ui-polish-20261021\`（`shots-b*.mjs`、`shots-readme.mjs`）。
- `verify-character-gaze-input-180`：11 个角色全部通过。
- `verify-dsh-app-180`：把动作卡数量改成 24 后全部通过（见下）。

## 已知问题（基线 r30 上同样存在，没有在本分支修）

- `verify-pet-display-180` 和 `verify-dsh-app-180` 等待 18 张动作卡，但动作展示页实际是 24 张（日常动作加互动动作片段），r30 基线也是 24。
- `verify-pet-display-180` 第 31 行「拖动时不切换角色」的断言在 r30 基线上同样失败（实际已切到 claude）。
- 在 worktree 里跑任何 `verify-*.cjs` 之前需要 `local/candidate-build.json`（已 gitignore），脚本启动时先读它。

## README 待办（我负责，需先和用户确认文字方案）

- 「小剧场」一节和 `side-story-*.png` 描述的入口已经不存在（群聊取代了小剧场，旧记录在「角色与对话 › 对话历史」里只读）。README 也还没有群聊章节。
- `cg-background.png`、`cg-gallery.png` 需要真实生成过的 CG，隔离实例里拍不出来，这次保留原图，画面里是旧界面。
