# Native DSH author template

This bundle uses the pinned official DSH plugin, tool, connection, module loader and UI-slot contracts. It is not a Buddy-format ZIP and does not require a bespoke adapter. It makes no model requests and has no external account or business effects.

Run `node build.mjs`, then `npm pack --ignore-scripts --pack-destination=<isolated-output>`. Run AI Buddy's non-executing distribution checker against that final tarball. A passing structural check is not native runtime or UI acceptance: install the exact tarball into an isolated DSH profile, invoke `native_template_echo`, open its genuine client page and test its backend request.

The `dsh` engine contract targets the exact official source closure pinned by AI Buddy. Change the npm package name, patch name and client module ID together for your own work. Do not include credentials, user records, dependency caches or a development `node_modules` directory.

This plain template does not claim AI Buddy's per-character storage or memory isolation. A Buddy-specific extension must request its declared capabilities through the versioned Buddy bridge with host-issued contexts; never trust a model-supplied character/life ID or expose all connection secrets. Preserve license notices for any reused code and declare the final distribution's license accurately.
