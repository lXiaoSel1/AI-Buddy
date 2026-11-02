# Codex coding instruction snapshot

`src/harness-profiles/deepseek-coding-instructions.mjs` contains a fixed coding-instruction snapshot derived from OpenAI Codex, licensed under Apache-2.0. Its own license attribution remains applicable; AI Buddy's additional license conditions do not change the upstream license on this portion.

- Upstream source: <https://github.com/openai/codex/blob/main/codex-rs/protocol/src/prompts/base_instructions/default.md>.
- Upstream license: <https://github.com/openai/codex/blob/main/LICENSE>.
- Fixed snapshot origin: the owned, model-free native Codex probe's `session_meta.payload.base_instructions.text`, Codex CLI `0.163.0-alpha.11.2`, recorded on 2026-10-23. No correspondence to an unverified upstream Git commit is claimed.
- Text length: 21,026 JavaScript characters.
- SHA-256 of the exported instruction text, encoded as UTF-8: `2ed1c769d32e1edd63a3b8262e28fe2e4778d5854014ec24b6780a36eaadc797`.

The snapshot preserves the native coding and tool instructions. The DeepSeek working profile appends the task-authorized character context; it does not replace the selected model or claim that DeepSeek is an OpenAI model. Local Codex login tasks keep their original native instruction path.

The installed Codex 0.164.0-alpha.11.1 serializes native base instructions as a developer input item. DeepSeek treats that role as user. The task-owned Responses normalizer therefore places the exact builder-owned coding and character text in the upstream `instructions` field. Native input, user text, tool outputs and call IDs retain their original values. Arbitrary user or tool text is never promoted to system priority.

The source comment uses `/*! @license ... */`, retained by the public builder's `legalComments: 'eof'`. The LOCAL-01 isolated bundle check verifies the notice remains in the bundled factory; the final application bundle must also retain it.
