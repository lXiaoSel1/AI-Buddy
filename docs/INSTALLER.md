# AI Buddy 1.9.0 installation and maintenance

[简体中文](#安装) · [English](#installation)

## 安装

下载 [AI-Buddy-Setup-1.9.0-win-x64.exe](https://github.com/lXiaoSel1/AI-Buddy/releases/download/v1.9.0/AI-Buddy-Setup-1.9.0-win-x64.exe)，选择安装位置、30fps 或 60fps、所需角色与初始角色，再点击安装。

安装器自带 .NET 运行库。无需安装开发工具。资源从固定的 v1.9.0 Release 下载，每个资源 ZIP 不超过 1 GiB。首次默认 30fps、全部角色；桌宠默认 125%。不会开启聊天、自动 CG、开机启动或后台自动更新。

下载中断时重新运行同一个安装器，选择相同位置即可继续。通过 SHA-256 校验的包会复用。未完整安装前不会创建软件入口。

通用设置 → 管理角色资源，可以补装角色、切换帧率或修复文件；使用同版本安装器。未安装的角色标为“待安装”，确认后打开安装器，不会自动下载。

升级提交前会等待聊天和 CG 收尾并正常关闭目标程序。安装器保留上一程序版本与个人存档；回退只恢复程序和启动指针，不用旧存档覆盖新进度。卸载默认保留个人数据。自定义数据目录不自动删除。

## 从 1.8.0 升级与旧版回退

旧 1.8.0 安装器固定使用原 1.8.0 清单，不能自动发现 1.9.0。下载本页的 **1.9.0 安装器**，选择原安装位置；新版接管当前路径和资源选择，保留原存档、自定义数据路径、聊天连接和有效角色设置。完整便携包也可被新版安装器识别接管。不要把原存档拷进新包覆盖。

同一存储格式的程序/帧率回退只换程序，不还原旧数据。返回 R2 之前的构建（含 1.8.0）前必须先核对 B4 图片引用、草稿和 1.9 人生/记忆数据兼容性；存在新格式数据时维护器拒绝自动降级。`media-revert` 是单独的数据维护，必须先取得用户对当前 planId 的确认；安装器不会偷偷执行或删掉新人生数据。

The original 1.8.0 EXE pins its old manifest. Use the new 1.9.0 installer to upgrade the same folder, retaining personal data, effective settings and custom paths. Same-format rollback changes program files only. Downgrades to a pre-B4 build are refused when new image references, drafts or life/memory data make them unsafe; no automatic data conversion or deletion is performed.

## 离线

将固定清单 `install-manifest-1.9.0.json` 和所需资源 ZIP 放在一个文件夹，在安装器选择“离线资源目录”。同样验证每个包和每个文件，不需要联网。缺包会列出文件名。

Release 也提供完整的 30fps / 60fps 便携分卷和合并工具；所有分卷都需要下载。1.7.10 的原离线包仍保留在原 Release。

## Installation

Download [AI-Buddy-Setup-1.9.0-win-x64.exe](https://github.com/lXiaoSel1/AI-Buddy/releases/download/v1.9.0/AI-Buddy-Setup-1.9.0-win-x64.exe). Choose an installation folder, 30fps or 60fps, characters and an initial character, then install.

The self-contained installer includes its .NET runtime. No developer tools are required. Every independent resource ZIP is at most 1 GiB. The installer pins the v1.9.0 manifest and validates package and file SHA-256 hashes. It does not enable online chat, automatic CG, startup registration or background updates.

Run the same installer again after an interrupted download. Verified packages are reused. General Settings → Manage character resources opens the installed maintenance tool for adding characters, repair or switching frame rates. Missing characters never trigger automatic downloads or model requests.

The installer waits for chat/CG to finish before closing the target application. Rollback restores program files and the launch pointer while retaining new personal data. Uninstall retains personal data by default; custom data directories are never recursively deleted.

For an offline install, place the pinned manifest and required resource ZIPs together and select that folder. The same integrity checks apply. Complete portable split archives are an alternative; download every part and the supplied merge tool.

## Maintainer build

Use the pinned SDK in `installer/global.json` and a Windows x64 host. Build the application candidates with `scripts/build-distribution-190.mjs` from the rebuilt dual-edition candidates and the explicitly approved MEDIA-BASELINE-190-CRF28.json plus USER-APPROVAL.json; all bound media hashes are rechecked without re-encoding. Run `scripts/package-installer-190.py` to generate independent ZIPs, the manifest and the embedded manifest hash. Publish `installer/AI.Buddy.Setup.csproj` with `dotnet publish -c Release -r win-x64 --self-contained true`. Run `dotnet run --project installer/Tests/CoreTests.csproj` and the application tests before publication.

The manifest is fixed per release. Never replace uploaded resources under an existing published tag. Installation-manager binaries are copied from the running, pinned installer after package validation to avoid a manifest/self-hash cycle. The installer SHA-256 belongs in the final release checksum file.

Deployment references: [Microsoft single-file deployment](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview), [GitHub releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).
