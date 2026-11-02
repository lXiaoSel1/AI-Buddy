# AI 酱 · AI Buddy

<!-- ai-buddy-source-version: 2.0.2 -->
**简体中文** · [English](README.en.md)

Windows 10/11 x64 的本地 AI 用量监控、桌宠和多角色陪伴应用。

当前发行版：[v2.0.2](https://github.com/lXiaoSel1/ai-buddy/releases/tag/v2.0.2)。
[下载 Windows 安装器](https://github.com/lXiaoSel1/ai-buddy/releases/download/v2.0.2/AI-Buddy-Setup-2.0.2-win-x64.exe)，选择 30fps 或 60fps 及角色。安装器按清单下载并校验资源；每个下载文件都绑定哈希。

- 读取本地工具日志，按工具、模型、项目和日期整理真实记录的 Token 与参考费用；缺失字段保持未知。
- 11位内置角色、透明桌宠、独立聊天连接、角色卡与身份、群聊、长期记忆、人格成长和人生存档。
- 持续心情、主动搭话与睡眠、积分、商店背包和投喂；可按设置生成CG。
- 扩展中心通过签名目录安装插件。B站陪伴和QQ连接独立发行，不随安装自动登录、发言、观看或调用模型。

## 两个正式社交插件

| 插件 | 源码及安装说明 |
| --- | --- |
| B站陪伴 2.0.11 | [AI-Buddy-Bilibili](https://github.com/lXiaoSel1/AI-Buddy-Bilibili) |
| QQ连接 2.0.6 | [AI-Buddy-QQ](https://github.com/lXiaoSel1/AI-Buddy-QQ) |

在扩展中心打开官方目录即可发现插件。安装B站陪伴时会在同一流程中自动准备固定DSH和视频组件（FFmpeg），显示来源、大小与进度；已核验的副本不会重复下载。FFmpeg由程序从Gyan固定发布版直接取得，不随本体镜像。QQ连接在用户点击连接时，从NapCat上游准备固定第三方连接组件。普通用户无需手动安装Node或填写端口与Token。连接账号后还需选择角色和允许的范围；QQ主人工作权限、B站公开评论另行授权。

B站观看必须先连接B站账号。画面理解来自明确采样的原视频画面与可取得的平台字幕，不等于逐帧连续观看或听懂音频。完整精读展示参数、预计调用和材料范围，确认后执行；缺少材料、权限或模型能力会暂停。未知请求不会自动重发。

工作与协作插件仍在打磨，本次不公开提供它的源码或安装包；宿主保留兼容入口，更新不会删除现有本地任务与交付。

## 数据、升级和限制

账号凭据交系统加密存储；不放入插件页面、模型提示或发布包。存档、聊天、CG和任务保存在用户本机，勿上传local目录。回退只切程序，不用旧备份覆盖新数据；不支持新数据的旧程序会拒绝写入。

应用本身免费，模型供应商和平台可能有自己的计费及使用要求。模型、联网、图片能力取决于连接。真实外部平台收发、模型表现与工程合成测试分别记录，见[发行说明](docs/RELEASE-2.0.2.md)与[验收边界](docs/VALIDATION-2.0.2.md)。

## 开发与许可

[源码构建](docs/BUILD.md) · [安装维护](docs/INSTALLER.md) · [官方目录](https://github.com/lXiaoSel1/AI-Buddy-Extensions)

代码许可见[LICENSE.md](LICENSE.md)，第三方代码和素材见[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)及licenses。保留上游署名和现有素材权利说明；没有宣称所有参考形象的权利均已清理。运行库与动画以发行资源提供，不进入Git源码历史。
