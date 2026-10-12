# AI Buddy 1.7.3 validation

Scope: portable entry and Windows Codex discovery. No artwork, animation or Galgame rules were changed.

- 223 local unit tests passed, including 11 new discovery, missing configuration, spawn cleanup/retry, unauthenticated login and unsupported image protocol cases.
- Real local Codex desktop cached executable and registered Microsoft Store executable: initialize, account/read and image capability check passed with npm/PATH discovery removed. No model turn or image generation.
- Actual Electron app: CG Test connection passed through preload/IPC/service/provider; chat and automatic CG remained off. All 18 logical actions rendered, 15 gallery entries, Galgame loaded without renderer errors.
- The original 1.7.2 download matched all 425 manifest files. Its PowerShell entry failed at Get-FileHash, and its VBS entry hid the error. The new portable package has a branded root AI Buddy.exe and compatible script entries.
- Standalone root entry, extracted package file hashes, native branding, single instance and restart verification are recorded in the release receipts.

The user's laptop has not been remotely inspected. These checks establish local desktop-only and Store discovery and protocol behavior, not a paid-image test on the laptop. Existing CG generation examples are historical; this repair did not resume the cancelled CG batch.

Codex and its login are not bundled in the ZIP. The user must install/open/login to Codex on each machine; program presence, authentication and image capability are checked separately. No credentials or private CGs are shipped.

Reference: [OpenAI app-server](https://learn.chatgpt.com/docs/app-server) documents stdio initialization and account/read. Desktop install locations additionally come from local filesystem and MSIX registration evidence.
