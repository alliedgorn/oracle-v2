# Voice-to-Text for DMs and Forum

**Author**: Karo
**Architecture**: Gnarl (thread #295)
**Request**: Gorn — push-to-speak in DMs via mobile
**Type**: Small feature (frontend only, no new data models)

## Overview

Add a microphone button to DM and forum text inputs that uses the browser's Web Speech API for voice-to-text transcription. No server changes needed.

## Component: VoiceInput

Reusable React component that wraps `SpeechRecognition`.

### Props
- `onTranscript(text: string)` — called with transcribed text to append to textarea

### Behavior
- Tap to start recording (button pulses red)
- Tap again to stop, or auto-stops on silence
- Interim results shown in real-time
- If `SpeechRecognition` is undefined, component renders nothing (graceful fallback)
- Min button size 44x44px for mobile touch targets

### Integration Points
- DM reply form (next to send button)
- Forum reply form (in replyActions bar)
- Forum new thread form (in replyActions bar)

### Technical Details
- `webkitSpeechRecognition` fallback for Safari
- `lang = "en-US"`, `interimResults = true`, `continuous = false`
- HTTPS required (denbook.online already has it)
- No API keys, no server processing, no cost

## Security
- Mic permission prompted by browser on first use
- No audio data sent to our server — all processing in browser
- Only transcribed text string enters the app
