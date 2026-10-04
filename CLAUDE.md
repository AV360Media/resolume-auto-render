# CLAUDE.md

Standing rules for this repo.

## Trigger phrases

- **"Ship it to production"**: run `npm run promote`. It runs the test gate on `index.test.html` and, if everything passes, copies it to `index.html`, commits and pushes to `main`. If the gate fails, report exactly which checks failed (copy the FAIL lines) and do not change `index.html`. Do not ask for extra confirmation after the trigger phrase; the test gate is the safety check.
- **"Roll back production"**: run `npm run rollback`. Report the PASS/FAIL summary it prints.

## UI rules

- Never edit `index.html` directly. All UI changes go in `index.test.html` first.
- `index.test.html` stays a single file: inline CSS and JS, no build step, no external requests.
- Try UI changes against the real app at `http://127.0.0.1:8765/test`, or against the mock with `node scripts/mock-companion.mjs index.test.html`.
- `npm run test:ui` runs the same gate as promotion without changing anything.

## Code rules

- Work on `main`. Small commits with clear messages.
- Before pushing: `npm run typecheck && npm test`. Run `npm run test:integration` when touching encoding, the queue, the service or the Resolume client (needs ffmpeg >= 7.0: `npm run fetch-ffmpeg`).
- Arena API assumptions live in `docs/DISCOVERY.md`. Do not add endpoints that are not documented there; verify new ones with `npm run check-arena` and record them.
- Record design decisions in `docs/DECISIONS.md`.
- Docs and UI text: direct and concise. No filler.
