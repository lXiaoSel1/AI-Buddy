# Build AI Buddy 2.0.3

This guide describes the formal 2.0.4 binary. Development requires Windows x64 and Node.js24. The distributed application does not require a user-installed Node. Use the exact package-lock.json dependency versions.

## Application

1. Run npm ci in this repository. Electron44.6.0 and esbuild0.28.2 are pinned.
2. Extract the approved 2.0.2 release resources for the desired 30fps/60fps edition into an isolated staging root. Reuse immutable asset bytes; do not regenerate animation. Create independent package.json and assets/install-resource-index.json files with application version2.0.3, retaining every asset entry/hash. Never rewrite linked metadata or the original resource tree.
3. Run node scripts/build-public.mjs --resources=<absolute resource root> --out=development --link-assets --public-evidence --bili-ffmpeg-upstream using the published full-index resources. Local production evidence and user data are never published.
4. npm start opens the compiled development app. npm test runs the source test selection. TEST-SCOPE.json records any private Work-plugin or sibling-social integration tests excluded from the public source; their exclusion is not a pass.

Assets are immutable when hard-linked. Never edit a linked output in place. Use a fresh output directory for every candidate; preserve failed evidence. The DSH and FFmpeg component workers are separate ESM entries included in the application inventory. Public candidates must use --bili-ffmpeg-upstream; it cannot be combined with private bundled-media flags. This mode includes only the fixed descriptor, text notices and worker, never a FFmpeg executable or download archive. The public assembler and installer validator reject bundled media binaries. Bilibili plugin installation prepares missing dependencies automatically; no user-installed Node or terminal is required.

## Public distribution

The complete approved inventory is scripts/media-baselines/public-203-assets.json. It pins every distributed resource, its edition/owner, the original media/approval hashes and generated manifest bytes; it contains no private chat or machine path. Application2.0.3, compatible resource release2.0.2 and original media base1.9.2 are separate identities. The public-evidence gate requires application2.0.3 package/index headers in the staging root; resourceBaseVersion does not bypass that gate. The new inventory differs from public-202-assets.json only in applicationVersion. Original approval files are not rewritten.

After both candidates are built, run scripts/build-distribution-202.mjs with --baseline30=<absolute30fpscandidate> --baseline60=<absolute60fpscandidate> --runtime=<absoluteElectronruntime> --out=<freshdisjointoutput> --rcedit=<pinnedrcedit> --public-evidence --link-assets. The runtime is copied before version stamping. Public evidence and private --media-baseline/--media-approval modes cannot be mixed.

scripts/package-installer-202.py consumes the resulting v2 media proof and approved inventory. Its --help documents packaging inputs. It verifies exact files/hashes/owners and splits the resources into the installer's existing package layout. Each release asset must remain below GitHub's2GiB per-file limit. Work plugin packages, local/, credentials, chats, CGs and private test receipts must never enter output.

The installer uses .NET SDK10.0.402 with runtime10.0.13 and installer/AI.Buddy.Setup.csproj. Prepare generated/install-manifest.json only from the final package manifest, then publish the self-contained win-x64 installer. Do not report a source-only test as native installer acceptance.

## Version and signing

Keep package.json, both root lockfile versions, release.json, installer version/name and README source markers aligned. npm run check:version verifies source/download metadata. Local release metadata is staged before uploading; only actual remote checks establish a published release.

All release tags are SSH-signed locally after explicit per-use approval. Never read, copy, commit or upload the private key. Ordinary source commits do not use the release key. Use only the approved local signer/path. The signed annotated tag binds three exact lines:

Source: <full40charactercommitSHA>
Manifest SHA-256: <manifesthash>
Installer SHA-256: <installerhash>

Push the already verified tag; create a release with --verify-tag and full40character --target. The installer requires verified tag identity and artifact hashes. Verify a non-Latest release before promoting it to Latest. A tag or asset failure stops promotion; never overwrite released bytes under the same version.

LICENSE.md, CONTRIBUTING.md and .github/pull_request_template.md retain their exact approved bytes. Their contents require explicit approval to change. Keep the root license filename LICENSE.md. Third-party runtime/component licenses and existing artwork qualifications remain in the distribution.
