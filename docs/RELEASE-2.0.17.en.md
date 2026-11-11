# AI Buddy 2.0.17

This app update includes voice, QQ Connect, and save protection fixes since 2.0.15. Your installed voice and QQ plugins continue to work with these changes.

## Voice

- Fixed a Windows startup path that could make GPT-SoVITS report `ModuleNotFoundError` after component verification passed. Breeze keeps its existing startup path.
- Stop reading skips the current reply's audio. Ending Live, cancelling a recording, or a microphone access failure leaves an already-ready speech engine available for the next reply. Cancelling Live while speech recognition is loading also keeps an already-ready speech engine available.
- Live clears the previous transcript when it starts listening again. The microphone shows Preparing during startup and Recognizing after recording finishes.
- Bulk preparation checks the installed voice engines and shows the count and estimated cost for the voices that need cloning. Cloud cloning requires a reference recording of at least 10 seconds. Shorter recordings are rejected before an estimate or upload confirmation and remain usable for local voice.

## QQ Connect

- Fixed a case where QR sign-in could remain blocked after the temporary sign-in process had exited. Retrying sign-in or exiting the app resumes incomplete cleanup and can recover once a stop-receipt file lock clears.
- Cancelling QR sign-in during preparation now waits for the profile reservation to be released, so you can start a new scan immediately after cancellation completes.

## Save protection

- Startup and import verify companion snapshots. If the newest snapshot is missing or fails verification, the app can use an earlier verified snapshot. If existing snapshot records cannot be read, the app keeps the original files and history.
- Galgame and the extension center can still start when the social account database is unreadable. QQ and Bilibili account actions that use that database pause, show diagnostics, and check again at the next launch.

Check for updates under General settings → Local installation, or run the 2.0.17 installer and choose your existing installation folder.
