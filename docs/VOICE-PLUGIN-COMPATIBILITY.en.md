# Voice plugin interface compatibility

A voice package's major version is its interface version. Starting with 2.0.14, AI Buddy declares support for interface `[1]`: stable `1.x.y` engine and shared runtime packages use the same rule while retaining the existing manifest requirements. Prerelease and build metadata suffixes are unsupported. Each engine must depend on the exact `ai-buddy.voice-shared-runtime` version matching its own version. Source signatures, the manifest's `appRange`, and other compatibility checks still apply.

Future voice packages must declare only a lower bound in `appRange`, for example `>=2.0.14`, without an upper bound. AI Buddy 2.0.12 and 2.0.13 still use the old version list and cannot recognize versions after 1.0.3, so future voice packages must require at least AI Buddy 2.0.14. Published signed manifests remain unchanged.

When changing host voice code, only optional additions are allowed to the launch arguments, input/output protocol, and asset manifest format used by `1.x` voice workers; existing items must keep their behavior. An incompatible change requires `2.x` voice packages and adding `2` to the host's supported interface set, with support for both interfaces `1` and `2` for a transition period.
