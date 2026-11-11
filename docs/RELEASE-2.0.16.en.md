# AI Buddy 2.0.16

This app patch fixes Galgame voice, MiniMax voice preparation, and retrying QQ sign-in by QR code.

- Batch preparation checks voice profiles for the installed engines. You can pick a character with at least one profile. The confirmation shows the actual number of voice clones needed and the estimated cost.
- Cloud voice cloning requires a reference recording of at least 10 seconds. Short recordings are blocked before the cost estimate and upload confirmation. The app checks the duration again before upload. Short recordings still work for local speech.
- Stopping playback skips the current reply's audio while the text continues. Ending Live, canceling a recording, or a microphone access failure keeps a ready speech engine available for the next reply. Canceling Live while speech recognition loads also keeps a speech engine that was ready before Live began.
- Live clears the previous transcript when the next listening turn begins.
- Microphone startup shows **Preparing**. Transcription is shown after you finish speaking.
- Retrying QQ sign-in cleans up the previous attempt before showing a new QR code. Canceling releases the current attempt.

Check for updates under **General settings → Local installation**, or run the 2.0.16 installer and select your existing installation folder. Voice plugin version 1.0.3 remains compatible.
