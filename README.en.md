# AI Buddy · AI 酱

**A record of your AI work. A companion on your desktop.**

[简体中文](README.md) · English

AI Buddy is a Windows app that reads local AI-tool usage logs, estimates token costs, and brings a desktop pet and eleven-character visual novel to your workspace. The displayed character and the model that answers are selected independently.

The Galgame engine and interface are adapted from **[JAdpp/dsh-whale-galgame](https://github.com/JAdpp/dsh-whale-galgame)**. Thank you, JAdpp, for sharing the character, event and persistence systems that made this project possible.

![Overview](docs/screenshots/overview-en.png)

## Download

Download `AI-Buddy-1.7.1-Windows-x64.zip` from [Releases](https://github.com/lXiaoSel1/ai-buddy/releases), extract the complete folder to a writable location, and run **AI Buddy.vbs**. **AI Buddy.cmd** and the versioned **AI Buddy.exe** are alternative launchers.

- Windows 10/11 x64; portable ZIP, no installer in this release.
- Electron is bundled. Node.js, Python and image-generation tools are not required to run the app.
- Keep the folder structure. Do not run from inside the ZIP or copy only the executable.
- The release provides a SHA-256 checksum. The executable is not commercially code-signed.
- This repository is private for review; downloads require access. The owner decides when to make it public.

The portable directory is about **572 MiB** and its ZIP about **363 MiB**, approximately **77% smaller** than the 1.7.0 ZIP. Use the release asset size and SHA-256 for exact integrity checks.

## Local usage and reporting

Supports **Codex, Claude Code, Gemini CLI, Kimi Code CLI, OpenCode, Cline, Roo Code and DeepSeek Harness**. It reads reported usage rather than estimating tokens from conversation length. Missing values remain unknown.

The overview has Usage, Cost and Quota tabs. Projects can be sorted by total/input/output tokens or name. History is the home for daily, weekly and monthly trends. Filters include date range, time zone, tool, model developer, service platform, source and purpose; export CSV or JSON.

The history index persists across restarts. Startup checks for changed files; first indexing, replaced logs or index repair can take longer. Tools, model developers and service platforms are separate identities.

![Projects](docs/screenshots/projects-en.png)
![History](docs/screenshots/history-en.png)
![Token detection](docs/screenshots/tokens-en.png)

## Cost estimates and price catalog

Costs use **input, output, cache-read and cache-write token counts multiplied by their rates**. Request counts are not a billing unit. Subscription usage is shown as an API-equivalent estimate, not the actual subscription bill. Coverage is token-weighted; missing usage or prices are not treated as zero.

Open Cost → Price settings to browse effective prices by platform, model, locally used models or custom overrides. Each page has 50 rows, with currency, per-million-token rates, cache prices, context tiers, source and version. Manual updates use models.dev; daily updates are off by default.

![Prices](docs/screenshots/prices-en.png)

## Optional quota connections

Separate opt-in connections cover Codex, Claude, GLM/Z.ai, Kimi Coding, MiniMax Coding, DeepSeek API balances and supported Gemini CLI accounts. Available fields depend on the service and account; unsupported accounts show a reason. No model conversation is sent to probe a quota, and browser cookies are not read. Temporary errors retain the last successful values and timestamp.

![Quota connections](docs/screenshots/quotas-en.png)

## Eleven characters

**DeepSeek, Grok, Seed, Kimi, Qwen, MiniMax, GPT, Gemini, Claude, GLM and Hunyuan** have distinct portraits, backgrounds, personalities, voices, greetings and visual descriptions.

Each character owns their levels, conversation history, background, CG gallery, recycle bin and portrait visibility preference. Select a character independently of the chat API; Qwen can, for example, be played through Claude. Multi-character theater, custom portraits and editable profiles are supported.

CG backgrounds automatically hide the portrait to prevent duplicate characters. Use the toolbar to show/hide it manually or return to automatic behavior. Switching characters restores that character’s background. Right-click a CG to move it to the recycle bin; undo and restore do not generate another image.

![Galgame](docs/screenshots/galgame-en.png)
![CG background without a duplicate portrait](docs/screenshots/cg-background.png)

## Separate chat and image APIs

Manage connections on the API page. **Save and use** saves and activates; **Save only** keeps the current selection. General settings selects saved connections and controls their switches.

Chat supports local Codex sign-in, OpenAI Chat Completions/Responses, native Gemini and Anthropic Messages. CG supports Codex built-in images, OpenAI Images compatible services, Gemini Interactions and Wan generation/editing/asynchronous endpoints. Custom compatible URLs and model IDs are supported; actual capabilities and permissions depend on the service.

External keys use Electron safeStorage encryption. Local Codex requires an available local Codex login. Online chat starts disabled after each restart; automatic CG starts disabled on a fresh install. Model and image calls can incur service charges.

With online chat enabled, a new level-up CG may use one additional chat request to design a theme. Local character-specific themes are the fallback. Queued jobs retain their selected character, references, prompt and connection; retries reuse prepared themes. CG uses male first-person framing with the male character out of frame; natural hand interaction, text and clothing logos are allowed.

![CG gallery](docs/screenshots/cg-gallery.png)

![API connections](docs/screenshots/api-en.png)

## Desktop pet, themes and language

Animations now use transparent VP9 WebM at approximately 60fps, with quality-first CRF 18 encoding. Pet and gallery share the videos; gaze directions and static emotional peaks use lossless WebP. The 15 videos total about 38.8 MiB, or 87.2 MiB including stills. Complete PNG sequences are not duplicated in the distribution.

The approved transparent full-frame animations play at **60fps**, with 15 visible actions and 18 compatible logical IDs. Drag the pet, adjust size and speed, and click through transparent areas. Task outcomes use synchronized queued animation and speech feedback.

Eleven character-inspired color themes can be fixed or follow the selected character. **DeepSeek keeps its original deep-blue design; the other ten themes use the softer medium-dark palette.** Window chrome matches the interface; artwork is not recolored. Choose Simplified Chinese or English in General settings. Existing history and custom user text stay unchanged; built-in defaults and new conversations use the selected language.

![Claude medium-dark theme](docs/screenshots/theme-claude.png)
![Original DeepSeek theme](docs/screenshots/theme-deepseek.png)

![Animations](docs/screenshots/actions-en.png)
![Settings](docs/screenshots/settings-en.png)

## Privacy, development and credits

Local monitoring is read-only, sends no model requests and does not modify the monitored tools. App data is under `local/data-v003`; keep that directory when updating. Release packages exclude developer profiles, keys, private conversations, personal CGs and logs. Screenshots use an independent test profile and development validation images, not live account usage.

See [BUILD.md](docs/BUILD.md) for source builds. Node.js 24 is needed for development; runtime artwork and animations can be extracted from the matching release ZIP.

See the [1.7.1 validation record](docs/VALIDATION-1.7.1.md) for tested behavior and review boundaries.

Special thanks to [JAdpp/dsh-whale-galgame](https://github.com/JAdpp/dsh-whale-galgame), [dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale), [dsh-deepseek-girl-pet](https://github.com/f0909172434/dsh-deepseek-girl-pet), [上善](https://www.pixiv.net/users/62155430), [ZipZipPipe](https://www.pixiv.net/users/18604994) and the [AI gijinka gallery](https://genderswapai.com/zh-CN/ai-gijinka/gallery). Additional thanks to [ccusage](https://github.com/ccusage/ccusage), [CodexBar](https://github.com/steipete/CodexBar), [models.dev](https://models.dev), [Electron](https://www.electronjs.org/), [React](https://react.dev/), [esbuild](https://esbuild.github.io/) and [RIFE](https://github.com/hzwer/ECCV2022-RIFE).

Code licensing is in [LICENSE.md](LICENSE.md). **Artwork is not universally MIT-licensed.** Some upstream images are CC BY-NC-SA 4.0; the rights and distribution terms of newly referenced character designs require separate source-specific confirmation. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This project is not affiliated with or endorsed by the named AI providers.
