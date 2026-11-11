# AI Buddy 2.0.16

This app patch fixes four issues with MiniMax batch voice preparation and voice in Galgame.

- Batch preparation checks voice profiles for the installed engines. You can pick a character with at least one profile. The confirmation shows the actual number of voice clones needed and the estimated cost.
- Ending Live, canceling a recording, or stopping playback in chat keeps the prepared speech engine available for the next reply. Canceling Live while speech recognition loads also keeps a speech engine that was ready before Live began.
- Live clears the previous transcript when the next listening turn begins.
- Microphone startup shows **Preparing**. Transcription is shown after you finish speaking.

Check for updates under **General settings → Local installation**, or run the 2.0.16 installer and select your existing installation folder. Voice plugin version 1.0.3 remains compatible.
