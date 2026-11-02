# Community publishing kit — local deliverable, not deployed

This directory is a prepared deployment kit for a trusted directory repository such as `AI-Buddy-Extensions`. Nothing here creates a repository, label, Discussion, secret or remote workflow.

Keep the existing `source.json`, `catalog.json`, SSH namespace and legacy package files byte compatible. Publish the new signed directory at a separate endpoint, for example `community/catalog-v1.json`, with `type: ai-buddy-community-catalog` and schema version 1. Its `source.descriptorId` and key fingerprint must match a source that the application already trusts. Never put a signing private key inside a package or repository.

## Deployment prerequisites

1. Review and copy the scripts together with their `src/community`, `src/plugin-manifest`, `src/plugin-catalog`, and `src/plugin-sources` imports, or ship their audited compiled bundle. Include the distribution notices.
2. Enable Issues and Discussions, create the `community-review` label, and copy the Issue Form. Supply each work's actual Discussion URL and `reviewsRepository` in the signed catalog.
3. Configure the directory signing key through the protected `COMMUNITY_SIGNING_KEY_PEM` secret and its public key ID through `COMMUNITY_KEY_ID`. Use only the key matching the already-pinned source. The indexer refuses a different key. This is a deployment prerequisite, not a request to put credentials in chat.
4. Copy the workflow after reviewing repository rules. It fetches every labeled issue with read-only API calls, derives identity from GitHub's user ID, handles edited/deleted/unlabeled entries, and counts only the latest valid rating per user/work. Issue bodies are data and are never evaluated as JavaScript, shell, workflow or instructions.
5. The prepared publisher job is disabled unless the repository owner sets `COMMUNITY_PUBLISH_ENABLED=true`. Before doing so, configure the `community-publication` protected environment and its approval policy. The separate job consumes the signed artifact and commits only the two JSON outputs on the trusted default branch with contents write access. It never executes issue text or an untrusted PR head. Neither the variable nor environment has been configured by this local kit.
6. Read the published index anonymously, verify its signature with the source's public key, and exercise a real form submission → API identity → index → application loop. Until this is done, report C11 as not remotely verified/deployed.

## Data and ranking

Opening a prefilled form is `pending-sync`, not a successful review. A real issue confirmed by the API remains `submitted-pending-sync` until the shared signed index contains the exact ID and update timestamp. Ratings use the latest valid user/work record; old version labels remain visible.

Recommendation uses 65% Bayesian five-star score with a three-star/five-rating prior, 25% `log1p` of a proven 90-day canonical-asset download count, and 10% a 90-day recency decay. Missing components are excluded and remaining weights normalized. Fewer than five ratings are marked insufficient. GitHub stars/reactions are not ratings; download counters are not installation users. The first-party statistics reader returns an unknown 90-day count when cumulative counts cannot establish that window.

## Package checks

`node scripts/community/check-package.mjs --archive=final.tgz --out=package-review.json --sha256=<expected> --name=<exact-package-name> --version=<exact-version>` inspects a final native tarball without executing it. It checks the exact package name/version, structure, paths, collision/link hazards, hashes, compiled entry, patch and license. Lifecycle scripts are reported for explicit approval. The receipt keeps AI review and real DSH runtime validation as `not-run`; this structural report cannot stand in for either. Review the final tarball, rather than a source tree that may differ from what is distributed. Git sources use a full commit and `git-archive-sha256`; generate that digest with clean Git configuration and the canonical command `git -c core.autocrlf=false -c core.eol=lf -c tar.umask=0002 archive --format=tar --prefix=package/ <full-commit>` with `GIT_CONFIG_NOSYSTEM=1` and no global configuration. The archive digest is distinct from the later packed tarball digest.

## Local validation versus deployment

`node scripts/community/build-review-index.mjs --catalog=<signed-or-plain-catalog.json> --repository=<owner/repo> --out=<output.json> --receipt=<receipt.json>` performs only GET calls. Without a configured signing key it writes a local unsigned artifact and labels the receipt `local-artifact-not-deployed`. `--require-signature` fails rather than producing an unsigned shared publication. No local sample rating is shown as public user feedback.
