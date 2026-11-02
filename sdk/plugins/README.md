# AI Buddy official extension package SDK

This first contract accepts official signed prebuilt packages. It does not load
third-party npm packages and does not run install scripts on the user's machine.
The installer application manifest remains separate and unchanged.

## Build a package

Create a manifest template like `kimi-engine/manifest-template.json`. Its `files`
index is generated from a prepared directory. The entry must already be bundled;
do not include development dependencies, credentials, or a runtime you have not
actually built and verified.

```text
node scripts/package-plugin.mjs --manifest=<template.json> --files=<prepared-directory> --out=<new-output-directory> --url=<fixed-HTTPS-release-archive-URL>
node scripts/verify-plugin-package.mjs --entry=<release-entry.json> --archive=<package.zip>
```

The output contains `plugin.json` and exactly the indexed files. ZIP32, UTF-8
names, stored or deflate members, and no links/extra fields/data descriptors are
the supported container subset. `plugin.json` is compared to the signed catalog
manifest; it is excluded from its own file hash list to avoid circular hashes.
Compressed package maximum is 1 GiB; expanded files maximum is 8 GiB.

The Kimi helper bundles the ACP adapter into an optional package:

```text
node scripts/package-kimi-plugin.mjs --out=<new-output-directory> --url=<fixed-HTTPS-release-archive-URL>
```

It does not invent or download a Kimi runtime. `runtime-manifest-template.json`
is not an installable package until real files have been supplied, verified, and
their license/distribution terms checked. No authentication material is bundled.

## Sign catalog metadata

The catalog payload is `{schemaVersion:1,id,generatedAt,packages:[releaseEntry]}`.
Each release entry holds the complete manifest, `archive:{url,bytes,sha256}`,
`publishedAt`, and optional release notes. Canonical bytes are UTF-8 JSON with
object keys sorted recursively, preserved array order, and no trailing newline;
use `canonicalPluginJson()` from `src/plugin-manifest.mjs`.

The envelope is `{payload,signature:{algorithm,keyId,value}}`. The official key
ID is `ai-buddy-release`; it is pinned to the public Ed25519 release identity.
Supported signature encodings are detached Ed25519 base64 (`ed25519`) and
OpenSSH armored SSHSIG (`sshsig`) with the **ai-buddy-plugin-catalog** namespace.
Git tag signatures use a different namespace and cannot authenticate catalogs.
Never accept a public key supplied in the catalog itself. Development test roots
must be injected explicitly in isolated test code and must not enter production.

For SSH signing, write the canonical payload to a file and use your own authorized
release-signing procedure (for example `ssh-keygen -Y sign -n ai-buddy-plugin-catalog`).
The SDK does not find, read, or copy a user's private signing key.

## Offline bundle

```text
bundle/catalog.json                    signed envelope
bundle/packages/<archive-sha256>.zip    each missing dependency and selected package
```

Offline import uses exactly the same signature, compatibility, path, SHA-256, and
dependency checks as online installation. Preview returns a selection token and
fixed plan. Confirmation binds both; renderer requests cannot name arbitrary files.

## Minimal plugin lifecycle

Export `activate(api, context)` and optional `deactivate()`. Activation happens only
after enablement and a declared activation event. The first host API exposes
namespaced commands/settings/panels, per-plugin storage, events, resources, model
and character requests, and Harness registration; each requires its manifest
capability and an actual implemented host service. Missing services fail clearly.
Panels are indexed HTML shown in a restricted host panel, never scripts injected
into the main application document.

The runtime is a utility process with Node privileges, not a hostile-code sandbox.
Only official trusted code may run. Stop removes all registrations/subscriptions;
uninstall preserves profile-local plugin data and character experiences. Code
rollback does not roll back user data or run external commands again.
