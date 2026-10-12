# Build AI Buddy from source

Development requires Windows x64 and Node.js 24. The portable app does not.

1. Run `npm ci`.
2. Download and extract the matching portable release ZIP from this repository.
3. Run `node scripts/build-public.mjs --resources="C:/path/to/AI-Buddy/builds/<version>"`. The resource directory is the folder containing `assets/frame-sequence-manifest.json` inside the portable release. This reuses the approved artwork and animation bytes without regeneration.
4. Run `npm start` to launch the compiled app through the development Electron runtime.
5. Run `npm test` for portable pure-logic tests. Native release acceptance scripts and local asset-production evidence are maintained separately; they are not implied by this command.

Do not publish `local/`, generated `builds/`, credentials, user CGs or logs. The resource ZIP is a release asset rather than Git history to keep generated media outside Git history. Upstream/runtime licensing remains in the distributed files.

Source-build output is under `builds/development`. Tests use temporary data and mock services; no paid model request is needed. The formal 1.7.7 binary additionally has branded Windows resources and a release manifest. Source tests do not certify native integration or visual acceptance.

Before a release, update package.json, both package-lock version fields, the current-release links and ZIP names in both READMEs, and the formal version in this guide. Run `npm run check:version`; the source build runs this same consistency check. Historical validation documents and Git commit messages retain their original versions.

Portable builds compile `scripts/portable-launcher.cs` with the Windows .NET Framework C# compiler using `scripts/build-portable-launcher.mjs`; the file version follows package.json. Only the launcher build needs the compiler, not app users.

The 1.7.5 source build verifies the DeepSeek Galgame WebP and its lossless PNG CG reference against `assets/cg-references/maid-left.source.json`. Use the matching release resources; an older package with the desktop-pet reference is rejected.
