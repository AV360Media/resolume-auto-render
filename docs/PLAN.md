# Plan

Goal: video loaded into Resolume Arena is converted to DXV in the background and swapped into the same clip. No manual Alley step.

## Shape

A companion app, not an FFGL plugin. It runs next to Arena and talks to Arena's REST and WebSocket API.

```
Arena  <── REST /api/v1 + WS /api/v1 ──>  Companion service (Node + TypeScript)
                                            ├─ Resolume client (reconnecting WS + REST poll fallback)
                                            ├─ Clip watcher (diffs composition, emits "clip got new file")
                                            ├─ Folder watcher (optional watch folders)
                                            ├─ Job queue (stability wait, concurrency, retry)
                                            ├─ Encoder backends (probe + select)
                                            ├─ Validator (ffprobe + decode frames)
                                            ├─ Swapper (re-check clip, open DXV, verify, restore name/transport)
                                            ├─ Cache (JSON, path+size+mtime)
                                            └─ HTTP + WS server for the control panel UI
Electron shell: tray icon, start at login, update check, window that loads the local UI.
```

## Steps

1. Discovery spike: Arena REST/WS schema, Alley CLI, ffmpeg DXV encoder. Record in docs/DISCOVERY.md.
2. Core modules with unit tests: paths, cache, queue, probe/validate, encoders, Resolume client against a mock Arena.
3. Service wiring, HTTP/WS server, CLI entry (`npm start`).
4. UI in index.test.html. UI gate (html-validate, inline JS syntax + ESLint, Playwright smoke test against a mock companion). promote/rollback scripts.
5. Integration test: real ffmpeg DXV encode of a generated clip, validated.
6. Electron shell, electron-builder config, ffmpeg fetch script, CI: gate on every push, installers on tag.
7. Docs: README, DECISIONS, CLAUDE.md. First promotion so index.html == index.test.html.
8. `scripts/check-arena.mjs` for verifying the API assumptions against a live Arena.
