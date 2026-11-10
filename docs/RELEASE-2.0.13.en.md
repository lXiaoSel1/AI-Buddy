# AI Buddy 2.0.13

2.0.13 fixes installation, networking and recovery after interrupted plugin work, adds local installation and network settings, and corrects false voice-component verification failures. The 30fps and 60fps editions have the same features. Existing media, runtimes and large model components are reused.

## Installation, upgrades and extensions

- The installer reuses unchanged packages only after checking their recorded hashes and actual files. An upgrade no longer downloads every character, motion and runtime package again. Packages with missing records, missing files or mismatched contents still need downloading. Download estimates exclude reusable files and verified cache entries.
- Complete packages include 安装或更新 AI 酱.cmd (install or update AI Buddy). After extraction, run AI Buddy.exe directly or use this entry to install elsewhere or upgrade an existing installation offline. It copies program files from the manifest, without importing personal data from the source folder. Required local files that are missing or damaged stop installation instead of triggering an online download. Local sources hide download-mirror inputs.
- Fixes stale extension catalogs after service recovery and update preferences left behind during official-source migration. Incompatible installed versions show a reason, with an update action when a compatible release exists.
- Fixes `APP_UPDATE_FAILED` when a complete package checks for updates before its transaction directory exists. Moving the folder continues to use the real installation identity checks.
- A successful rollback consumes its rollback record. Before rolling back to 2.0.11 or earlier, the installer explains that voice plugins need reinstalling while character voices and settings are retained.

## Network settings

- General settings → Network offers Follow system (default), Manual and Do not use, with HTTP/HTTPS proxy support. Test checks the extension catalog using the current settings. Connected request paths include Extensions, managed component downloads, model lists and chat, updates and cloud voice. The installer reads the same settings.
- GitHub and HuggingFace mirrors are blank by default and accept HTTPS origins only. Paths and query parameters remain unchanged. Files retain size and SHA-256 checks; catalogs and updates retain signature verification. A mirror mismatch offers a one-time Retry from the official source without changing the saved mirror.
- Large downloads retain partial data for a later attempt. Connection and idle waits have timeouts; downloading has no fixed overall duration limit. Connection, timeout, rate-limit, certificate and mirror errors receive specific explanations, with technical codes available in details.
- Local-network model endpoints can use HTTP without a key, with an unencrypted-connection notice. Supported ranges include 10.x, 172.16–31.x, 192.168.x and .local. Trailing /chat/completions and /models paths are normalized. Kimi and MiniMax offer Mainland China and International regions, each requiring the corresponding key.
- These settings cover integrated AI Buddy request paths. NapCat's own networking, external command-line tools, Git and every third-party request are not guaranteed to follow them. SOCKS is not supported. Support for an official update-proof artifact during GitHub rate limits is prepared; its production path requires the corresponding signed, public artifact.

## Voice

- File-access notifications no longer treat unchanged contents as a failed verification. Progress is saved for stable files and reused while their identities still match. Startup avoids a second complete verification. Missing files or hash mismatches lead to Download; changes during verification or an interruption lead to Verify again.
- All three voice packages are 1.0.3 and require AI Buddy 2.0.13. Both engines depend on shared runtime 1.0.3 exactly. Preset reference recordings retain their original bytes.
- MiniMax cloud voice supports Mainland China and International accounts with separate keys and follows the configured network proxy. Only confirmed expired voices offer Clone again…, through the existing cost confirmation. Unknown results are not treated as expiry and never trigger an automatic new charge.

## Companion features and official plugins

- Daily CG uses the computer's system time at 10:00 and 22:00. After restart, Group Auto with an unresolved request shows The previous turn did not finish. You can explicitly Continue with the next member or Stop Auto; an unknown result is not resent. Recent history is bounded while deduplication evidence is retained separately.
- Bilibili Companion 2.0.16 lets confirmed readings continue across midnight, counted against the day they started. New automatic starts retain date and time-window checks. An expired login pauses reading and asks for a new scan without calling the model; platform request restrictions have a separate explanation. Media or subtitle timeouts retain material already prepared.
- QQ Connect 2.0.10 retries an unexpected disconnect only with restore-on-start enabled for the same account and character. Increasing intervals stop after five consecutive failed attempts. Explicit disconnect, revoked authorization and identity changes do not automatically reconnect. Backlogs retain durable reception and conversation order with bounded concurrency. Changing reply style keeps replies in progress. Shutdown manages only the NapCat instance started by AI Buddy.
- QQ keeps its existing message-time window; no automatic network-clock correction was added. A slow clock can produce a warning, while a fast clock can silently reject some messages. Sync the Windows clock if messages stop arriving. Correct reception with an inaccurate clock is not guaranteed.
- Card Games 1.1.5 with AI Buddy 2.0.13 offers Continue with the current connection after a character's connection changes, or Void this hand to return reserved points without a win or loss. Hold'em blind transitions after player-count changes are corrected. Recent table chat is bounded and complete chat is paged separately. Rules, assets and existing permissions are unchanged.

## When quitting fails

- Once some services have stopped, Quit and reopen retries only unfinished steps, without repeating completed saves. Later keeps new activity blocked. A second failure identifies the unfinished steps.
- Reopen anyway appears only after preparation, plugin shutdown and every saving step are confirmed complete. Unconfirmed saving or final cleanup prevents forced reopening. Some database or stream failures remain unconfirmed until the underlying problem is handled. Closed business stores are not presented as restored in place. Exiting for an update does not use the reopen flow.

## Validation scope

The batch reuses applicable earlier evidence and checks affected paths using isolated data, production modules, controlled proxies and simulated platform responses. Component pages and installer messages have Chinese and English UI evidence. Real platform accounts, paid models or cloud voice, corporate proxies/PAC, full large-component verification timing and Windows-wide responsiveness have not been tested; these issues cannot all be described as resolved. A production in-app update after moving a complete package still requires full validation after signing and public candidate publication. These notes do not establish signing, public release or acceptance of the everyday installation.
