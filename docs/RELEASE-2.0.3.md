# AI Buddy 2.0.3

2.0.3 is a host patch for group-chat Auto. Bilibili 2.0.11 and QQ 2.0.6 retain their independent versions. Work 2.0.9 source and packages are not part of this public release. Existing approved all-C animation resources are reused without re-encoding; 30/60fps retain the same application features.

## Group-chat fixes

- A displayed reply now completes its presentation acknowledgement correctly so Auto can continue to the next eligible member instead of remaining stuck after the first reply. An opportunity still completes only with an actual presentation acknowledgement or a recorded silence decision.
- A group turn without player input receives an explicit host-control scheduling input. It grants the current character one speaking opportunity and is distinguished from player speech, attitude, memory and affection evidence.
- Failed or ambiguous replies retain diagnostic information and their distinct states. A model's explicit silence decision is recorded as a terminal result for that opportunity without creating a displayed reply. Unknown requests are not automatically replayed.
- Auto shows the current round and each member's opportunity status. Progress can be expanded or collapsed; earlier rounds remain available separately.

The existing speaking order, talkativeness, silence decisions, permissions and affection rules remain unchanged. A live DeepSeek HTTP 400 was observed during diagnosis, but the precise rejected request field has not been established; this release does not claim a verified field-level cause or live provider acceptance.

## Evidence and boundaries

The group-chat change reuses 208 related functional checks across 25 test files, including 38 newly added checks. A real Electron application check used synthetic model responses for four members over two rounds: eight opportunities, including one recorded silence. This is native application/renderer evidence with synthetic responses, not acceptance against a real model provider. The metadata and packaging checks for 2.0.3 are separate release gates; staged source metadata alone does not prove remote publication.

The historical [2.0.2 validation scope](VALIDATION-2.0.2.md) remains available for unchanged behavior and its stated limits. Installation does not authorize public comments, QQ messages, work tasks or model requests. Upgrades must retain local chats, identities, connections, inventory, CGs, tasks and receipts.

## 中文说明

本体2.0.3修复群聊Auto首条台词显示后仍等待ACK的问题；无玩家输入时提供明确的host-control调度输入，并将它与玩家发言、态度、记忆及好感依据区分。失败与待核对状态保留诊断信息，明确的沉默决定作为本次机会的终态记录。界面显示当前轮和成员进度，可展开、收起及查看此前轮次。原有群聊规则和权限不变。

复用25个文件中的208项相关功能检查，其中38项为本次修复新增。真实Electron应用的合成响应检查覆盖四成员、两轮、八次机会，含一次沉默；这不等于真实模型验收。真实DeepSeek400的具体拒绝字段尚未证实。本次不公开Work插件；B站陪伴2.0.11、QQ连接2.0.6保持，动画素材复用原字节，不重新编码。
