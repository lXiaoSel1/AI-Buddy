# AI Buddy 2.0.11

2.0.11 supports automatic import of preset voices for all 11 characters from official voice plugins. The 30fps and 60fps editions have the same features.

## Preset voices for both engines

- Preset references ship in the Breeze and GPT-SoVITS 1.0.2 engine packages. The shared runtime is also 1.0.2, and all three packages require host ^2.0.11. The voices are not part of the host media resources or large model component archives.
- Installing or upgrading a voice plugin imports its 11 character profiles from the verified package, for 22 profiles across both engines. Reinstallation and restart reuse existing profiles without creating duplicates.
- A preset can be selected when no selection already exists. Existing selections, custom voices and user reference recordings are preserved without being overwritten.
- References come from the approved r04 material and are not regenerated or transcoded. GPT-SoVITS retains both the short reference and full-length cloud reference; the full-length reference remains local data.

## Change and verification scope

Import does not automatically upload references, create cloned cloud voices or incur cloud speech charges. Cloud services still require the user's own configuration and explicit authorization for the relevant actions.

This release does not claim renewed verification of real-model inference, microphones, cloud speech, actual audio quality or long listening sessions. Existing media, runtime and large model component bytes are reused. Preset import does not migrate the user data format.
