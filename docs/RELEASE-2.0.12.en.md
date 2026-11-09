# AI Buddy 2.0.12

2.0.12 adds voice-profile selection, clearer component verification, and coordinated official voice-plugin registration and version menus. The 30fps and60fps editions have the same features. Existing media, runtimes and large model components are reused.

## Her voice

- Each character row shows her selected profile for the engine being viewed: a short preset label, a custom recording label, no profile, or a read failure.
- With at least two profiles for the current character, Her voice appears beside the import button. Presets come first; recordings are ordered by import time, with dates for duplicate names. Long names stay on one line with a full-name tooltip.
- Changing the voice currently speaking stops that sentence; the next reply uses the new profile. Existing recordings and selections are retained. Galgame remains display-only. Voice packages remain1.0.2 with unchanged references.

## Verify existing components

- After a plugin upgrade, unchanged component files may need their verification receipt rebound. The UI offers Verify instead of suggesting a full download. Verification is explicit, never automatic.
- Verification checks existing files without downloading. A failure offers a new download; a zero-byte download total is hidden while Check again stays available on the right. Missing files retain the not-ready message.
- Components of the other installed engine can be inspected and verified without changing the active engine. Ordinary status reads no longer inspect every model-component file.

## Extensions and compatibility

- Legacy official registrations migrate only after their original signatures, archives and extracted files match. Enabled intent, retained versions, original data paths and voice profiles are preserved.
- Official voice engines appear once under Installed. More contains version selection, coordinated rollback and uninstall while keeping voices/settings. Incompatible historical versions retain their reasons and original signed bytes. The shared runtime follows its engines.
- Entering Extensions refreshes stale catalogs. An installed plugin with a newer compatible release receives an explicit update-version hint.
- Bilibili2.0.15, QQ2.0.9 and Card Games1.1.4 change declarations and documentation only. App/DSH lower bounds accept later stable and prerelease versions by ordering; bridge/API bounds and their existing prerelease rules remain. Runtime code, rules, permissions and data schemas are unchanged. Admission by declaration is not a guarantee for all future runtimes; release compatibility checks still apply.

## Validation scope

The batch covers profile reading/selection, verification without downloads, registration upgrades, coordinated version changes, menus, messages and actual Electron rendering. Upgrade tests use original signed packages, isolated managers and synthetic data. Real-model quality, cloud services, real accounts,10GB component timing and Windows pointer responsiveness have not been revalidated. No new business data-schema migration is introduced for chats, profiles or components.
