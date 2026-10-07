# Resolume Auto Render

Converts video you load into Resolume Arena to DXV in the background, then loads the DXV into the same clip. No manual Alley step.

It is a companion app, not a plugin. It runs next to Arena and talks to Arena's web server (REST + WebSocket). macOS (Apple Silicon and Intel) and Windows.

> **Status:** the Arena API calls are built from Resolume's docs and an open-source client that uses live Arena. They have not yet been run against your Arena. Run `npm run check-arena` once (see [Verify against your Arena](#verify-against-your-arena)) and report anything that FAILs.

## What it does

1. Connects to Arena (default `127.0.0.1:8080`) and shows the connection state.
2. Watches the composition. When a clip gets a new video file that is not DXV, it queues a conversion. The clip keeps playing the original.
3. Encodes, validates the output (codec, tag, size, decodes frames), and loads the DXV into the same clip. Clip name and transport settings are written back.
4. Never touches a clip that has since been given a different file. Waits for a playing clip to stop before swapping (configurable).
5. Optional watch folders: anything dropped in gets converted.
6. Skips DXV files, images, audio-only files, and files already converted (cache by path + size + modified time). Never overwrites originals. Output: `<original folder>/DXV/<name>.mov` unless you set an output folder.

## Encoders

The app picks the first available backend that can do what you asked for.

| Backend | Status | Normal | High Quality | Alpha | Notes |
|---|---|---|---|---|---|
| Alley CLI | Off unless configured | yes | yes | yes | Alley has no CLI. You can enter a command template if you have one. |
| Alley GUI automation | Not built | | | | Would steal focus from Arena during a show. See docs/DECISIONS.md. |
| **FFmpeg DXV** (bundled) | Default | yes | **no** | **no** | DXV3 Normal Quality (DXT1) only. Size padded to a multiple of 16 (1080p becomes 1088p with 4 px black bars, or scaled if you choose). |
| Adobe Media Encoder | Optional | yes | yes | yes | Uses an AME watch folder with Resolume's DXV3 preset. Quality and alpha come from that preset. AME must be running. |
| FFmpeg HAP | Off by default | HAP | HAP Q | HAP Alpha | Not DXV. Resolume plays HAP natively. Needs an ffmpeg with the hap encoder. |

If you ask for High Quality or alpha and only FFmpeg DXV is available:
- High Quality: encodes Normal and warns (or skips, your choice).
- Alpha: skips the file and keeps the original playing (or drops alpha with a warning, your choice). A flattened alpha clip shows a black background.

The settings drawer shows the same table for your machine and warns when a setting cannot be met.

## Install

Download from [Releases](https://github.com/bryanchorton/resolume-auto-render/releases):

- macOS Apple Silicon: `Resolume-Auto-Render-<version>-mac-arm64.dmg`
- macOS Intel: `Resolume-Auto-Render-<version>-mac-x64.dmg`
- Windows: `Resolume-Auto-Render-<version>-win-x64.exe` (or `.msi`)

Builds are unsigned unless signing secrets are configured (see [Signing](#signing)).
- macOS: drag to Applications, then right-click the app > Open > Open the first time. Or run `xattr -dr com.apple.quarantine "/Applications/Resolume Auto Render.app"`.
- Windows: SmartScreen shows "Windows protected your PC". Click More info > Run anyway.

The app lives in the menu bar (macOS) or system tray (Windows). Tray menu: open control panel, start at login, check for updates, quit.

## Enable Arena's web server

Arena > Preferences > Web Server > enable. Default port 8080. Leave the address at `0.0.0.0` or set `127.0.0.1`. The app and Arena should run on the same computer: Arena opens files by path, so the path the app writes must be valid on Arena's machine.

## First run

1. Start Arena with the web server enabled.
2. Start Resolume Auto Render. The control panel opens at `http://127.0.0.1:8765/`. The status box turns green: "Connected to Arena x.y.z".
3. Drag a non-DXV video onto an empty clip slot. It appears in the queue, encodes, and the clip switches to `DXV/<name>.mov` when it is not playing.

Clips that were already loaded when the app connected are left alone. Turn on "Convert clips already loaded" to convert them.

## Try it from source

Needs Node 20+.

```
npm install
npm start
```

`npm start` builds, downloads and verifies ffmpeg for your machine into `vendor/ffmpeg/`, starts the service and opens the control panel. The tray app: `npm run app`.

## Verify against your Arena

```
npm run check-arena
npm run check-arena -- --watch 30
npm run check-arena -- --try-open "/path/to/test.mov" --layer 1 --column 4
```

- No flags: read-only. Checks product, composition, by-id endpoints, WebSocket, saves `arena-dump/composition.json`, saves Arena's API schema if it serves one, lists Alley and AME installs, checks ffmpeg for the DXV encoder.
- `--watch 30`: drag a file into an empty slot during the 30 s. Reports whether Arena pushes the change over WebSocket or only polling sees it.
- `--try-open`: loads a file into the clip you name (use an empty slot), then reports whether the clip id, name and effects survive and whether `PUT` can restore the name.

## Settings

| Setting | Default | |
|---|---|---|
| Host / Port | 127.0.0.1 / 8080 | Arena web server |
| Poll interval | 2000 ms | Fallback when Arena does not push file loads. 0 = WebSocket only. |
| Auto-replace clips | on | Off = convert only |
| Swap clips while playing | off | Off = wait until the clip stops playing |
| Restore name and transport | on | Written back after the swap |
| Codec | DXV | HAP is optional and clearly not DXV |
| Quality | Normal | High needs AME or an Alley CLI |
| Alpha | Auto | From the source pixel format; or always/never |
| Parallel encodes | 2 | |
| Output folder | empty | Empty = `<original folder>/DXV` |
| After converting | Keep original | Move = to `<original folder>/Originals` (never while a clip still uses it) |
| Watch folders | none | One per line |
| Ignore list | none | Paths or patterns: `*.webm`, `/archive/**`, `loop_??.mp4` |
| Copy settle time | 3000 ms | File size must hold still this long. Doubled on network drives. |
| Test mode | off | Serve the staging UI at `/` |

Settings are stored in `~/Library/Application Support/Resolume Auto Render/` (macOS) or `%APPDATA%\Resolume Auto Render\` (Windows), with the conversion cache.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Arena not reachable" | Enable Preferences > Web Server. Check the port. A firewall prompt may need approval. |
| Clip loaded, nothing queued | File is DXV, an image or audio, on the ignore list, or was loaded while the app was disconnected. Check the log. Keep the poll interval above 0. |
| Queued, never swaps | The clip is playing; it swaps when it stops. Or turn on "Swap clips while playing". |
| "Clip now holds a different file" | You changed the clip during the encode. The DXV is kept in the output folder; nothing was swapped. |
| "Arena did not load the converted file" | Try File URI style: Percent-encoded. Run `npm run check-arena -- --try-open` and report the output. |
| Skipped: alpha | Only FFmpeg DXV is available and it cannot keep alpha. Use AME, or allow dropping alpha. |
| ffmpeg not found / no DXV encoder | Needs ffmpeg 7.0+. Installers bundle it. From source: `npm run fetch-ffmpeg`. Or set the path in Settings > Tools. |
| Encode failed | The original keeps playing. Click Retry. The log has ffmpeg's last error line. |
| Port 8765 in use | The app picks a free port and logs it. |

## Known limitations

- The Arena API assumptions are unverified on live Arena until `check-arena` is run (docs/DISCOVERY.md).
- FFmpeg DXV: Normal Quality only, no alpha, sizes padded or scaled to multiples of 16.
- Whether Arena keeps clip effects, crop and audio settings when a new file is opened into a clip is unverified. Cue points and properties outside `transport` are not restored.
- Files loaded while the app is not connected are not converted until you load them again (or turn on "Convert clips already loaded").
- Arena must be able to read the output path, so the app and Arena should run on the same machine.
- Updates are checked, not installed automatically.

## Workflow

The control panel UI has a staging file and a production file.

- `index.test.html`: staging. All UI changes go here. Served at `http://127.0.0.1:8765/test`, and at `/` when Test mode is on.
- `index.html`: production. Served at `/`. Changed only by promotion.

Commands:
- `npm run test:ui`: run the gate on `index.test.html` without changing anything.
- `npm run promote`: refuses if anything other than `index.test.html` is uncommitted, runs the gate (HTML validation, inline JS syntax and ESLint, Playwright smoke test against a mock companion with zero console errors), then copies to `index.html`, backs up the old one in `.backups/`, commits `Promote index.test.html to index.html (<summary>)` and pushes to `main`. Any gate failure changes nothing.
- `npm run rollback`: restores the previous production file (newest backup, or the version before the last promotion in git), commits and pushes.

With Claude Code: say **"Ship it to production"** to promote, **"Roll back production"** to roll back (see CLAUDE.md). CI runs the gate on both files on every push and fails if `index.html` was edited directly.

## Development

```
npm run typecheck
npm test                  # unit tests (queue, cache, paths, Resolume client vs mock Arena)
npm run fetch-ffmpeg
npm run test:integration  # real ffmpeg DXV encodes + end-to-end against mock Arena
npm run test:ui
node scripts/mock-companion.mjs index.test.html   # UI against fake data on :8766
```

Layout: `src/` service (TypeScript), `electron/` tray shell, `scripts/` gate, promote, rollback, ffmpeg fetch, Arena check, `test/` unit, integration and the mock Arena, `docs/` plan, discovery, decisions.

## Releasing

Bump `version` in `package.json` and commit to `main`. Then either push a tag (`git tag v0.2.0 && git push origin v0.2.0`) or run the Release workflow manually from the Actions tab, which creates the tag `v<version>` itself. The Release workflow builds macOS arm64, macOS x64 and Windows x64 installers, verifies the bundled ffmpeg, and attaches everything to a GitHub Release with SHA-256 sums.

## Signing

Without secrets, CI produces unsigned installers. To sign, add repository secrets:

- macOS: `CSC_LINK` (base64 .p12 of a Developer ID Application certificate), `CSC_KEY_PASSWORD`. For notarization also `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. electron-builder signs, including the bundled ffmpeg, and notarizes when they are present.
- Windows: `WIN_CSC_LINK` (base64 .pfx), `WIN_CSC_KEY_PASSWORD`.

Manual notarization of an existing build:

```
xcrun notarytool submit "Resolume-Auto-Render-x.y.z-mac-arm64.dmg" --apple-id you@example.com --team-id TEAMID --password app-specific-password --wait
xcrun stapler staple "Resolume-Auto-Render-x.y.z-mac-arm64.dmg"
```

## License

MIT. The bundled ffmpeg is a separate program under its own license (LGPL or GPL, depending on the build; see the `FFMPEG-*` files next to it and `ffmpeg-<platform>.json` in each release).
