import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { Service } from './service.js';

/**
 * Control panel server. Binds to 127.0.0.1 only.
 *
 * Pages:   GET /        index.html (index.test.html when Test mode is on)
 *          GET /test    index.test.html
 *          GET /prod    index.html
 * API:     GET  /api/state
 *          PUT  /api/settings            JSON patch
 *          POST /api/jobs/:id/retry | /api/jobs/:id/cancel | /api/jobs/:id/ignore
 *          POST /api/jobs/clear
 *          POST /api/convert             {"path": "..."}
 *          POST /api/backends/refresh
 *          POST /api/arena/reconnect
 *          POST /api/update/check
 * WS /ws:  server -> client messages: {type:'state', ...state} once, then
 *          {type:'job', job} {type:'status', status} {type:'log', entry} {type:'settings', settings}
 *          {type:'backends', backends} {type:'update', update}
 */
export interface UiServer {
  port: number;
  close(): Promise<void>;
}

export async function startServer(service: Service, appRoot: string, port: number): Promise<UiServer> {
  const page = async (name: 'index.html' | 'index.test.html') => fs.readFile(path.join(appRoot, name));

  const state = () => ({
    version: service.update().current,
    status: service.arena.getStatus(),
    jobs: service.queue.list(),
    settings: service.getSettings(),
    backends: service.backends(),
    logs: service.log.entries.slice(-200),
    update: service.update(),
    ffmpeg: service.ffmpeg() ? { version: service.ffmpeg()!.version, source: service.ffmpeg()!.source, dxv: service.ffmpeg()!.encoders.has('dxv') } : null,
  });

  const allowedOrigin = (origin: string | undefined, host: string | undefined) => {
    // Block other websites (CSRF, DNS rebinding). Allow same-origin and non-browser clients.
    const okHost = (h: string) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(h);
    if (host && !okHost(host)) return false;
    if (!origin) return true;
    try {
      return okHost(new URL(origin).host);
    } catch {
      return false;
    }
  };

  const readBody = (req: http.IncomingMessage) =>
    new Promise<any>((resolve, reject) => {
      let data = '';
      req.setEncoding('utf8');
      req.on('data', (c) => {
        data += c;
        if (data.length > 1_000_000) req.destroy();
      });
      req.on('end', () => {
        if (!data) return resolve({});
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
      });
      req.on('error', reject);
    });

  const send = (res: http.ServerResponse, code: number, body: unknown, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!allowedOrigin(req.headers.origin, req.headers.host)) return send(res, 403, { error: 'Forbidden' });
      const url = new URL(req.url || '/', 'http://localhost');
      const p = url.pathname;
      const m = req.method || 'GET';
      if (m === 'GET' && (p === '/' || p === '/index.html')) {
        return send(res, 200, await page(service.getSettings().testMode ? 'index.test.html' : 'index.html'), 'text/html; charset=utf-8');
      }
      if (m === 'GET' && (p === '/test' || p === '/test/')) return send(res, 200, await page('index.test.html'), 'text/html; charset=utf-8');
      if (m === 'GET' && p === '/prod') return send(res, 200, await page('index.html'), 'text/html; charset=utf-8');
      if (m === 'GET' && p === '/api/state') return send(res, 200, state());
      if (m === 'PUT' && p === '/api/settings') return send(res, 200, await service.updateSettings(await readBody(req)));
      if (m === 'POST' && p === '/api/jobs/clear') {
        service.queue.clearFinished();
        return send(res, 200, { ok: true });
      }
      const jm = /^\/api\/jobs\/([\w-]+)\/(retry|cancel|ignore)$/.exec(p);
      if (m === 'POST' && jm) {
        const [, id, action] = jm;
        const job = service.queue.get(id);
        if (!job) return send(res, 404, { error: 'No such job' });
        if (action === 'retry') return send(res, 200, { ok: service.queue.retry(id) });
        if (action === 'cancel') return send(res, 200, { ok: service.queue.cancel(id) });
        await service.ignore(job.source);
        service.queue.cancel(id);
        return send(res, 200, { ok: true });
      }
      if (m === 'POST' && p === '/api/convert') {
        const body = await readBody(req);
        if (!body.path || typeof body.path !== 'string') return send(res, 400, { error: 'path required' });
        return send(res, 200, service.convert(body.path));
      }
      if (m === 'POST' && p === '/api/backends/refresh') return send(res, 200, await service.refreshBackends());
      if (m === 'POST' && p === '/api/arena/reconnect') {
        service.arena.restart();
        return send(res, 200, { ok: true });
      }
      if (m === 'POST' && p === '/api/update/check') return send(res, 200, await service.checkUpdates());
      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      return send(res, 500, { error: (e as Error).message });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/ws' || !allowedOrigin(req.headers.origin, req.headers.host)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'state', ...state() }));
  });
  const broadcast = (msg: object) => {
    const data = JSON.stringify(msg);
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
  };
  const listeners: [string, (...a: any[]) => void][] = [
    ['job', (job) => broadcast({ type: 'job', job })],
    ['status', (status) => broadcast({ type: 'status', status })],
    ['settings', (settings) => broadcast({ type: 'settings', settings })],
    ['backends', (backends) => broadcast({ type: 'backends', backends })],
    ['update', (update) => broadcast({ type: 'update', update })],
  ];
  for (const [ev, fn] of listeners) service.on(ev, fn);
  const onLog = (entry: unknown) => broadcast({ type: 'log', entry });
  service.log.on('entry', onLog);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const actual = (server.address() as { port: number }).port;
  return {
    port: actual,
    close: async () => {
      for (const [ev, fn] of listeners) service.off(ev, fn);
      service.log.off('entry', onLog);
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
