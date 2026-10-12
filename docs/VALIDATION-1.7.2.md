# AI Buddy 1.7.2 · Galgame close portrait

2026-10-12, Windows x64. The user's reference calls for a larger single-character portrait, with the face and upper body prominent and the lower body behind the dialogue.

## Change

The single-character presentation uses a top-aligned portrait box at 190% of the available stage height. Width limits preserve broad silhouettes. The stage clips the part below the dialogue boundary so feet cannot appear beneath the panel. Existing artwork is unchanged. Portrait pickers and multi-character scenes retain their full-figure framing.

## Fresh verification

- 212 application tests passed, zero failures.
- Actual Electron: 900, 1180, 1600 and 1920 logical pixel widths at 100%, 125% and 150% display scale. 44 candidate cases; all eleven characters checked at 1180/100%.
- Four baseline captures from 1.7.1 retained for comparison. Candidate captures inspected for head/face visibility, gestures, dialogue overlap and clipping. This is a technical visual review; user visual acceptance remains pending.
- Background, portrait and character pickers: viewport containment, Escape dismissal and focus return; ordinary/Ctrl wheel leave page zoom at 1.
- CG background auto-hide, manual show, switching between independent character backgrounds and galleries, custom portrait upload and full-image picker checked with isolated saved-image fixtures.
- Eight existing DeepSeek expression images rendered and inspected in the actual presentation box. This checks presentation only, not a new online emotion-classification request.
- Three-person scene including a custom portrait checked at all four widths.
- Navigation, fifteen action entries, preference reload, branded direct startup, single instance and restart verified. No paid model or image request.

## Evidence and scope

`local/buddy-172/release-qa.json` records hashes and paths to the actual native UI, controls, multicast, branding and unit reports. Final passing controls report: `controls-verified/result.json`. Earlier incomplete controls runs are retained as harness-debugging records and are not passing evidence.

Only three renderer sources differ from the verified 1.7.1 baseline: `character-portrait.ts`, `galgame-client.ts` and `dashboard.css`. Build changes are restricted to dashboard CSS/JS/map and version/runtime metadata. All 280 other build files, including artwork, videos, main process, monitoring worker and preload, match 1.7.1 byte for byte. Backend and desktop-pet deep verification from 1.7.1 is historical evidence, not a new full backend test.

Local release requires the previous build/runtime ZIP, archive/source hash verification, restored startup, latest profile backup, post-switch settings and asset checks, animation playback and single-instance verification. The authoritative completed release receipt is recorded in `local/current-build.json`.

## Completed local release

Released through the original entry on 2026-10-12. Receipt: `local/releases/1.7.2-2026-10-12T17-01-33-882Z/result.json` (`ok: true`). All eighteen logical pet actions, actual gallery frame progression, repeated launch/single instance, original settings and CG hashes, and existing usage-ledger prefixes passed. The original `local/data-v003` is retained and the application is open on Galgame.

The previous 1.7.1 build/runtime ZIP contains 369 checked files (537,689,332 bytes; SHA-256 `e47fa44a9a510a478572693862dff0ad04e9ecf279dbfa6231884cb4a7c0ec54`). Restored startup and fifteen physical actions passed with isolated data. A full latest-profile backup was saved before switching.

Two earlier release attempts are retained: one restore smoke check sampled before video frames advanced; one post-switch five-second manual action check expired and automatically rolled the application and configuration back. The verification scripts now wait for actual frame advancement with a bounded timeout and keep manual playback alive longer than that timeout. The final release passed without relaxing action identity, renderer or frame-count checks. No application backend changes were introduced for these harness fixes.

The original local update did not publish to GitHub. The subsequent v1.7.2 distribution pass synchronizes package metadata, README download links, source-build version checks and independent-profile screenshots. Its source tests, portable ZIP hash verification, extracted native startup and GitHub asset digests are recorded separately; they do not represent additional paid chat or image-generation tests.
