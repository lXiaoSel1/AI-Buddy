# AI Buddy 2.0.17

- Fixed a Windows path issue that could make GPT-SoVITS fail with ModuleNotFoundError after its components passed verification. Breeze uses its existing startup path.
- Fixed a QQ Connect cleanup issue that could keep sign-in blocked after a temporary QR login process exited without being acquired by the Windows process guard. Retrying application exit now reruns incomplete cleanup.
- This update is delivered by the application. The official voice and QQ plugins retain their current versions.
