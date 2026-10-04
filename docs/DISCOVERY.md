# Discovery spike (2026-10-04)

Done from a Linux build machine with no Arena or Alley installed. Everything under "Arena API" comes from published docs and from an open-source client that talks to live Arena; it has **not** been verified against a running Arena by this project yet. Run `npm run check-arena` on a machine with Arena to verify (see bottom).

## Arena API

Sources: [REST API & Webserver](https://resolume.com/article/132), [WebSocket API](https://resolume.com/support/en/websocket-api), the Swagger UI at https://resolume.com/docs/restapi/ (its spec file could not be read from the build machine), and [bitfocus/companion-module-resolume-arena](https://github.com/bitfocus/companion-module-resolume-arena), an MIT client with integration tests run against live Arena.

| Item | Finding | Confidence |
|---|---|---|
| Enable | Preferences > Web Server. Default port 8080 (Wire: 8081). Listens on 0.0.0.0 by default. | Docs |
| REST base | `http://<host>:<port>/api/v1` | Docs + client |
| Product | `GET /api/v1/product` → `{name, major, minor, micro, revision}` | Client |
| Composition | `GET /api/v1/composition` → `{layers:[{id, name, clips:[...]}], columns:[...], ...}` | Docs + client |
| Clip by position | `GET /api/v1/composition/layers/{layer}/clips/{column}` (1-based) | Client |
| Clip by id | `GET /api/v1/composition/clips/by-id/{id}` | Swagger UI listing (by-id variants), not exercised by the client |
| Clip shape | `{id, name:{id,valuetype:"ParamString",value}, connected:{valuetype:"ParamChoice",value,index,options}, video?:{opacity, fileinfo?:{path?}}, audio?:{fileinfo?:{path?}}, transport?:{controls?:{speed}}}` | Client types |
| Load file | `POST /api/v1/composition/layers/{l}/clips/{c}/open`, body is the plain string `file:///<path>` with forward slashes | Client (used in production) |
| Load file by id | `POST /api/v1/composition/clips/by-id/{id}/open`, same body | Swagger listing; unverified |
| Update clip | `PUT` on the clip URL with a partial clip JSON | Swagger listing; unverified |
| WebSocket | `ws://<host>:<port>/api/v1`. On connect Arena sends the composition (no `type` field), then `{type:"sources_update"}` and `{type:"effects_update"}`. Structural changes resend the full composition. | Docs |
| WS messages | `{action:"subscribe"|"unsubscribe"|"get"|"set"|"trigger", parameter:"/composition/..."}`; replies `parameter_subscribed`, `parameter_update`, etc. `/parameter/by-id/{id}` works as a path. | Docs + client |
| Clip media change event | **Not documented.** The docs say structural changes resend the composition; they do not say whether loading a file into a clip does. | Unknown |

Design consequence: the clip watcher treats every composition message as a snapshot and diffs clip file paths, and it also polls `GET /composition` (default every 2 s) so a file load is detected even if Arena does not push it. Polling one JSON document on localhost is cheap.

## Alley CLI

No CLI. The Resolume forum thread [Alley command line interface](https://www.resolume.com/forum/viewtopic.php?p=81670) (2018) says there is none; the current [Alley conversion guide](https://resolume.com/article/81) describes only the GUI batch queue and presets, with no command line, watch folder or scripting. Alley cannot be checked locally here, so `npm run check-arena` also looks for an Alley install and lists its executables.

Design consequence: the "Alley CLI" backend is a user-supplied command template that stays disabled unless configured. It is never auto-run, because launching a GUI app to probe for `--help` during a show would open a window.

## ffmpeg DXV encoder

Tested with the static ffmpeg 7.0.2 build (johnvansickle.com, the build `imageio-ffmpeg` 0.6.0 ships):

- `dxv` encoder present. Only option: `-format dxt1` (Normal Quality, no alpha). Input pixel format: `rgba` only.
- 1280x720 encodes; output stream `codec_name=dxv`, `codec_tag_string=DXD3`, `pix_fmt=rgba`, decodes back cleanly.
- 1000x562 (not a multiple of 16) produces **no packets and fails**. With `pad=ceil(iw/16)*16:ceil(ih/16)*16,format=rgba` it encodes and decodes.
- The Ubuntu ffmpeg 6.1 package has no `dxv` encoder. Minimum is ffmpeg 7.0. The brief said 8.x; 7.0 already has it.
- That static build has **no `hap` encoder** (no snappy). Ubuntu's 6.1 does. The HAP backend therefore probes `-encoders` and reports unavailable when missing.

Target machines (macOS arm64/x64, Windows x64) were not available. CI runs the encoder probe on each platform with the ffmpeg build it bundles (`scripts/fetch-ffmpeg.mjs`, then `node scripts/check-ffmpeg.mjs`).

## Verify on your machine

```
npm install
npm run check-arena            # default 127.0.0.1:8080
npm run check-arena -- --host 192.168.1.20 --port 8080 --try-open "C:\\clips\\test.mov"
```

It prints the product version, saves the composition JSON to `arena-dump/`, tries the by-id clip endpoint, reports which of the assumptions above hold, and searches for Alley and Adobe Media Encoder installs. Paste its output into an issue or a session and the assumptions above can be corrected.
