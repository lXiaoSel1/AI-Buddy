# Build AI Buddy from source

Development requires Windows x64 and Node.js 24. The portable app does not.

1. Run `npm ci`.
2. Download and extract the matching portable release ZIP from this repository.
3. Run `node scripts/build-public.mjs --resources="C:/path/to/AI-Buddy/builds/<version>"`. The resource directory is the folder containing `assets/frame-sequence-manifest.json` inside the portable release. This reuses the approved artwork and animation bytes without regeneration.
4. Run `npm start` to launch the compiled app through the development Electron runtime.
5. Run `npm test` for portable pure-logic tests. Native release acceptance scripts and local asset-production evidence are maintained separately; they are not implied by this command.

Do not publish `local/`, generated `builds/`, credentials, user CGs or logs. The resource ZIP is a release asset rather than Git history to keep generated media outside Git history. Upstream/runtime licensing remains in the distributed files.

Source-build output is under `builds/development`. Tests use temporary data and mock services; no paid model request is needed. The source baseline is approved as 1.9.0. Packaging a formal 1.9.0 binary with branded Windows resources and a new fixed distribution manifest is a separate release step; no 1.9.0 download is published yet. Source tests do not certify native integration or visual acceptance.

Keep package.json, both package-lock version fields, release.json and the source-version marker in both READMEs aligned. An approved but unpublished source version retains the actual published download links; do not invent a future installer or ZIP URL. At publication, update the distribution manifest, installer version, release.json publishedVersion/stage and the public download links together. Run `npm run check:version`; the source build runs this same consistency check. Historical validation documents and Git commit messages retain their original versions.

Portable builds compile `scripts/portable-launcher.cs` with the Windows .NET Framework C# compiler using `scripts/build-portable-launcher.mjs`; the file version follows package.json. Only the launcher build needs the compiler, not app users.

The 1.7.5 source build verifies the DeepSeek Galgame WebP and its lossless PNG CG reference against `assets/cg-references/maid-left.source.json`. Use the matching release resources; an older package with the desktop-pet reference is rejected.

## Approved 1.9.0 resource baseline

`release.json` records the explicit 1.8.0 media baseline reused by 1.9.0. A source build may use its own version or that declared baseline, while the portrait, expression and file hash checks remain mandatory. Use the locally approved full 30fps/60fps resource tree for all 264 actions; the public 1.8.0 package alone contains the earlier 198 actions. Do not regenerate media to change the source version.

The checked-in installer remains the published 1.8.0 maintenance client and fixed-manifest contract until the separate 1.9.0 distribution package is prepared. Its existing transaction recovery, manifest hashes and download URLs must not be relabeled. Current build output is local only and is excluded from Git.

## Signed release tags

All new releases require a signed tag created locally. The repository uses SSH signing (`gpg.format=ssh`, `tag.gpgSign=true`) with `~/.ssh/ai-buddy-signing`; the configured public-key path and allowed-signers file must match that identity. Never commit or distribute the private key.

For 1.9.0, run the following only after release approval and the final build and validation checks:

```sh
git tag -s v1.9.0 -m "AI Buddy 1.9.0"
git tag -v v1.9.0
git push origin v1.9.0
gh release create v1.9.0 --verify-tag --notes-file docs/VALIDATION-1.9.0.md <release-assets>
```

Stop if verification fails; the verification output must report `Good signature` for the expected signing identity. Verify an existing tag instead of replacing it. Do not let `gh`, the GitHub website, or a legacy publication script create a tag on the server. `--verify-tag` requires the already-pushed tag; it does not replace the local signature check. Apply the same sequence with the approved version for future releases. These instructions do not authorize publishing a release.

Keep the filename `LICENSE.md`: the distribution builder and installer root-file allowlist package that exact name. Do not rename it or add another root license file. Changes to the contents of `LICENSE.md`, `CONTRIBUTING.md`, or `.github/pull_request_template.md` require explicit user approval; the 1.9.0 license merge imports their exact approved contents from `d8cf74e`.
