# AI Buddy 1.7.5 — DeepSeek CG 参考纠正

1.7.4 的参考注册保留了 DeepSeek 特判，始终选中桌宠制作母版 `approved-character-native.png`。这是素材选择错误；此前真实接口出图成功不能证明所选图片用途正确。

本次按 Galgame 的立绘资源键选择 CG 参考。DeepSeek 默认使用 `maid-left` 立绘，用户自定义立绘优先；其余十位角色仍使用自己的立绘。已生成 CG 及旧任务参考快照保留，旧任务重试仍复用旧参考；需要正确立绘时创建新 CG。

原 `maid-left.webp` 能由 Chromium 显示，但 Electron `nativeImage` 后台解码失败。因此新增像素一致的 PNG 格式副本供 CG 读取，原图不修改。构建时核对来源及 PNG 哈希，避免两者不同步。

- 原立绘 SHA-256：`af7bfd2e18505fc9d6f94cefd9febc92b31c1b2b66c756982d91fc7b93fb184c`
- PNG SHA-256：`a9fb484fefc6830f1d4a550854e20142d23aa53bf52f9921ef13967a69ad9b22`
- 1122×2019，解码 RGBA 完全相同：`c27bc2c0c2bb1d1fd8c2f8b72e720aa681c40b4fc9a743e55724a83d42e7a68c`

231 项自动测试通过。独立 Electron 使用本地模拟接口，核对 11 位角色实际提交图片哈希、DeepSeek 与页面立绘同源、自定义 PNG 优先、18 个逻辑动作及 15 项展示。模拟结果用于参考传递验证，不代表重新验收艺术成片；本轮零付费绘图。此前 WebP 解码失败和无效测试 PNG 的失败记录均保留。

证据：`local/buddy-175/native-latest.json`、`brand.log`、`unit.log`、`release-qa.json`。最终发布与恢复凭据以 `local/current-build.json` 中的 `releaseReceipt` 为准；沿用存档、连接、开关和原入口。

## GitHub 发行范围

发布前独立复核补齐了 Gemini 和万相错误回显的提示词过滤，包括恢复异步任务时的错误。请求正文及绘图参数不改变，增加模拟回显回归测试。发行包重新编译这些源码，并对实际解压文件验收；本机已运行的程序不会因源码上传被强制重启。

1.7.5 同时包含此前仅在本机更新的 1.7.4 火山方舟适配：专用 JSON 绘图和参考图传递、旧官方服务地址兼容、模型检查，以及脱敏的 HTTP 状态、错误代码、服务原因与请求 ID。详见 [1.7.4 验收记录](VALIDATION-1.7.4.md) 和 [CG 绘图指南](../CG_API_GUIDE.md)。

Windows x64 发行 ZIP 必须完整解压，运行根目录 `AI Buddy.exe`。保留 1.7.3 的 Codex 桌面端检测、原存档目录与单实例机制。GitHub 发行附 SHA-256，不包含开发者存档、密钥、私有聊天、生成测试图或测试缓存。

上传前检查发布源码测试、独立源码构建、ZIP 逐文件哈希、中文及空格目录内的根 EXE 启动、品牌属性、单实例和设置重启恢复。结果及实际包大小记录在 Release 和本地发布凭据 `local/buddy-175/github-publication-verified.json` 中；源码构建使用同版本便携包素材并核对默认立绘与 CG 参考哈希。旧版资源缺失或哈希不同会明确报错。

用户于 2026-10-12 确认发布到当前公开的 `lXiaoSel1/ai-buddy` 仓库；旧标签和发行资产保留。本次上传验证不追加付费绘图，不远程操作用户笔记本。
