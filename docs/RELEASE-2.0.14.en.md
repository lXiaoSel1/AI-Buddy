# AI Buddy 2.0.14

2.0.14 fixes three problems in 2.0.13: official plugins could not start, the voice plugins 1.0.3 could not be enabled after installation, and voice parts and the QQ connection component could not be downloaded. 2.0.13 has been withdrawn; everything else it changed is kept in this version, see the [2.0.13 release notes](RELEASE-2.0.13.en.md). The save formats for chat, memory, wallet, characters, voices and card games are unchanged. The 30fps and 60fps editions have the same features; existing media, runtimes and large model parts are reused.

## Fixes

- Plugins could not start: when 2.0.13 started the plugin runtime, it passed the Windows path of the network preload module straight to Node, which accepts only a file URL there. Bilibili Companion, QQ Connect, Card Games and every other extension on the same runtime failed to start. A file URL is passed now.
- Voice plugins could not be enabled: Voice 1.0.3 was released together with 2.0.13, but 1.0.3 was missing from the voice versions 2.0.13 accepts, so clicking **Enable** after installation reported that the main program has no activation entry for this extension. 2.0.14 adds it and changes how voice plugins are recognized: AI Buddy 2.0.14 supports voice interface major version 1 instead of listing patch versions. A 1.x plugin still has to meet its minimum app version (`appRange`), API, matching shared-runtime and other compatibility and source-trust checks. A patch-number change alone does not require an app update; a higher minimum app requirement or an unsupported interface major version still does.
- Downloads that redirect failed: 2.0.13 sent the app's remote requests through Chromium, which does not let a program inspect redirects itself. Voice parts, the QQ connection component (NapCat) and the bootstrap update of old installations without the maintenance protocol all check the redirect target before downloading, so they failed at the first step; when a model service address redirected, the message asking you to enter the new address directly could not appear either. These requests are now sent by Node and still follow the proxy in **General settings → Network**. Address allowlists, redirect limits, certificate checks and SHA-256 verification are as strict as before.
- Requests sent by Node behave like 2.0.12 again in several places: a request with a body carries `Content-Length` (2.0.13 sent it chunked, which some local model servers reject); `User-Agent`, `Accept` and `Accept-Encoding` are sent by default; each candidate route reports a network timeout if its connection is not established within 10 seconds or its response headers do not arrive within 300 seconds; chat may reach its own idle timeout first. Replies and downloads that keep delivering data have no total time limit. Voice file downloads ask the server not to compress, so the size can be checked against the manifest.
- When the system proxy's PAC script offers both an HTTP and a SOCKS proxy (the default in Clash Verge's PAC mode), 2.0.13 treated the whole answer as unsupported, so components and plugin packages could not be downloaded. The SOCKS entry is now skipped and the remaining HTTP proxy or direct route is used; when only SOCKS is offered, a message asks you to use an HTTP proxy or choose **Do not use** in **General settings → Network**.
- Requests from the main program that do not set their own `User-Agent` now use `AI-Buddy/<version>`; remote requests in 2.0.13 carried a browser identifier. Requests still sent by Chromium, such as CG, quota and cloud voice, show "this port is restricted by the network security policy. Use another port." when the address uses a port Chromium blocks.

## Older problems fixed in this version

- Installing from Discover: **Install…** now installs the newest version this app can use instead of always the newest in the catalog. When none can be used, a message asks you to update AI Buddy or pick an older version under Versions, and Versions shows the app requirement for releases incompatible with the current app version. A fresh installation no longer has to refresh the catalog under Sources before the first voice install. The version shown on the install page is the one that will be installed.
- Mood evaluation: when this model call failed, the app used to retry once a second without stopping (since 2.0.3). Evaluations triggered by chat events now wait 30 seconds, 2 minutes, 10 minutes and then 30 minutes between failed tries, stop after 5 consecutive failures until your next message, and honour any longer wait required by a rate limit. This backoff does not cover scheduled re-evaluations. Background mood and reply-choice requests no longer block switching the chat connection.
- QQ Connect: on the first connection the extracted connection component was sometimes still in use by the system; the app now retries, and if that still fails it asks you to wait a few seconds and click Scan again, with nothing downloaded again.
- Card Games: when a character's model connection changes during a hand, **Continue with the current connection** and **Void this hand** now appear right away, without refreshing first.
- Runtime component: when it is missing, the plugin page offers **Prepare runtime component** directly, and preparation shows how much has been downloaded.
- Other: the Installed count in Extensions includes voice plugins; two strings were translated in the English interface.

## Fixed before release

These were found in real tests before 2.0.14 was released and fixed in the same version:

- When AI Buddy was installed in a deeply nested folder and Windows long-path support was off, the voice engine could fail to start, and Bilibili Companion and QQ Connect could fail to open their databases. They now start normally.
- After importing an old profile, installed plugins keep working: the runtime component is reused and each plugin is installed into the new profile at its existing version.
- While a plugin package is being re-checked, voice is no longer briefly marked as missing a dependency or failing verification.
- When the selected voice engine is not installed but the other one is, a single read error no longer makes the voice entry disappear, and an operation you cancel is no longer shown as a red error.
- When saving a card-table voice record encounters a temporary Windows write denial, the app retries; if it still fails, the failure is reported instead of being dropped silently. The cause of the original denial has not been confirmed.

## Upgrading

- From 2.0.12 or earlier: run the 2.0.14 installer and choose the existing installation folder, or update from General settings.
- From 2.0.13: upgrade the same way; no rollback is needed first. Installed plugins, voice parts and saves are kept.
- There are no new plugin versions: Bilibili Companion 2.0.16, QQ Connect 2.0.10, Card Games 1.1.5 and Voice 1.0.3 are unchanged. Voice 1.0.3 can be enabled only on 2.0.14.

## What was verified

- From this version on, a release must start the plugin runtime on the installed program, install and enable Bilibili Companion, QQ Connect and Card Games, and confirm that each plugin page reaches its own backend; a voice plugin must also install and enable from Extensions. "Extension service ready" alone does not pass. Updating an older plugin after an app upgrade is checked the same way.
- In the checks before release, Group Auto once stopped while waiting for a line to finish showing and did not continue; later runs were fine and the cause is not known yet. If it happens, click **Stop** and start Auto again.
- The network fixes were checked with a real Electron network partition and test servers on the development PC, including real 302 redirects and HTTPS through a proxy. Real platform accounts, paid models, MiniMax cloud voice and real corporate proxies were not tested. SOCKS proxies are still not supported.
