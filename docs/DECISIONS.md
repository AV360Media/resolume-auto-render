# Decisions

Each entry: what was decided, why, and what it costs.

## 1. Companion app, not an FFGL plugin
FFGL plugins render frames on the GPU. They cannot watch files, run encoders or change clips. The app runs beside Arena and uses Arena's REST and WebSocket API.

## 2. API facts come from docs, not a live Arena (yet)
The build machine had no Arena. Endpoints come from Resolume's docs and the Bitfocus Companion module, which talks to live Arena (see docs/DISCOVERY.md). Anything not confirmed there is treated as uncertain and has a fallback:
- Clip file loads may not be pushed over the WebSocket. The app also polls `GET /composition` every 2 s (configurable, 0 disables).
- `by-id` clip endpoints may not exist on every version. The swapper falls back to `layers/{l}/clips/{c}` after confirming the clip id at that position.
- The open body format (`file:///path`, raw) matches what Companion sends. A percent-encoded variant is a setting in case raw fails for unusual characters.
- `npm run check-arena` verifies all of this on a real machine and saves the live schema if Arena serves one.

## 3. Detection: diff the composition by clip id
Every composition snapshot (WebSocket or poll) is flattened to `clip id -> file path`. A changed or new path on a known id is a "new file". The first snapshot after connecting is a baseline and is not converted (option: convert clips already loaded). A snapshot in which no previous clip id survives (Arena restarted, another composition opened) is also a baseline, and so is the first snapshot after the WebSocket drops. Cost: a file loaded while the app was disconnected is not converted automatically.

## 4. Swap safety
Before loading the DXV, the app re-reads the clip. If its path is no longer the original, it does not touch it. After loading it waits until Arena reports the new path; if Arena never does, it re-opens the original. Name and `transport` values are written back with `PUT` (ids stripped). `transport.position` is not restored because it belongs to the old file's timeline.

What cannot be guaranteed (unverified on live Arena, check with `npm run check-arena -- --try-open`):
- Whether Arena keeps clip video effects, crop/transform and audio settings when a new file is opened into a clip. The app does not copy effects; it relies on Arena keeping them.
- Cue points, beat-snap and BPM sync values outside `transport` are not restored.
- By default the swap waits while the clip is playing (its `connected` value starts with "Connected"), so nothing reloads on stage. "Swap clips while playing" turns this off. The exact option strings of `connected` are unverified.

## 5. Encoder selection
Backends are tried in the brief's order: Alley CLI, Alley automation, FFmpeg DXV, Adobe Media Encoder, then HAP (only when the codec setting is HAP). The first available backend that can meet the request (quality, alpha) wins, so HQ and alpha requests skip FFmpeg when a better backend exists.

When nothing can meet the request:
- High Quality: encode Normal and warn (default), or skip.
- Alpha: skip and keep the original (default), or drop alpha and warn. Default is skip because a flattened alpha clip becomes a black box on stage.

## 6. Alley CLI: template only. Alley GUI automation: not built
Alley has no documented CLI. The Alley CLI backend runs a user-supplied command template (`{input} {output} {quality} {alpha}`), useful if Resolume ships a CLI or the user has a wrapper. The app never launches Alley to probe it.

GUI automation (AppleScript/System Events, Windows UI Automation) was rejected: it moves focus away from Arena during a show, depends on Alley's window layout, needs accessibility permissions, and has no completion signal other than polling the output folder. It is listed in the UI as unavailable with that reason.

## 7. FFmpeg DXV limits are handled explicitly
FFmpeg's `dxv` encoder (ffmpeg >= 7.0) only does DXT1 (DXV3 Normal Quality, no alpha), takes `rgba`, and fails on sizes that are not multiples of 16 (verified: 1000x562 produces no packets). The filter is `pad=ceil(iw/16)*16:ceil(ih/16)*16` centered, then `setsar=1,format=rgba`. 1920x1080 becomes 1920x1088 with 4 px black top and bottom. A "scale" option resamples instead. Audio is kept as PCM.

## 8. Output validation before swapping
ffprobe must report the expected codec and tag (`dxv`/`DXD3` for FFmpeg DXV), dimensions must be multiples of 16, and ffmpeg must decode 3 frames at the start and 3 at the midpoint with no errors. Encodes write to a hidden `.<name>.partial.mov` and are renamed only after validation. Existing files are never overwritten; a clash gets `name (1).mov`.

## 9. Cache: JSON file, not SQLite
Key: SHA-1 of `path + size + mtime`. A JSON file with atomic writes avoids a native SQLite module, which would need rebuilding per Electron version and per architecture. Expected size is thousands of entries, well within JSON's comfort zone.

## 10. Packaging: Electron + electron-builder
Options considered:
- **pkg / Node SEA**: smallest, but no tray icon or windows without a native helper (extra binary per OS, more failure points). pkg is deprecated.
- **Tauri**: small shell, but the service is Node, so Tauri would need a Node sidecar (~40-90 MB) plus a Rust toolchain in CI. The size win mostly disappears.
- **Electron**: Node is already inside, so the service runs in the main process. Tray, start at login (`setLoginItemSettings`), dmg/nsis/msi, arm64 and x64 builds are first-class in electron-builder.

Chosen: Electron. Cost: ~100 MB installed plus ffmpeg (~80 MB). Reliability over size, given ffmpeg dominates the size anyway.

Builds: macOS arm64 and x64 as separate dmgs (smaller than universal; ffmpeg is per-arch). Windows x64 as NSIS `.exe` and `.msi`. Unsigned unless signing secrets exist (README > Signing).

## 11. Auto-update: check only
The app checks `https://api.github.com/repos/AV360Media/resolume-auto-render/releases/latest` (unauthenticated, at start and daily) and offers the release page. It does not self-install: silent updates need signed builds on macOS, and replacing the app mid-show is a bad default. The repo must be public for this check to work without a token.

## 12. ffmpeg bundling
`scripts/fetch-ffmpeg.mjs` downloads a static build per platform (BtbN LGPL for Windows/Linux, Martin Riedl's builds for macOS, with fallbacks), then verifies it by running a real DXV encode and decode, and records source URL and SHA-256 hashes in `SOURCE.json`, published with each release. The app searches: settings path, `RAR_FFMPEG`, bundled, then PATH, and picks the first ffmpeg that has the encoder a backend needs (the HAP encoder needs snappy, missing from some static builds).

License: ffmpeg ships as separate executables beside an MIT app. LGPL builds are preferred; the macOS builds may be GPL. Their license files are copied next to the binaries.

## 13. Control panel security
The panel binds to 127.0.0.1 only and rejects requests whose Host or Origin is not localhost, so a website open in a browser cannot change settings or start encodes.

## 14. UI staging and promotion
`index.test.html` is the only UI file developers edit. `npm run promote` gates it (html-validate, inline JS syntax, ESLint, Playwright smoke test against `scripts/mock-companion.mjs`), copies it to `index.html`, backs up the old file in `.backups/`, commits and pushes. CI runs the gate on both files and `scripts/check-prod.mjs` fails if `index.html` does not equal some committed `index.test.html`, which catches direct edits.

## 15. Repository
Created as `bryanchorton/resolume-auto-render` (renamed to `AV360Media/resolume-auto-render` when the account was renamed), public (MIT, and the update check needs public releases). Work happens on `main` only.
