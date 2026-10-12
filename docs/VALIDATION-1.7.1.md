# AI Buddy 1.7.1 validation

Windows x64, 2026-10-12. Technical verification and captured-frame review are distinct from subjective visual acceptance.

- 212 application tests passed; 147 exported-source tests passed, with temporary profiles and mock services.
- 15 physical VP9-alpha videos, 18 compatible logical actions. All videos use quality-first CRF 18, approximately 60fps, unchanged canvas/anchors and source cycle times. Every original PNG hash was retained and checked.
- Actual Electron playback: each physical action completed at least two observed loops. Chromium duration matched the original cycle within 1 ms, including the short final jump frame. Transparent, opaque and soft-edge pixels were checked on every action; light, dark and checker captures were retained locally.
- Actual pet: four playback speeds, mid-action speed change, scales, dragging, opaque hit detection, transparent click-through, emotion peak stills and directional gaze.
- Gallery: 15 cards, one pause/resume control, per-card changing decoded frames, three scroll/switch sweeps and inactive resource release. No sustained memory growth in the measured sweeps; this is not an unlimited-runtime guarantee.
- Synthetic log feedback: completed/failed requests, paired provider text, two-cycle completion, manual demo/drag queueing and hidden-window behavior. No paid model requests were made.
- Native UI: 900 / 1180 / 1600 / 1920 widths, 100% / 125% / 150% display scales, wheel zoom prevention, Chinese/English navigation, independent character backgrounds/CG gallery and price catalog.
- Theme selection: the user approved medium-dark, then requested DeepSeek retain its original design. DeepSeek retains original palette values and existing styles; the other ten themes use brighter backgrounds, cards, forms, dialogs and pet bubbles. Fixed/follow-character settings remain supported. Text contrast checks passed for all eleven palettes.
- Branded executable, single instance and saved-preference restart checked. Exported source compiled and launched in actual Electron.

## Animation size

The videos occupy 40,665,383 bytes. Lossless static/eye-direction images occupy 50,786,420 bytes. Together: 91,451,803 bytes (87.2 MiB). Desktop and gallery share the videos; complete PNG sequences and preview atlases are absent from the distribution. Original production images remain local.

Portable ZIP integrity, extracted startup and local rollback/archive checks are enforced before publishing. The release supplies a SHA-256 file. The Windows app remains unsigned. Existing chat history is preserved in its original language; no paid provider availability or new artwork generation was tested. See third-party notices for artwork rights.

## Release verification

The final ZIP contains 424 manifested files, each SHA-256 checked. Extraction and direct branded EXE startup passed in a Chinese and space-containing path, with external Node/Python removed from PATH. Single instance and preference restart passed.

The previous 1.7.0 build and runtime were archived, all 3,477 archive files verified, and the restored build launched. The original entry now starts 1.7.1. The latest local data was backed up; user settings, CG asset hashes and existing usage-ledger prefixes were preserved. No rollback was needed.

Portable folder: 599774600 bytes. ZIP: 380355213 bytes. ZIP reduction versus 1.7.0: 77.24%.

SHA-256: `097dfb0c6cdb4f98f54c2da4fd755ebfbe7985b51435cf8e7407c0b0e674b157`. GitHub keeps v1.7.0 and repository visibility remains private.
