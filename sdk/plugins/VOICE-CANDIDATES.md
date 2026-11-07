# Buddy-v1 语音包候选

隔离宿主支持 `ai-buddy.voice-breeze` 和 `ai-buddy.voice-gpt-sovits` 两个业务插件。每个插件都能选择本地配音或 MiniMax 官方云配音；两包依赖同源的 `ai-buddy.voice-shared-runtime@1.0.0`，该包是 SDK 自动管理的内部依赖，不是第三个用户业务插件。用户安装所选引擎时由 SDK 同时安排依赖，已有同版本依赖可以复用。运行资产由已签名包内 `assets.json` 固定，独立于 ZIP 下载和校验。小型候选 ZIP 包含入口、worker、清单和许可，不内嵌模型、Python 环境或角色参考音。

本地 Breeze 固定 BF16／CFG 4 与 CUDA Graph 路线；本地 GPT-SoVITS 固定 V5 Turbo／FP16。完整资产清单包含对应引擎源码、Python 与加速依赖，按用户选择只准备那一套 TTS。切换本地引擎在播放边界释放旧权重后进行。云配音只需共享 Python／本地流式 ASR／云模块，清单固定 `httpx@0.28.1`、`websockets@17.4`，不要求准备任一套本地 TTS 权重。云服务失败不会自动切换引擎、下载另一套模型或发出额外请求。

云配音使用宿主保存的密钥引用和角色的 MiniMax 声音绑定。已有本地采样保留，但不同模型之间不自动承诺同一音色；不能把本地参考档案冒充已完成的 MiniMax 声音克隆。API Key、11 位角色的采样和私有绑定均不进入发行 ZIP。

候选安装要求隔离宿主的语音接口和独立测试签名。候选通过本机 HTTPS 源复用现有 Buddy 扩展验证。正式签名由最终整合者按实际宿主兼容范围处理。Breeze 源码为 Apache-2.0；模型材料、衍生物和自托管输出遵循随资产保存的 `checkpoints/LICENSE`（BreezeBlue Research and Non-Commercial License v1.1），商业用途需其单独书面授权。GPT-SoVITS 源码为 MIT，预训练模型和各依赖保留各自许可。插件代码许可不覆盖这些资产、云服务或角色样音。打包输出 `ASSET-REPORT.json`、`ASSET-NOTICES.md`，各 ZIP 也包含该许可说明。角色参考音放入有权限的角色档案。

## 隔离安装

在隔离源码根运行，`<输出目录>` 为新的产物目录，`<TLS目录>` 为已存在的隔离目录。

```powershell
node scripts/package-voice-candidates.mjs --out=<输出目录> --origin=https://127.0.0.1:18793
openssl req -x509 -newkey rsa:2048 -nodes -days 5 -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1 -keyout <TLS目录>/key.pem -out <TLS目录>/cert.pem
node scripts/serve-voice-candidates.mjs <输出目录> <TLS目录>/cert.pem <TLS目录>/key.pem
```

在新终端将 `NODE_EXTRA_CA_CERTS` 指向隔离的 `cert.pem`。测试指纹只能由使用独立资料目录的隔离测试程序读取 `RECEIPT.json` 后，直接传给 `createPluginMaintenanceClient` 和 `createPluginPlatform` 的 `voiceTestFingerprint` 参数。正常宿主入口不接受命令行测试指纹，继续使用默认正式信任；不能靠启动参数安装候选测试签名包。TLS 证书只在当前测试进程的环境里使用，系统证书库无需变更。

在上述隔离测试程序所创建的扩展中心添加 `RECEIPT.json` 的 `sourceUrl`，核对指纹。以该来源添加 `communityUrl`，在语音分类分别安装、启用两款插件。陪伴页负责设备权限、声音档案和运行资产准备。正式宿主只安装默认正式信任认可的签名包。

停用或撤销来源时宿主先结束活动语音，再变更登记。卸载保留独立资料，仍被其他引擎使用的共享依赖会由现有安装器保护。隔离产物签名私钥只存在于打包进程内存。

`resolveVoicePackage(id, {provider:'minimax'})` 与本地共用签名、来源信任、启用、兼容性、维护代次和停用防护，并要求共享包的签名文件清单包含 `cloud_speech.py`。启用入口继续只使用 SDK 的 `commands.register`，协议版本保持 1；入口声明 `providers:['local','minimax']` 和共享云 worker，未经签名的页面参数不能绕过这些校验。未安装、停用或来源撤销时，两条配音路径都不能启动。

生成离线资产清单使用 `scripts/prepare-voice-runtime.py` 的固定版本输入；脚本不会联网或安装依赖，默认只读取并计算摘要。只有显式传入全新 `--seed` 目录才复制完整运行组件。最终安装从该目录按已签名清单逐文件校验并事务准备；不要把现存模型目录或一份路径说明当成已完成准备。
