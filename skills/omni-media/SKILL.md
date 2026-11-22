---
name: omni-media
description: "Use when a task involves media rather than text: watching a video to answer a question about it, transcribing speech, measuring music, generating an image, assembling frames into a film. Covers the choice between drawing something with code and paying a generation model for it. Trigger words: 视频, 字幕, 转写, 分析音频, BPM, 调性, 生图, 配图, 配音, 合成视频, 剪辑, watch this video, transcribe, generate an image."
---

# Media work with dsh-omni

The Host's message model carries only text and images, so "watch this video" and
"listen to this audio" cannot mean handing the model raw media. Everything here
converts: video becomes timestamped grids, audio becomes a transcript plus
measurable features. Read this before choosing a tool — the expensive mistake is
reaching for a generation model when code would do.

## Which tool answers which question

| The question | Tool |
|---|---|
| What is in this file? duration, codec, resolution | `omni_probe` |
| What happens in this video, and when | `video_scan` |
| What does this specific second say | `video_frames` |
| What is being said | `audio_transcribe` |
| What does this music sound like, numerically | `audio_analyze` |
| Say this out loud | `audio_speak` |
| Cut this narration down / stitch takes | `audio_cut` |
| Put frames and audio together | `video_compose` |
| Get the audio out of a video | `video_extract_audio` |
| Draw a new picture | `image_generate` |
| Generate a moving shot | `dsh-remotion` (render code) or `video_compose` (lay out footage) |

## Watching a video: two passes, not one

`video_scan` takes `fps`, `cellWidth`, `from`, `to` and `grid`. **These are yours to
choose** — the tool has no opinion, because the right density depends on what you
already know.

**First pass** — find the structure of something unfamiliar:

```
video_scan({ input, fps: 2, cellWidth: 240, maxCells: 70 })
```

Seventy cells over 35 seconds costs about a second to render. It shows where the
shots change and where text appears, and reports a `timeline` mapping cell number
to second. Read the grid, then name the seconds you care about.

**Second pass** — read one stretch properly:

```
video_scan({ input, from: 24, to: 30, fps: 5, cellWidth: 480 })
```

Nine cells over six seconds at 480 px is where on-screen text becomes legible.

**Third look** — a single exact frame:

```
video_frames({ input, at: [26.5, 28.0], width: 1280 })
```

Full resolution, decoded to the exact frame rather than the nearest keyframe.

### Two facts about the timeline

**The burned-in timecode matches `timeline`.** Both report the file's own clock,
so a cell labelled `00:00:24.000` really is second 24. Quote from the timeline,
not from counting cells.

**Sampling is not exhaustive.** At 2 fps a frame is taken every 0.5 s, so a caption
that appears for 0.3 s can fall between samples. When something looks like it is
changing fast, rescan that range at `fps: 10` instead of guessing.

## Music: numbers, not adjectives

`audio_analyze` returns measured values — `bpm`, `regularity`, `estimatedKey`,
`centroidHz`, `zeroCrossRate`, `lufs`, plus an energy profile per second.

```
bpm: 117.45   regularity: 0.977   estimatedKey: "C major"
centroidHz: 1562.5 (中等)   zeroCrossRate: 0.0779 (中等)
```

Three things to read correctly:

- **`tempo.detected: false`** is a real answer. Ambient beds, speech and
  free-rhythm recordings have no periodic beat; reporting a BPM there would be
  fiction. Do not treat it as a failure.
- **`estimatedKey` is an estimate** from the chroma profile, not a transcription.
  It is right about as often as a careful listener is.
- **The parenthetical readings are derived from the number**, not genre guesses:
  a centroid above 3000 Hz is labelled bright because that is what a high centroid
  means, not because of what the track sounds like.

There is no instrument classifier. If the user asks "what instruments are in this",
say measurement cannot answer that and describe the spectral evidence instead.

## Speech

`audio_transcribe` tries the Host's recogniser first, then a local
faster-whisper model, and reports which route ran. A local run needs no network
and no key; the first call downloads a model.

Model sizes: `tiny` (39 MB, rough), `base` (74 MB), `small` (244 MB, a good
default), `medium` (769 MB). Pass `model` to override the configured default.

If transcription fails with a download error, the mirror is the usual fix — the
plugin already tries `HF_ENDPOINT=https://hf-mirror.com`, but a fully blocked
network needs a model placed in the cache ahead of time.

## Choosing between code and footage

This used to be the decision that costs money. It is not anymore: this bundle
ships no text-to-video API, so a moving picture is either drawn by code or
assembled from footage that already exists.

**Draw it with code when the scene is:**

| Kind | Why code wins |
|---|---|
| Text, titles, captions | `drawtext` / SVG, exact control |
| Charts, counters, progress | numbers are the source, drawing them is trivial |
| Geometry, colour blocks, icons | Canvas / SVG |
| Transitions, masks, fades | ffmpeg filters, reproducible |
| UI walkthroughs | screenshots plus motion |
| Particle and line-growth animation | Canvas's bread and butter |

**Render code to a film with `dsh-remotion`.** That bundle owns the Remotion
project, preview and render loop and writes MP4 locally: free, deterministic, and
it re-renders identically after an edit. Reach for it when the scenes above are
the whole film, or when a shot needs motion that `video_compose` cannot fake from
stills.

**Assemble what already exists with `video_compose`.** Footage, stills and
narration on disk are cheaper to lay together than to re-render.

**There is no paid fallback.** A scene that genuinely needs generated live-action
footage — a real person, a real animal, real water or fire, a material close-up —
is a scene to say out loud and let the user supply the clip. Do not pass a still,
an overlay or a still-frame pan off as the shot they asked for.

## Building a film

`video_compose` takes either or both of:

```
images: [{ path, seconds }]        stills held for a duration
clips:  [{ path, start?, end? }]   footage, optionally trimmed
audio:  path                       laid underneath
```

It normalises every input to one size and frame rate, pads stills to the frame,
and encodes H.264 High / yuv420p / AAC 48 kHz so the result plays anywhere.
Without an audio track it adds silence, so the output is always shaped the same.

The output is a file path. Open it with `video_frames` or `video_scan` to check
what you built — do not assume a render came out right because the command
succeeded.

## Images

`image_generate` reads its provider and model from the plugin settings. Pass
`model` or `providerId` only to override deliberately; letting the conversation
invent a model name produced requests the provider rejected.

Two behaviours that surprise people:

- **A provider may ignore the requested aspect ratio.** Some answer 400 for any
  ratio field and return a shape of their own choosing. The plugin crops to what
  you asked for and says so in `cropped`.
- **The extension follows the bytes, not the declared type.** A base64 response
  with no media type is not necessarily PNG.

## Checking the environment before promising anything

`omni_env_check` reports, per stage: ffmpeg, the Python libraries, downloaded
Whisper models, which interpreter holds which package, and which local generation
services are listening on their ports. Run it first when a user asks for
something that needs a component you have not used yet in this session.

A `pythonConflict` in that report means analysis and speech live in different
interpreters — the plugin handles that, but a hand-written script that tries to do
both in one pass will fail at import time.

## What this plugin does not do

- It does not hand video or audio to the model directly; the Host has no such
  modality. Everything is converted first.
- It does not identify instruments.
- It does not transcribe lyrics reliably from a dense mix; that needs a
  vocal-isolation step first.
- Local generation backends (AUTOMATIC1111, ComfyUI, SwarmUI, sd-server) are
  supported by configuration but were never verified on this machine — if one
  fails, report the error rather than assuming the plugin is broken.
