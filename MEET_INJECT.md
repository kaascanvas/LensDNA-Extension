# Meet dual audio (v1.2.0)

One 🎧 button. Default off.

When armed:

- **Out:** Nexus TTS mixes into your Meet microphone. Boardy hears Nexus on your seat.
- **In:** Meet playback is fed into Nexus so the agent can hear Boardy with headphones on.

No VB-Cable. Chrome Meet tab only.

## Install

Copy into the unpacked extension folder:

- `inject-meet-mix.js`
- `manifest.json`
- `content.js`
- `background.js`
- `sidepanel.html`
- `sidepanel.js`

Then `chrome://extensions` → LensDNA → **Reload**. Hard-refresh the Meet tab.

## Use

1. Open Meet in this Chrome profile. Headphones on.
2. Side panel → INITIATE UPLINK.
3. Click **🎧**. Amber = dual audio on.
4. Stay **unmuted** in Meet. Mute kills both you and Nexus.
5. Sit on camera. Stay quiet. Nexus talks. Nexus also hears the room.

If uplink was already live and Nexus does not react to Boardy, DISCONNECT then INITIATE UPLINK while 🎧 stays armed. ElevenLabs grabs the mic once at session start.

## How the ear works

1. `tabCapture` of the Meet tab (best).
2. Fallback: `captureStream()` on Meet `<audio>` / `<video>` elements, PCM relay to the side panel.

Your voice and Meet playback are mixed, then handed to ElevenLabs through a `getUserMedia` wrap. While Nexus is speaking, Meet→Nexus gain is ducked so it does not talk over its own echo.

## Still true

- One tile: you. Not a second participant.
- Zoom desktop / Meet mobile: no hook.
- Speakers + 🎧 = echo. Headphones required.
