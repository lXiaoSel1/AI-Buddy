# AI Buddy · AI 酱

<!-- ai-buddy-source-version: 2.0.3 -->
[简体中文](README.md) · **English**

A local AI usage monitor, desktop pet and multi-character companion for Windows 10/11 x64.

Current release: [v2.0.3](https://github.com/lXiaoSel1/ai-buddy/releases/tag/v2.0.3).
[Download the Windows installer](https://github.com/lXiaoSel1/ai-buddy/releases/download/v2.0.3/AI-Buddy-Setup-2.0.3-win-x64.exe), then choose 30fps or 60fps and characters. Downloaded resources are checked against a hash manifest.

- Local usage ledgers grouped by tool, model, project and date. Missing usage stays unknown; estimated API cost is not a subscription invoice.
- Eleven built-in characters, desktop pets, separate model connections, character cards and personas, group chat, long-term memory, personality growth and life archives.
- Persistent mood, proactive conversations and sleep, points, shop, inventory and feeding; CG generation follows user settings.
- Signed extension catalogs. Installation does not log in, chat, watch, post comments or invoke models automatically.

## Social plugins

- [Bilibili Companion 2.0.11](https://github.com/lXiaoSel1/AI-Buddy-Bilibili)
- [QQ Connect 2.0.6](https://github.com/lXiaoSel1/AI-Buddy-QQ)

Open the official source in Extensions to discover them. Installing Bilibili Companion automatically prepares the pinned DSH and FFmpeg dependencies in the same flow, showing their sources, sizes and progress; verified local copies are reused. FFmpeg is downloaded directly from the fixed Gyan upstream release rather than mirrored in this host package. QQ Connect prepares the pinned third-party NapCat component from its upstream release when the user explicitly connects. Users do not need to install Node or enter ports and tokens. After QR login, choose a character and permitted scope. Public Bilibili comments and trusted QQ owner work access require separate grants.

Bilibili viewing requires a connected account. Video understanding uses declared sampled original frames and available platform subtitles, not continuous frame-by-frame viewing or audio transcription. A full-reading plan displays parameters, materials and expected calls for confirmation. Missing resources, permission or model capability pauses the activity. Unknown requests are not automatically resubmitted.

The Work and Collaboration plugin remains under development and its source/package is not part of this public release. Host compatibility stays available; local tasks and delivered files are preserved by upgrades.

## Data, upgrades and limits

Account secrets use the system-protected store and are not included in plugin pages, prompts or releases. Chats, saves, CGs and tasks remain local; never upload local/. Rollback changes program files only and must not replace new data with an old backup. An incompatible older writer refuses new data.

AI Buddy is free; model providers and platforms may have their own fees and terms. Model, search and image capabilities depend on the selected connection. Engineering fixtures, native-window tests and live external-platform behavior are reported separately in the [release notes](docs/RELEASE-2.0.3.md) and [validation scope](docs/VALIDATION-2.0.2.md).

## Development and licensing

[Build](docs/BUILD.md) · [Installation and maintenance](docs/INSTALLER.md) · [Official directory](https://github.com/lXiaoSel1/AI-Buddy-Extensions)

See [LICENSE.md](LICENSE.md), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and licenses/ for code and third-party terms. Existing artwork/reference-rights qualifications remain; no blanket clearance is claimed. Runtime and animation resources are release assets rather than Git source history.
