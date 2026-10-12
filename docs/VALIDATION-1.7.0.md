# AI Buddy 1.7.0 validation

Validated on Windows x64, 2026-10-12. This records technical checks and screenshot review, not the user's final visual acceptance.

| Area | Result |
|---|---|
| Application tests | 209 passed, 0 failed; temporary profiles and mock model services |
| Exported source | Clean export; npm dependency install, source compilation and actual Electron launch passed; 144 exported tests passed |
| Native UI | 900 / 1180 / 1600 / 1920 widths at 100% / 125% / 150% display scale; no horizontal overflow or wheel zoom |
| Appearance | 11 saved palettes, window/side-panel colors, fixed and role-following selection |
| Character display | Legacy CG-background migration; role-owned gallery/background; automatic hiding and manual portrait overrides; restart persistence |
| Languages | Chinese / English main navigation and settings; original history preserved; in-flight chat language fixed at request start |
| Prices | Effective catalog, provider/model filtering, pagination, cache/threshold details, user override precedence; existing cost arithmetic unchanged |
| Pet | 15 displayed actions / 18 compatible logical IDs, actual complete PNG playback; 25% / 50% / 75% / 100% speed; drag and transparent hit testing |
| Memory | Three preview-switching rounds; bounded frame cache, no sustained increase in the measured rounds |
| Branding | AI Buddy.exe, Windows product resources, existing character icon, application ID, direct startup and single instance |
| Portable ZIP | 3,519 manifested files individually SHA-256 verified; restored to a Chinese and space-containing path; launched with external Node/Python paths removed |
| Local update | 1.6.9 archived, fully verified and restore-started; latest profile backed up; formal 1.7.0 started through the existing entry; settings, CG bytes and usage-ledger prefixes preserved |
| Paid calls | None in this implementation acceptance; existing development CG images used to check display |

The local log parsers and monitor/index implementation remain byte-identical to 1.6.9. The monitor's only new route exposes the price catalog; the unified query now retains identities used by that catalog. UI and integration checks above are fresh; earlier real-provider drawing evidence is historical and is not represented as new generation.

## Download integrity

File: `AI-Buddy-1.7.0-Windows-x64.zip`  
Size: 1,671,302,815 bytes (about 1.56 GiB)  
SHA-256: `059d0f2c7ce3535f2fe2bbb0ebd1949e6b912c240bcebab9afa40e0505a81345`

GitHub's uploaded asset digest was also compared to this hash. The repository stays private. The portable app is unsigned; Windows can show an unknown-publisher prompt. The app does not include personal profiles, API keys or private logs.

## Review boundaries

- The screenshots in the README use isolated profiles, not the developer's personal history.
- Historical chat/CG text and user-authored character settings are intentionally not translated retroactively.
- A short measured memory regression does not establish unlimited-runtime behavior. No two-hour soak was required.
- Real paid provider availability and new artistic output were not exercised in this release.
- Character-art terms differ from the code license. See [third-party notices](../THIRD_PARTY_NOTICES.md) before any public or commercial distribution.
