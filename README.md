# aside

A local meeting companion for a Mac. aside records a call and transcribes it on the Mac with NVIDIA Parakeet. While the call runs, you can ask Claude about it in a side panel. When the call ends, Claude writes the notes. Audio never leaves the Mac. Only text goes to Claude, and only when you allow it.

The idea follows [Muesli](https://github.com/Muesli-HQ/muesli), an open-source Mac app for dictation and meeting notes. aside adds Claude as a live companion during the call.

## Requirements

- An Apple Silicon Mac on macOS 15 or later (the recorder uses ScreenCaptureKit's microphone capture).
- Node 22 or later, [uv](https://docs.astral.sh/uv/), ffmpeg, and the Xcode Command Line Tools (for `swiftc`).
- Claude access: an Anthropic API key, or [Claude Code](https://claude.com/claude-code) on a subscription.

## Quick start

    npm install
    npm run build:capture    # once: the Swift recorder
    ./aside.sh               # starts the server in the background and opens http://127.0.0.1:4318

`./aside.sh stop` stops it, and `./aside.sh log` shows the log. On the page, press Download in the speech model panel. The Parakeet model is about 2.5 GB and lives in the Hugging Face cache.

## A meeting

1. Type a title, and pick the meeting app so that music from other apps stays out of the recording.
2. Answer the required question: "Claude allowed" or "Local only". Use local only for any call that includes patient data. Then no text leaves the Mac: there is no companion and there are no Claude notes, only the transcript.
3. Tell the other people on the call that you are recording.
4. During the call, the transcript grows every 15 seconds. Ask Claude a question in the side panel, and the answer streams in. Claude answers only when you ask.
5. Press "Stop and write notes". aside transcribes the last chunk, writes the notes, and then deletes the audio, unless you ticked "Keep the audio".

If the server stops during a call, the meeting shows as unfinished on the next start. Press "Finish it" to transcribe the rest and write the notes. The same button tries again when the notes failed.

## Where things are

Each meeting is a folder under `meetings/`: `meeting.json` (the settings and the progress), `transcript.json`, `notes.md` and `companion.md` (the questions from the call). Git ignores the folder.

## Redaction

Copy `aside.config.example.json` to `aside.config.json` and edit the patterns. aside deletes each line of the transcript that matches one, before any text goes to Claude. Put your phone number, email address and pay figures there.

## Claude

The page offers three backends:

- API: an Anthropic API key from `ANTHROPIC_API_KEY`, or from the macOS Keychain entry `anthropic-api` (`security add-generic-password -a "$USER" -s anthropic-api -w`).
- Claude Code: headless `claude -p` on your own subscription. Its answers arrive whole, not streamed.
- Auto: the API until its credit runs out, then Claude Code.

By default, headless Claude Code sessions also read your global `~/.claude/CLAUDE.md`. To keep them to aside's own instructions, log in once with a private config folder:

    CLAUDE_CONFIG_DIR="$PWD/.claude-headless" claude    # then type /login, then /exit

## Privacy

- Audio never leaves the Mac. Parakeet transcribes on the device.
- Text goes to Claude only when you ask a question and when the notes are written, and never for a local-only meeting.
- A question across meetings skips the local-only ones.
- The recorder needs Screen Recording and Microphone permission for your terminal (System Settings > Privacy & Security).

## Tests

    npm test

## Credits and licenses

- Speech recognition: [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) (CC BY 4.0), in the [mlx-community MLX conversion](https://huggingface.co/mlx-community/parakeet-tdt-0.6b-v3), run with [parakeet-mlx](https://github.com/senstella/parakeet-mlx) (Apache-2.0).
- Claude: [@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript) (MIT).
- The recorder and the transcript merging come from murmur, by the same author.

aside is released under the MIT license. See `LICENSE`.
