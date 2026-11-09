# Build AI Buddy 2.0.10

This guide describes the formal 2.0.10 binary. Development requires Windows x64 and Node.js24. The distributed application does not require a user-installed Node. Use the exact package-lock.json dependency versions.

## Application

1. Run npm ci in this repository. Electron44.6.0 and esbuild0.28.2 are pinned.
2. Extract the approved 2.0.5 release resources for the desired 30fps/60fps edition into an isolated staging root. Reuse immutable asset bytes; do not regenerate animation. Create independent package.json and assets/install-resource-index.json files with application version2.0.10, retaining every asset entry/hash. Never rewrite linked metadata or the original resource tree.
3. Run node scripts/build-public.mjs --resources=<absolute resource root> --out=development --link-assets --public-evidence --bili-ffmpeg-upstream using the published full-index resources. Local production evidence and user data are never published.
4. npm start opens the compiled development app. npm test runs the source test selection. TEST-SCOPE.json records any private Work-plugin or sibling-social integration tests excluded from the public source; their exclusion is not a pass.

Assets are immutable when hard-linked. Never edit a linked output in place. Use a fresh output directory for every candidate; preserve failed evidence. The DSH and FFmpeg component workers are separate ESM entries included in the application inventory. Public candidates must use --bili-ffmpeg-upstream; it cannot be combined with private bundled-media flags. This mode includes only the fixed descriptor, text notices and worker, never a FFmpeg executable or download archive. The public assembler and installer validator reject bundled media binaries. Bilibili plugin installation prepares missing dependencies automatically; no user-installed Node or terminal is required.

## Public distribution

For an incremental official release, prefer `scripts/package-installer-incremental.py` with an explicitly pinned previous public manifest and its SHA-256, both current application candidates, and a current root tree containing the compiled portable launcher. Stage independent current-version package/index headers before running the unchanged public-evidence build gate. The incremental packager verifies complete edition/asset/file maps and every final ZIP payload, hard-links unchanged resource/runtime ZIPs, and repacks only root plus the two application ZIPs. Never rewrite inherited hard-linked metadata. The root tree must include both current release-note languages.

Build the installer from that final manifest with `scripts/prepare-installer.py`, then use `scripts/package-installer-202.py --portable-from-manifest` with the exact root and both build trees. This reconstructs the runtime from the verified reused ZIP and requires the real installer inspect result, including protocol 1 capabilities, before writing portable manager identity. Both portable editions and the installer must appear in the final checksum table. Reusing already verified dependencies, the fixed SDK and an offline NuGet feed does not permit bypassing version, asset or payload checks.

The complete approved inventory is scripts/media-baselines/public-204-assets.json. It pins every distributed resource, its edition/owner, the original media/approval hashes and generated manifest bytes; it contains no private chat or machine path. Application2.0.10, compatible resource release2.0.5 and original media base1.9.2 are separate identities. The public-evidence gate requires application2.0.10 package/index headers in the staging root; resourceBaseVersion does not bypass that gate. The inventory differs from the v2.0.5 source inventory only in applicationVersion. Original approval files are not rewritten.

After both candidates are built, run scripts/build-distribution-202.mjs with --baseline30=<absolute30fpscandidate> --baseline60=<absolute60fpscandidate> --runtime=<absoluteElectronruntime> --out=<freshdisjointoutput> --rcedit=<pinnedrcedit> --public-evidence --link-assets. The runtime is copied before version stamping. Public evidence and private --media-baseline/--media-approval modes cannot be mixed.

scripts/package-installer-202.py consumes the resulting v2 media proof and approved inventory. Its --help documents packaging inputs. It verifies exact files/hashes/owners and splits the resources into the installer's existing package layout. Each release asset must remain below GitHub's2GiB per-file limit. Work plugin packages, local/, credentials, chats, CGs and private test receipts must never enter output.

The installer uses .NET SDK10.0.402 with runtime10.0.13 and installer/AI.Buddy.Setup.csproj. Run packaging first to create the final install manifest and its actual ZIPs, then use scripts/prepare-installer.py. The helper rejects mixed package/lockfile, ReleaseIdentity.Version, project Version/AssemblyName, manifest and embedded app/runtime versions. It streams the real package hashes and payloads, stages only installer sources, the icon and .NET notices in a fresh external directory, and generates installer/generated/install-manifest.json and installer/BuildIdentity.g.cs there from the exact final manifest bytes. Source-generated inputs, immutable resources and media stay untouched. Its --build option publishes with the pinned SDK/locked dependencies and checks the resulting self-contained executable through its real --headless --action=inspect entrypoint.

For a Windows PowerShell release checkout, choose absolute, disjoint directories for the validated distribution, release assets, installer build, offline workspace and preflight evidence. The following pipeline uses the version in package.json; a new official release must first receive its approved version across the normal source/release metadata:

```powershell
$Version = (Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json).version
$Candidate = 'E:\release-work\distribution'
$Release = 'E:\release-work\release-assets'
$InstallerBuild = 'E:\release-work\installer-build'
$Offline = 'E:\release-work\offline-work'
$Preflight = 'E:\release-work\release-preflight'
py -3 -B scripts/package-installer-202.py --candidate $Candidate --output $Release
py -3 -B scripts/prepare-installer.py --manifest "$Release/install-manifest-$Version.json" --output $InstallerBuild --build
py -3 -B scripts/package-installer-202.py --candidate $Candidate --output $Release --offline-only --installer "$InstallerBuild/publish/AI-Buddy-Setup-$Version-win-x64.exe" --portable-output $Offline
# After committing the final reviewed source, prepare a message for review only:
$Source = git rev-parse HEAD
py -3 -B scripts/preflight-installer-release.py --source $Source --manifest "$Release/install-manifest-$Version.json" --installer "$Release/AI-Buddy-Setup-$Version-win-x64.exe" --checksums "$Release/SHA256SUMS-$Version.txt" --output $Preflight
```

The prepare helper without --build writes installer-inputs.json with the exact publish command and staging project path. Run that command from the staged installer directory so global.json selects the pinned SDK. Use a fresh build/output directory after any input change. Portable packaging refuses an installer unless inspect confirms the exact version/manifest and integer appUpdateProtocol:1 plus appBootstrapProtocol:1; only then does it hash the actual copied manager and write managerSha256/managerProtocol to both editions' portable defaults. Missing capability cannot be repaired by writing a support flag.

The release preflight rechecks actual installer inspect, every manifest ZIP/payload and every SHA256SUMS entry, rejects missing or mixed release artifacts, and requires a clean source checkout at the specified full commit. It writes release-preflight.json and unsigned-tag-vVERSION.txt; --tag-message can validate a proposed message instead. It never signs, tags, uploads, installs or promotes a release. Do not report source tests, fixture inspect, preflight or a native build as installed application update acceptance.

## Version and signing

Keep package.json, both root lockfile versions, release.json, installer version/name and README source markers aligned. npm run check:version verifies source/download metadata. Local release metadata is staged before uploading; only actual remote checks establish a published release.

All release tags are SSH-signed locally after explicit per-use approval. Never read, copy, commit or upload the private key. Ordinary source commits do not use the release key. Use only the approved local signer/path. The signed annotated tag binds all six exact lines prepared from verified final artifacts:

```text
Source: <full40charactercommitSHA>
Installer SHA-256: <installerhash>
Manifest SHA-256: <manifesthash>
Checksums SHA-256: <checksumstablehash>
App Update Protocol: 1
App Bootstrap Protocol: 1
```

Push the already verified tag; create a release with --verify-tag and full40character --target. The installer requires verified tag identity and artifact hashes. Verify a non-Latest release before promoting it to Latest. A tag or asset failure stops promotion; never overwrite released bytes under the same version.

LICENSE.md, CONTRIBUTING.md and .github/pull_request_template.md retain their exact approved bytes. Their contents require explicit approval to change. Keep the root license filename LICENSE.md. Third-party runtime/component licenses and existing artwork qualifications remain in the distribution.

Incremental 2.0.10 reuses the exact resource and runtime ZIPs from public 2.0.9; the runtime ZIP is named 2.0.5. Its embedded runtime-manifest.json identifies 2.0.4; release.json therefore declares runtimeBaseVersion 2.0.4 separately from media resourceBaseVersion 2.0.5. Neither the ZIP nor its internal identity is rewritten; complete file and executable digests remain mandatory.
