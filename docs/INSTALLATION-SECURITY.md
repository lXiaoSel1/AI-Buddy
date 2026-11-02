# Windows installation prompts and release verification

AI Buddy 1.9.2 currently uses SSH-signed Git release tags. Its update checker
verifies the tag locally against the pinned release public key and checks the
installer and manifest hashes bound into that tag. These checks establish the
release source and file integrity; they are separate from Windows Authenticode.

The current Windows installer, portable launcher and branded runtime do not
have an Authenticode publisher signature. Windows may therefore display an
unrecognized-app or unknown-publisher prompt. Download from the project's
official GitHub release and compare the provided hashes. A GitHub Verified
badge does not mean that Microsoft has reviewed or certified the executable.

GitHub releases: https://github.com/lXiaoSel1/AI-Buddy/releases

## Current signing scope

Windows publisher signing is deferred. No certificate subscription or root
certificate installation is required to use AI Buddy. This build does not
disable SmartScreen or remove Windows download-origin information. SSH
signing and hash checks are retained; Windows prompts are not reported as fixed.

## Future release pipeline

If trusted Windows signing is introduced, finish version/icon changes first,
sign independently copied launcher/runtime binaries, then generate file hashes
and the installation manifest. Build the installer with that final manifest,
sign the installer, copy those exact bytes into each portable package, and only
then generate final checksums and the SSH-signed release tag. Never sign a
hard-linked production file in place or replace an existing release tag/asset.

The signed tag and Windows publisher signature serve different checks and
should both be kept. Even a valid Windows signature does not guarantee that a
new file will immediately have enough SmartScreen reputation to avoid warnings.

Microsoft guidance:
https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
