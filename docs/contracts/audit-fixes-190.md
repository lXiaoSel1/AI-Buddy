# 1.9.0 审计修复：后端与 UI 接口约定

分支：`claude/audit-fixes-190`，从 d412ff0 拉出。

后端负责：状态、IPC、动作和事件。UI 会话按本文档实现界面。
下表中的字段名、动作名和状态值都是约定，修改前双方需先确认。
新增的文案只追加到 `locales/en.json`，不改动已有词条。

## 文件归属

| 归属 | 文件 |
|---|---|
| 修复分支（后端） | `storage`、`model-router`、`api-transport`、`companion-service`、`companion-store`、`companion-life`、`companion-life-service`、`companion-life-archive`、`companion-memory`、`companion-media`、`media-store`（新增）、`cg-service`、`monitor`、`token-monitor`、`pet-interactions`、`preferences`、`galgame-host`、`adapted/game-core.ts`、`main.mjs`、`preload.mjs`、`index.html`（只改 CSP 那一行）、`test/audit-*` |
| UI 会话 | `general-settings`、`companion-ui`、`companion-life-ui`、`group-*`、`pet-interaction-view`、`action-gallery`、`dashboard`、`adapted/galgame-client.ts`、CSS |

## 接口

| 项 | 后端提供 | UI 要做 |
|---|---|---|
| B6 人生切换没有完成 | `companion` 视图中的 `lifeRecovery: {characterId, kind, at, error, attempts, archiveAvailable} \| null`；三个动作 `companion-life-transaction-retry` / `-rollback` / `-abandon`，参数 `{characterId}`，返回 `{ok}` 或 `{ok:false, error}` | 在被锁住的角色上显示提示条："人生切换没有完成"，附上原因和三个按钮：重试、回到切换前（`archiveAvailable` 为 false 时禁用）、放弃这次切换（保留现在的样子）。其他角色不受影响 另外：在这个角色的切换处理完之前，其他角色的"恢复"和"重置人生"会返回错误，错误文字里写明要先处理哪个角色；保存存档、聊天等其他操作不受影响 |
| B6 安全模式 | `settings:get` 返回 `startupFailure: {scope:'companion', message, at} \| null` 和 `safeMode: boolean`。安全模式下所有 `game:action` 都返回 `{ok:false, code:'COMPANION_SAFE_MODE', error}`；面板会以 `#safe-mode` 打开 | 安全模式页：说明陪伴功能已停用并显示原因；桌宠和用量监控照常可用 |
| D2-3 缺失的 CG | 保存、重置、恢复人生时可能返回 `{ok:false, code:'LIFE_ARCHIVE_MISSING_CG', missing:[{cgId, label, at, level, kind, groupId, ref}]}`（label、level、kind、groupId 可能为 null；同一 CG 只列一次）；动作 `companion-life-clean-missing-cg {characterId, cgIds}` 返回 `{ok, removed}`。后端会逐条复核：只有完整图片文件确实丢失的记录才会被删除（只丢了缩略图的 CG 不算缺失，存档时用完整图代替），`removed` 是实际删除的 ID | 弹窗列出缺失的 CG（名称、时间、所在会话），附"清理缺失记录"按钮。清理完成后提示用户重新保存 |
| B2 输出上限 | 偏好项 `maxOutputTokens`，取值为 `'auto'` 或 256–65536 的整数，默认 8192，通过现有的 `settings:set` 读写 | 通用设置新增"模型最多输出（tokens）"：数字输入框，外加"自动"选项。说明文字：按实际输出计费；数值越大越不容易被截断；"自动"表示交给模型自己的默认值 |
| B2 截断 | 再次截断时，流式请求抛出 `MODEL_OUTPUT_TRUNCATED`（error.message 中带说明） | 显示"回复被截断，可以调高通用设置里的输出上限后重试" |
| B3 / B5 群聊状态 | `groupRuntime.status` 新增 `'waiting-model'`（排队中）和 `'waiting-life-save'`（附 `waitDeadline`）；超时后状态为 `failed`，并带 `canRetry` | 分别显示"排队中"和"正在保存人生存档，稍后自动发送"（可附倒计时）；失败时提供重试 |
| B7 记忆读取失败 | `companion-memory-view` 返回的 `memory.syncError`：`{at, message}` 或 `null`。某个角色的原文无法读取时，日终整理会跳过这个角色，其他角色照常整理；导入时被修正过时间的消息带 `timeRepaired: true` | 记忆面板在 `syncError` 不为空时显示一行提示（例如"这个角色有记录无法读取，日终整理已暂停"）。`timeRepaired` 可以不显示 |
| M-1 面板隐藏 | preload 提供 `whale.onPanelVisibility(cb)`，cb 收到 `{visible:boolean}`，在面板 hide 和 show 时触发 | 隐藏时释放动作图库渲染器的全部 target 和 prepared 资源、暂停预览、清空静帧缓存；显示时按需重建 |
| M-2 动作图库 | 无 | 卡片默认显示一张静帧；pointerenter 或键盘 focus 时开始播放，pointerleave、blur 或移出视口时释放。同一时间只有 1 个解码器 |
| B4 图片 | 视图中的图片字段可能是 `data:` URL，也可能是 `buddy-media://<sha256>.<ext>`（受限协议，由后端注册，CSP 也由后端添加）。上传仍然发送 data URL，由后端负责转换 | `companion-ui`、`companion-life-ui`、`group-stage-ui`、`group-mention-input`、`pet-interaction-view` 都要能显示这两种格式。判断"是不是图片"时不要只认 `data:` 前缀。编辑角色卡、身份或群聊时，原样回传收到的 `buddy-media://` 值即可，后端会当作有效图片。新上传的图片在保存后立刻变成 `buddy-media://`，所以 UI 的这部分必须和 B4 后端同一批上线（R2） |
