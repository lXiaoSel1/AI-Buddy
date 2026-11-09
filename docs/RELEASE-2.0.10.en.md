# AI Buddy 2.0.10

2.0.10 fixes a voice warning appearing in chat when no voice engine is installed. The 30fps and 60fps editions have the same features.

## Voice warnings in chat

- Chat hides the voice warning when component status explicitly shows that no supported voice engine is installed.
- Existing warnings remain for installed engines that are disabled or faulty. Unknown component status retains its existing handling and is not treated as an absent installation.

## Change and verification scope

This fix only changes when the chat voice warning is shown. It does not change models, network access, plugins or user data behavior.

This fix does not constitute full voice acceptance. Real-model loading, cloud speech, microphones and long listening sessions still require separate verification.
