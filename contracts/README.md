# R95 共享合同首包

本目录配合 `src/buddy-plugin-services/social-client.mjs`，用于负责人 A 的两个可选插件。薄客户端只转发到 Core 已有 `invoke({pluginId,contextToken,method,payload}, {signal})`，不签发身份、事件、Token 用量、积分或主人工作权限。

## 文件与导入

- 类型：`social-contract-v1.d.ts`。
- 运行模块：`../src/buddy-plugin-services/social-client.mjs`，具名导出 `createSocialClient`。
- 宿主方法版本：`social-contract-v1`；上下文令牌版本：`buddy-bridge-v1`。
- `index.mjs` 的统一 re-export 由本体负责人单独接入；本首包未修改该入口。

```js
import {createSocialClient} from '../src/buddy-plugin-services/social-client.mjs';
// 以下 issued 和 invoke 必须由真实宿主输运提供；不可在插件内自行构造身份。
const social=createSocialClient({pluginId:issued.pluginId,contextToken:issued.contextToken,invoke});
const known=await social.context({query:'本会话中我实际知道的经历'});
const lease=await social.lease({activityId:hostAttemptId});
let terminal='unknown';
try {
  const result=await social.model({connectionRef:issued.context.connectionRefs[0],leaseId:lease.leaseId,messages:[{role:'user',content:'根据允许的真实材料回答。'}]},{signal});
  terminal='completed';
  // result 为真实模型返回；这一步不等于对外发送、已呈现或用户已读。
} catch(error) {
  terminal=signal?.aborted?'cancelled':error.code==='BUDDY_EXTERNAL_RESULT_UNKNOWN'?'unknown':'failed';
  throw error;
} finally {
  await social.finish({leaseId:lease.leaseId,status:terminal});
}
```

实际代码须按宿主结构化错误辨别结果未知，不能把任意异常计成 completed。`finish` 不会写入“视频看完”“QQ 已发送”等经历。

## 边界

1. `issued` 必须来自 Core 私有 `platform.issueSocialContext`，它只接受真实宿主生成的 `eventRef`；该私有端口不是插件 action。声明 capability 仍须得到用户 grant，不能获得 `work.host`。
2. `registerTransport({verify})`、`observeEvidence`、主人绑定、实际用量写入均属于 Core。`verify` 必须观察真实 Native/backend 输运，不能接受插件 JSON 的 actor/owner/verified/usage 声明作为证明。
3. `experience.append` 只携带 eventRef。原文、身份、阶段、来源哈希由宿主读取；收到、读到部分、理解、呈现、发出是不同事实。未分享的真实已理解材料可以是角色自身经历，不能伪造 presented。
4. `proactive.offer` 只提交候选，仍须双重准入、忙碌/免打扰/呈现屏障。不能宣称调用成功就已向 APP/QQ 发送。APP 分享投递目标接线尚在整合，见交接。
5. `models.request` 社交上下文只用角色当前绑定连接和允许记忆；模型 Key 不返回。工作上下文保留原 broker 路线。实际 usage 由 Core ModelRouter 计量，客户端没有 usage.record、积分或任意工具执行入口。
6. 工作委托仅限 Core 已绑定主人直接 QQ 私聊原消息。群聊、转发、引用、网页/OCR、模型输出不能授权工作。普通委托生成计划；批准须新真实主人消息精确含 `批准 <challengeId>` 或 `approve <challengeId>`，并重新核对计划版本/项目/人生。

## 状态与验证层级

已经实现：合同常量、薄客户端、可信宿主原语、私有 issueSocialContext、社交/工作 models.request 分流。薄客户端有 Mock 传输测试；宿主有隔离 SQLite/Mock 服务测试。它们不代表真实 QQ/B站接入通过。

尚未提供：真实 QQ/B站 transport runtime。Core 生命周期 lease 取消与 model/search 活跃 lease 门禁正在根接线；SDK 已透传 leaseId，最终以根的冻结回执为准。本体源码还未整体冻结，也未构建、发布、安装或向另一聊天发送本包。

不自动重试模型、工作创建、发送或未知结果；失败保留 Core 原错误 code。重启、停用、来源撤销、人生变化、主人重新绑定均可使旧上下文失效。`contextToken` 不可打印日志或持久化为可移植凭据；它只能在当前宿主进程内使用。
