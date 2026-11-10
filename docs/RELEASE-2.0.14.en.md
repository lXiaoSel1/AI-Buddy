# AI Buddy 2.0.14 (unpublished fix candidate)

2.0.13 has been withdrawn. Stay on 2.0.12, or use the installer to roll back if you already upgraded. This candidate fixes Windows plugin startup and network transport regressions without changing chat, memory, wallet, character, voice or game data formats.

- Use a file URL for the DSH network preload, fixing startup of Bilibili Companion, QQ Connect, Card Games and related backends.
- Route requests that inspect redirects through a transport that supports manual redirects, with the same proxy configuration. Keep address allowlists, redirect restrictions, TLS and digest verification for voice, NapCat, legacy bootstrap and model requests.
- Restore buffered request lengths, default headers, connection/header deadlines and response URL metadata in the Node transport. Healthy streaming responses have no total-duration limit. Voice downloads explicitly request identity encoding.
- Identify the network partition with the AI Buddy version and explain Chromium-blocked ports with a specific error.

Existing media, animation editions and runtimes are reused. No plugin business logic or plugin package is changed. Voice 1.0.3 still requires app >=2.0.13, which includes 2.0.14.

Production regressions, actual Electron transport and final installed-candidate checks are reported separately. Extension-service readiness does not prove a plugin page handshake. Real accounts, paid models, MiniMax cloud synthesis and enterprise proxy environments are not part of automated acceptance. See the repair report for the final results. Publication, daily installation and Latest promotion each require user confirmation.
