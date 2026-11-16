# Subtitle Player

Watch Hebrew TV episodes that have Hebrew subtitles burned into the picture — with English
subtitles shown exactly where the Hebrew was.

**Everything runs in your browser.** The video is played straight from your own computer and is
never uploaded. Subtitles and edits are saved in your browser only.

## How to use

1. Open the site in **Google Chrome** on a computer (Chrome 138 or newer).
2. **Add episode** → choose a video (MP4, MOV, M4V or WebM).
3. Choose **Play now** (English appears within seconds and keeps up as you watch) or
   **Prepare first** (reads the whole episode in the background while the tab is open).
4. The first time, click once to turn on English — Chrome sets up its built-in Hebrew translator.

Keys: Space play/pause · ←/→ 5 s · S subtitle mode (English / Hebrew / Both / Off) ·
E subtitle list · − / + subtitle size (also the A− / A+ buttons) · F fullscreen · Esc back.

English subtitles sit in one fixed box at the spot where the episode's burned-in Hebrew subtitles are —
same size and position for every line, whatever its length (very long lines shrink slightly to fit).
Subtitle timing is frame-accurate: the scanner reads exact video frames, ~10 times per second of video,
so the English appears and disappears with the Hebrew. Episodes added before this improvement show a
**Redo subtitles** button to re-read them with the new timing.

In the subtitle list, lines the app is unsure of are marked **Check Hebrew**. Fix a Hebrew line and it
is re-translated; or edit the English directly.

## Optional AI polish (Claude)

The **AI polish** button turns on Claude for better accuracy. Clean OCR lines are fixed and translated from
the text by Claude Haiku in batches with the surrounding lines for context; messy lines (low OCR confidence,
or ones Claude can't make sense of) are read from a small snapshot of the subtitle. Measured on a real
episode this costs about $0.05 per episode. Only subtitle text and those snapshots are sent — never the video.
The owner can see spending and tune the trade-offs (picture-reading model, confidence threshold, thinking)
in the AI polish panel.

Calls go through a small relay (`relay/`, a Cloudflare Worker) that holds the API key, only answers this
site, and records token usage and cost. The site owner turns AI on/off for everyone from the AI polish panel
(owner passcode); each viewer can also turn it off for themselves. When AI is off or unavailable, the
free offline method below is used automatically.

## Fast preparation and shared subtitles

- **Fast preparation:** for MP4/MOV files the app reads the compressed frames straight from the file and
  decodes them with Chrome's video decoder in a background worker — roughly 10–20× real time, and it keeps
  going while the tab is in the background. Other formats use the slower playback-based scanner.
- **Shared subtitles:** once an episode is fully prepared with AI polish, its finished subtitles are stored
  on the relay under a fingerprint of the video file (size + three small samples — never the video). Anyone
  who opens the same file gets them instantly: no processing, no AI cost. Edits are shared too.

## How it works

- `scan-worker.js` looks at the bottom of the frame while a hidden copy of the video plays fast-forward,
  detects when a subtitle appears or changes, and isolates the lettering from the background.
- [Tesseract](https://github.com/naptha/tesseract.js) OCR (bundled in `vendor/`) reads the Hebrew.
- Chrome's built-in on-device [Translator API](https://developer.chrome.com/docs/ai/translator-api)
  translates it to English.
- A service worker caches the app so it also works offline after the first visit.

Notes: processing runs only while the tab is open and visible. After the page is closed, Chrome asks
once for permission to read the video file again (or you pick it again).

Third-party: tesseract.js and tesseract.js-core (Apache-2.0), Hebrew traineddata from tessdata (Apache-2.0),
mp4box.js (BSD-3-Clause).
