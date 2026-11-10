# AI Buddy 2.0.14

2.0.14 fixes three problems in 2.0.13: official plugins could not start, the voice plugins 1.0.3 could not be enabled after installation, and voice parts and the QQ connection component could not be downloaded. 2.0.13 has been withdrawn; everything else it changed is kept in this version, see the [2.0.13 release notes](RELEASE-2.0.13.en.md). The save formats for chat, memory, wallet, characters, voices and card games are unchanged. The 30fps and 60fps editions have the same features; existing media, runtimes and large model parts are reused.

## Fixes

- Plugins could not start: when 2.0.13 started the plugin runtime, it passed the Windows path of the network preload module straight to Node, which accepts only a file URL there. Bilibili Companion, QQ Connect, Card Games and every other extension on the same runtime failed to start. A file URL is passed now.
- Voice plugins could not be enabled: Voice 1.0.3 was released together with 2.0.13, but 1.0.3 was missing from the voice versions 2.0.13 accepts, so clicking **Enable** after installation reported that the main program has no activation entry for this extension. 2.0.14 adds it and changes how voice plugins are recognized: the app now goes by the major version, so every 1.x voice plugin is accepted. A later release such as 1.0.4 will not need an app update first, and after an app update the 1.x voice plugin you already have does not need updating. Only a 2.x voice plugin will need a newer app.
- Downloads that redirect failed: 2.0.13 sent the app's remote requests through Chromium, which does not let a program inspect redirects itself. Voice parts, the QQ connection component (NapCat) and the bootstrap update of old installations without the maintenance protocol all check the redirect target before downloading, so they failed at the first step; when a model service address redirected, the message asking you to enter the new address directly could not appear either. These requests are now sent by Node and still follow the proxy in **General settings → Network**. Address allowlists, redirect limits, certificate checks and SHA-256 verification are as strict as before.
- Requests sent by Node behave like 2.0.12 again in several places: a request with a body carries `Content-Length` (2.0.13 sent it chunked, which some local model servers reject); `User-Agent`, `Accept` and `Accept-Encoding` are sent by default; a connection that is not established within 10 seconds, or response headers that do not arrive within 300 seconds, report a timeout, while replies and downloads that keep delivering data have no total time limit. Voice file downloads ask the server not to compress, so the size can be checked against the manifest.
- When the system proxy's PAC script offers both an HTTP and a SOCKS proxy (the default in Clash Verge's PAC mode), 2.0.13 treated the whole answer as unsupported, so components and plugin packages could not be downloaded. The SOCKS entry is now skipped and the remaining HTTP proxy or direct route is used; when only SOCKS is offered, a message asks you to use an HTTP proxy or choose **Do not use** in **General settings → Network**.
- Requests from the main program that do not set their own `User-Agent` now use `AI-Buddy/<version>`; remote requests in 2.0.13 carried a browser identifier. Requests still sent by Chromium, such as CG, quota and cloud voice, show "this port is restricted by the network security policy. Use another port." when the address uses a port Chromium blocks.

## Older problems fixed in this version

- Installing from Discover: **Install…** now installs the newest version this app can use instead of always the newest in the catalog. When none can be used, a message asks you to update AI Buddy or pick an older version under Versions, and Versions shows the app version each release needs. A fresh installation no longer has to refresh the catalog under Sources before the first voice install. The version shown on the install page is the one that will be installed.
- Mood evaluation: when this model call failed, the app used to retry once a second without stopping (since 2.0.3). It now waits 30 seconds, 2 minutes, 10 minutes and then 30 minutes between tries, stops after 5 failures in a row until your next message, and honours the wait a rate-limited service asks for. Background mood and reply-choice requests no longer block switching the chat connection.
- QQ Connect: on the first connection the extracted connection component was sometimes still in use by the system; the app now retries, and if that still fails it asks you to wait a few seconds and click Scan again, with nothing downloaded again.
- Card Games: when a character's model connection changes during a hand, **Continue with the current connection** and **Void this hand** now appear right away, without refreshing first.
- Runtime component: when it is missing, the plugin page offers **Prepare runtime component** directly, and preparation shows how much has been downloaded.
- Other: the Installed count in Extensions includes voice plugins; two strings were translated in the English interface.

## Upgrading

- From 2.0.12 or earlier: run the 2.0.14 installer and choose the existing installation folder, or update from General settings.
- From 2.0.13: upgrade the same way; no rollback is needed first. Installed plugins, voice parts and saves are kept.
- There are no new plugin versions: Bilibili Companion 2.0.16, QQ Connect 2.0.10, Card Games 1.1.5 and Voice 1.0.3 are unchanged. Voice 1.0.3 can be enabled only on 2.0.14.

## What was verified

- From this version on, a release must start the plugin runtime on the installed program, install and enable Bilibili Companion, QQ Connect and Card Games, and confirm that each plugin page reaches its own backend; a voice plugin must also install and enable from Extensions. "Extension service ready" alone does not pass. Updating an older plugin after an app upgrade is checked the same way.
- The network fixes were checked with a real Electron network partition and test servers on the development PC, including real 302 redirects and HTTPS through a proxy. Real platform accounts, paid models, MiniMax cloud voice and real corporate proxies were not tested. SOCKS proxies are still not supported.
