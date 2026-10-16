# aside

aside is a meeting companion that runs on your Mac. It records a call and transcribes it on the Mac with NVIDIA Parakeet. During the call, you can ask Claude about what people said. After the call, Claude writes the notes.

The audio stays on the Mac. Claude gets only text, and only for a meeting where you allow it.

aside follows the idea of [Muesli](https://github.com/Muesli-HQ/muesli), an open-source Mac app for dictation and meeting notes. aside adds Claude as a companion that you can ask during the call.

## Requirements

- An Apple Silicon Mac with macOS 15 or later. The recorder uses ScreenCaptureKit to capture the microphone and the call audio.
- Node 22 or later, [uv](https://docs.astral.sh/uv/), ffmpeg, and the Xcode Command Line Tools (for `swiftc`).
- Access to Claude: an Anthropic API key, or [Claude Code](https://claude.com/claude-code) with a subscription.

## Install and start

```sh
npm install
npm run build:capture    # builds the Swift recorder, one time only
./aside.sh               # starts the server and opens http://127.0.0.1:4318
```

On the page, press Download in the speech model panel. The Parakeet model is about 2.5 GB, and it goes to the Hugging Face cache. To stop the server, run `./aside.sh stop`. To read its log, run `./aside.sh log`.

## Menu-bar app

The menu-bar app runs aside without a terminal. Build it one time:

```sh
sh app/make-cert.sh    # makes a local signing certificate, one time only
npm run build:app      # builds and installs ~/Applications/aside.app
```

The local certificate signs every build with the same identity, so macOS keeps the permissions of aside after a rebuild. To build the app again after a change, run `npm run build:app` again.

Open aside from `~/Applications`. The app starts the server itself. If a server that `./aside.sh` started already runs, the app uses that server. The first time that aside records, macOS asks for Microphone and Screen Recording permission for aside. Grant both. After the Screen Recording grant, macOS can ask you to quit and reopen aside.

The menu has these items:

- Open aside: opens the page in a window.
- Start meeting: starts a recording with "Local only" or "Claude allowed".
- Stop and write notes: stops the recording, and Claude writes the notes.
- Show panel: shows the floating panel with the live transcript and the question box.
- Recent meetings: opens the notes of one of the 5 newest finished meetings.
- Preferences…: opens the preferences window, with the hot keys, the meeting detection, the meeting defaults, and the login item.
- Quit aside: stops the server that the app started. If a meeting records, aside stops the recording first. The meeting stays unfinished, and "Finish it" writes the notes later.

If the server fails, the menu also shows "Restart server" and "Show log". `./aside.sh stop` stops any server on port 4318, also the server that the app started. The app then starts its server again.

Two hot keys work in every app. ⌥⌘A opens aside. During a "Claude allowed" meeting, ⌥⌘K shows the panel and puts the cursor in the question box. To change a hot key, open Preferences. A hot key needs two modifier keys, and one of them must be Command or Control.

When an app in the Meeting detection list holds the microphone for 5 seconds, the floating panel asks "Record this meeting?". Choose "Local only", "Claude allowed", or "Not now". If you do not answer and the call ends, the question closes. To turn detection off or to change the list of apps, open Preferences.

10 seconds after the call app releases the microphone, the panel starts a countdown. aside stops the recording and writes the notes 2 minutes after the release, unless you press "Keep recording". aside stops a recording by itself only when a listed app held the microphone during the recording.

Until you download the speech model, aside does not ask to record, and "Start meeting" is off. The speech model loads when a meeting starts, and it unloads 10 minutes after the last meeting. If uv is missing, the speech worker cannot start. The page then shows the error, and the panel shows it during a meeting.

To start aside each time that you log in, turn on the login item in Preferences.

To use aside only in the browser, without the menu-bar app, start it with `./aside.sh` as in "Install and start".

## Record a meeting

1. Type a title. In "Record call audio from", pick the meeting app, so that sound from other apps stays out of the recording.
2. Choose "Claude allowed" or "Local only". aside asks again for every meeting. With local only, no text leaves the Mac: you get the transcript, but no answers from Claude and no notes.
3. Tell the other people on the call that you record it.
4. Press "Start recording". The transcript grows every 15 seconds. To ask about the call, type a question under "Ask Claude", and the answer streams in. Claude answers only when you ask.
5. Press "Stop and write notes". aside transcribes the last part of the call, and Claude writes the notes. Then aside deletes the audio, unless you ticked "Keep the audio after the notes".

If the server stops during a call, the meeting shows as unfinished the next time aside starts. Press "Finish it" to transcribe the rest of the audio and write the notes. If the notes fail, press the same button to try again.

## Ask about past meetings

In the Meetings list, tick one or more meetings and type a question. Claude answers from their notes and names the meeting that each fact comes from. You cannot tick a local-only meeting.

## Files

Each meeting is a folder in the meetings folder. By default, that is `meetings/`, and git ignores it. To use another folder, set "Meetings folder" in Preferences. The change takes effect the next time aside starts. Older meetings, also unfinished ones, stay in the old folder.

- `meeting.json`: the settings and the progress.
- `transcript.json`: the transcript, with a start and an end time for each line.
- `notes.md`: the notes, followed by the full transcript.
- `companion.md`: each question that you asked during the call, with its answer.

## Keep text away from Claude

Copy `aside.config.example.json` to `aside.config.json`, and put your patterns (regular expressions) in the `redact` list. Before any transcript or notes go to Claude, aside leaves out each line that matches a pattern. The match ignores case.

## Choose how aside reaches Claude

The Claude menu on the page has three choices:

- API credit: an Anthropic API key from `ANTHROPIC_API_KEY`, or from the macOS Keychain item `anthropic-api`. To store the key there, run `security add-generic-password -a "$USER" -s anthropic-api -w`.
- Claude Code (subscription): headless `claude -p` on your own subscription. Its answers arrive whole, not streamed.
- Auto: the API until its credit runs out, then Claude Code.

By default, headless Claude Code also reads your global `~/.claude/CLAUDE.md`. To give it only the instructions from aside, log in one time with a separate configuration folder. aside uses that folder when it exists.

```sh
CLAUDE_CONFIG_DIR="$PWD/.claude-headless" claude    # type /login, then /exit
```

## Privacy

- Parakeet runs on the Mac, so the audio never leaves it.
- Text goes to Claude only when you ask a question or when Claude writes the notes. Text never goes to Claude for a local-only meeting.
- The recorder needs Screen Recording and Microphone permission for the app that starts the server. That app is your terminal app with `./aside.sh`, or aside with the menu-bar app. Grant them in System Settings > Privacy & Security.

## Tests

```sh
npm test
```

## Credits and licenses

- Speech recognition: [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) (CC BY 4.0), in the [mlx-community MLX conversion](https://huggingface.co/mlx-community/parakeet-tdt-0.6b-v3), run with [parakeet-mlx](https://github.com/senstella/parakeet-mlx) (Apache-2.0).
- Claude: [@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript) (MIT).
- The recorder and the transcript merging come from another project of mine, [1Mangesh1](https://github.com/1Mangesh1).

aside uses the MIT license. See `LICENSE`.
