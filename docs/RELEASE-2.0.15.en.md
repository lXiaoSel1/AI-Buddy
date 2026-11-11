# AI Buddy 2.0.15

This app patch fixes Galgame staying on “Listening” after you click **End Live**. A late response from an old recording could trigger a second stop and interrupt the status refresh.

- **End Live** releases microphone capture for the session and immediately brings back the text box. The voice indicator says **Ending voice session** while cleanup finishes.
- Live discards late recognition results after you end the session. Canceling the next listening turn no longer reports a voice error or sends another message.

Check for updates under **General settings → Local installation**, or run the 2.0.15 installer and choose your existing installation folder. Your saves and custom voices carry over. The fix works with your current voice plugin.
