// Mock of the companion's HTTP + WebSocket API for UI tests. Pure Node + ws, no build step.
// Serves one HTML file at / and /test and speaks the protocol documented in src/server.ts.
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';

export async function startMockCompanion(htmlPath, { port = 0 } = {}) {
  const html = await fs.readFile(htmlPath);
  const calls = [];
  const settings = {
    arenaHost: '127.0.0.1', arenaPort: 8080, pollIntervalMs: 2000, uiPort: 8765, testMode: false,
    codec: 'dxv', quality: 'normal', alpha: 'auto', onHqUnavailable: 'downgrade', onAlphaUnavailable: 'skip',
    backend: 'auto', dxvFit: 'pad', concurrency: 2, outputFolder: '', postConvert: 'keep', moveOriginalsTo: '',
    autoReplace: true, convertExistingOnConnect: false, swapWhileLive: false, restoreClipProps: true, fileUriStyle: 'raw',
    watchFolders: [], ignore: [], stableMs: 3000, ffmpegPath: '', ffprobePath: '', alleyCliCommand: '',
    ameWatchFolder: '', ameOutputFolder: '', checkUpdates: true,
  };
  const backends = [
    { id: 'alley-cli', label: 'Alley CLI', caps: { available: false, reason: 'No Alley CLI configured.', codec: 'dxv', qualities: ['normal', 'high'], alpha: true, notes: [] } },
    { id: 'ffmpeg-dxv', label: 'FFmpeg DXV (built-in)', caps: { available: true, reason: 'ffmpeg 7.1 (bundled)', codec: 'dxv', qualities: ['normal'], alpha: false, notes: ['DXV3 Normal Quality only (DXT1). No High Quality.'] } },
  ];
  const status = { state: 'connected', host: '127.0.0.1', port: 8080, websocket: true, since: Date.now(), product: { name: 'Arena', major: 7, minor: 23, micro: 0, revision: 0 } };
  const jobs = new Map();
  const logs = [{ t: Date.now(), level: 'info', msg: 'Mock companion started' }];

  const state = () => ({ version: '0.0.0-mock', status, jobs: [...jobs.values()], settings, backends, logs, update: { current: '0.0.0-mock', available: false }, ffmpeg: { version: '7.1', source: 'bundled', dxv: true } });

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body });
      const json = (code, v) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/test')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(200, state());
      if (req.method === 'PUT' && url.pathname === '/api/settings') {
        Object.assign(settings, JSON.parse(body || '{}'));
        broadcast({ type: 'settings', settings });
        return json(200, settings);
      }
      if (req.method === 'POST' && url.pathname === '/api/backends/refresh') return json(200, backends);
      if (req.method === 'POST' && url.pathname === '/api/jobs/clear') {
        for (const [id, j] of jobs) if (['done', 'skipped', 'failed', 'cancelled'].includes(j.state)) jobs.delete(id);
        return json(200, { ok: true });
      }
      const m = /^\/api\/jobs\/([\w-]+)\/(retry|cancel|ignore)$/.exec(url.pathname);
      if (req.method === 'POST' && m) {
        const j = jobs.get(m[1]);
        if (!j) return json(404, { error: 'No such job' });
        if (m[2] === 'retry') setJob({ ...j, state: 'queued', progress: 0, error: undefined });
        if (m[2] === 'cancel') setJob({ ...j, state: 'cancelled' });
        return json(200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/convert') {
        const { path } = JSON.parse(body || '{}');
        return json(200, addJob({ source: path, origin: 'manual' }));
      }
      json(404, { error: 'Not found' });
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => ws.send(JSON.stringify({ type: 'state', ...state() })));
  });
  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
  };
  let n = 0;
  function setJob(j) {
    j.updatedAt = Date.now();
    jobs.set(j.id, j);
    broadcast({ type: 'job', job: j });
    return j;
  }
  function addJob(input) {
    const now = Date.now();
    return setJob({ id: `job-${++n}`, state: 'queued', progress: 0, warnings: [], attempts: 0, createdAt: now, updatedAt: now, ...input });
  }

  /** Drives a fake job through encode to done (or failed). */
  async function runFakeJob({ source = '/clips/Test Clip.mp4', fail = false, steps = 5, stepMs = 80 } = {}) {
    let j = addJob({ source, origin: 'clip', clip: { id: 42, layer: 1, column: 2, name: 'Test Clip' } });
    await sleep(stepMs);
    j = setJob({ ...j, state: 'encoding', backend: 'ffmpeg-dxv', detail: 'Encoding with FFmpeg DXV (built-in)' });
    for (let i = 1; i <= steps; i++) {
      await sleep(stepMs);
      j = setJob({ ...j, progress: i / (steps + 1) });
    }
    if (fail) return setJob({ ...j, state: 'failed', error: 'ffmpeg exited with 1: mock failure' });
    await sleep(stepMs);
    j = setJob({ ...j, state: 'swapping', detail: 'Loading into clip' });
    await sleep(stepMs);
    return setJob({ ...j, state: 'done', progress: 1, output: '/clips/DXV/Test Clip.mov', detail: 'Swapped into L1 C2' });
  }

  function log(level, msg) {
    const entry = { t: Date.now(), level, msg };
    logs.push(entry);
    broadcast({ type: 'log', entry });
  }

  function setStatus(patch) {
    Object.assign(status, patch);
    broadcast({ type: 'status', status });
  }

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const actual = server.address().port;
  return {
    url: `http://127.0.0.1:${actual}/`,
    calls,
    runFakeJob,
    log,
    setStatus,
    clientCount: () => wss.clients.size,
    close: async () => {
      for (const c of wss.clients) c.terminate();
      await new Promise((r) => wss.close(r));
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run standalone: node scripts/mock-companion.mjs index.test.html [port]
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('mock-companion.mjs')) {
  const file = process.argv[2] || 'index.test.html';
  const m = await startMockCompanion(file, { port: Number(process.argv[3] || 8766) });
  console.log(`Mock companion serving ${file} at ${m.url}`);
  setInterval(() => void m.runFakeJob({ source: `/clips/demo ${Date.now() % 1000}.mp4`, fail: Math.random() < 0.2, stepMs: 400 }), 6000);
}
