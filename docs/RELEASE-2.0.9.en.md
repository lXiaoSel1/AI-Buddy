# AI Buddy 2.0.9

2.0.9 brings together local speech, turn-based Live conversation and cloud voice management. The 30fps and 60fps editions have the same features and reuse the approved character and motion resources.

## Speech and components

- Extensions offers Breeze and GPT-SoVITS local engines with shared recognition components and per-character voice references. Private recordings and local reference voices are not uploaded with this release; users import their own.
- Galgame supports turn-based Live conversation and editable drafts after recording. Preparation, cancellation and stopping follow actual component and audio state. Cancelling preparation prevents the microphone from opening afterward.
- MiniMax supports named configurations, system/cloned/designed voices, search, filtering and character bindings. Paid cloning starts with no characters selected and submits only the explicitly selected and confirmed items.
- Speech pages, General settings, chat status, Live stages, component preparation/import and cost controls have been reorganized. Card Games has an independent speech volume control.
- The host manages component downloads, imports, resumed progress and cancellation. It prepares only the selected local engine and shared components; cloud mode does not load another local TTS engine. Download descriptions bind the signed package and original asset digests, retaining path, size, integrity and update-rebinding checks.

## Playback, performance and saving

- Switching characters within a healthy engine reuses its loaded components. Full verification receipts persist, and status reads avoid repeatedly scanning models. Private/group chat switches check actual runtime state and do not reopen the Live microphone automatically.
- Speech and text presentation synchronize with actual playback start, with explicit release on failure or timeout. Saved Bilibili shares and table conversation use the shared speech path. Pending table results are discarded after a table/hand change or departure. Read-aloud filters quotation blocks and bare links, retains ordinary text and preserves specific cloud failure reasons.
- Bilibili image support uses a catalog of vendors and exact models. Capability and transport are evaluated separately: known supported models send images normally; unknown models remain unknown. The Bilibili entry no longer sends an extra automatic probe first.
- Frequent status reads avoid full-save copies, deferred presentation avoids rebuilding the whole interface repeatedly, and usage/component hot paths perform fewer repeated queries. In one 60-second local Auto+Breeze comparison, median pointer latency fell from 165ms to 0.59ms and main-thread single-core usage from about 92% to 10%. These figures describe that measurement only.
- The large companion/global saves are written hourly and at boundaries such as normal exit, with paired flushes before inspection, export and import. Settings, drafts, request journals, the wallet and usage databases retain their own immediate-save mechanisms. Power loss or forced termination can still lose ordinary changes to the two large saves since their last successful write.

## Updates and verification limits

The release retains 2.0.8's in-app updates, actual helper capability checks, update protocol 1 and business snapshot protocol 1. The signed manifests of voice plugins 1.0.0 restrict them to host 2.0.8 exactly. Upgrading to 2.0.9 requires a normal update to 1.0.1 from the official catalog; old packages and compatibility ranges are not rewritten. New descriptions and shared dependencies are checked against their new signed manifests.

First public component downloads and clean-machine discovery/installation paths must be checked after official publication; those public paths are not yet reported as passed. Real-model loading, MiniMax billing, microphones and long listening sessions require separate verification. The 15-second cold-start fallback still needs field calibration. Existing open fullscreen-click and mixed-DPI items remain open. Source tests, isolated installation and artifact checks do not replace these field results.

Distributions exclude private recordings, chats, accounts, credentials, the internal Work and collaboration plugin and local test evidence. Existing resource/runtime digests remain unchanged. Both portable editions, the online installer and their final manifest/checksums are released as a matching set.
