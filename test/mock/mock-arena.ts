import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

/**
 * Mock of Arena's web server, modeled on the schema in docs/DISCOVERY.md.
 * REST under /api/v1, WebSocket at /api/v1 that sends the composition on connect and on changes.
 * Behaviors that are unverified on real Arena are switchable so both cases get tested.
 */
export interface MockOptions {
  layers?: number;
  columns?: number;
  /** Push the composition over WS after a file load. Real Arena may not; the client must poll. */
  pushOnOpen?: boolean;
  /** Support /composition/clips/by-id/{id}. */
  byId?: boolean;
  /** Path format Arena reports in fileinfo: plain native path or a file URI. */
  reportAs?: 'path' | 'uri';
  /** Opening a file renames the clip to the file name and resets transport, like a fresh load. */
  resetOnOpen?: boolean;
}

let nextId = 1000;
const param = (value: unknown, valuetype = 'ParamString', extra: object = {}) => ({ id: nextId++, valuetype, value, ...extra });

export interface MockClip {
  id: number;
  name: any;
  connected: any;
  video: any;
  transport: any;
}

export class MockArena {
  server!: http.Server;
  wss!: WebSocketServer;
  port = 0;
  layers: { id: number; name: any; clips: MockClip[] }[] = [];
  requests: { method: string; url: string; body: string }[] = [];
  opts: Required<MockOptions>;

  constructor(opts: MockOptions = {}) {
    this.opts = { layers: 2, columns: 3, pushOnOpen: true, byId: true, reportAs: 'path', resetOnOpen: true, ...opts };
    this.build();
  }

  private emptyClip(): MockClip {
    return {
      id: nextId++,
      name: param(''),
      connected: param('Empty', 'ParamChoice', { index: 0, options: ['Empty', 'Disconnected', 'Previewing', 'Connected'] }),
      video: null,
      transport: null,
    };
  }

  private build() {
    this.layers = [];
    for (let l = 0; l < this.opts.layers; l++) {
      const clips: MockClip[] = [];
      for (let c = 0; c < this.opts.columns; c++) clips.push(this.emptyClip());
      this.layers.push({ id: nextId++, name: param(`Layer #${l + 1}`), clips });
    }
  }

  composition() {
    return {
      name: param('Mock Composition'),
      layers: this.layers.map((l) => ({ id: l.id, name: l.name, clips: l.clips })),
      columns: Array.from({ length: this.opts.columns }, (_, i) => ({ id: 500 + i, name: param(`Column #${i + 1}`) })),
    };
  }

  clipAt(layer: number, column: number): MockClip | undefined {
    return this.layers[layer - 1]?.clips[column - 1];
  }

  clipById(id: number): MockClip | undefined {
    for (const l of this.layers) for (const c of l.clips) if (c.id === id) return c;
    return undefined;
  }

  pathOf(clip: MockClip): string {
    const v = clip.video?.fileinfo?.path?.value || '';
    return this.opts.reportAs === 'uri' && v ? decodeURI(v.replace(/^file:\/\/\//, '/').replace(/^\/([A-Za-z]:)/, '$1')) : v;
  }

  /** Simulates the user dropping a file onto a clip slot. */
  userLoad(layer: number, column: number, file: string, name?: string) {
    const clip = this.clipAt(layer, column)!;
    this.setFile(clip, file, true);
    if (name) clip.name.value = name;
    this.push();
    return clip;
  }

  private setFile(clip: MockClip, file: string, reset: boolean) {
    const reported = this.opts.reportAs === 'uri' ? 'file:///' + encodeURI(file.replace(/\\/g, '/').replace(/^\//, '')) : file;
    const base = path.basename(file, path.extname(file));
    if (!clip.video || reset) {
      clip.video = { opacity: param(1, 'ParamRange', { min: 0, max: 1 }), fileinfo: { path: param(reported), exists: true }, effects: clip.video?.effects ?? [] };
    } else {
      clip.video.fileinfo = { path: param(reported), exists: true };
    }
    clip.connected.value = 'Disconnected';
    if (reset || !clip.transport) {
      clip.name = param(base);
      clip.transport = {
        position: param(0, 'ParamRange', { min: 0, max: 10 }),
        controls: {
          playdirection: param('>', 'ParamChoice', { options: ['<', '||', '>'] }),
          playmode: param('Loop', 'ParamChoice', { options: ['Loop', 'Bounce', 'Random', 'Play Once & Clear', 'Play Once & Hold'] }),
          speed: param(1, 'ParamRange', { min: 0, max: 10 }),
        },
      };
    }
  }

  push() {
    const msg = JSON.stringify(this.composition());
    for (const c of this.wss?.clients ?? []) if (c.readyState === WebSocket.OPEN) c.send(msg);
  }

  async start(port = 0): Promise<number> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/api/v1') return socket.destroy();
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(JSON.stringify(this.composition()));
        ws.send(JSON.stringify({ type: 'sources_update', value: {} }));
        ws.send(JSON.stringify({ type: 'effects_update', value: {} }));
      });
    });
    await new Promise<void>((r) => this.server.listen(port, '127.0.0.1', () => r()));
    this.port = (this.server.address() as { port: number }).port;
    return this.port;
  }

  async stop(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Arena quit and relaunched: new clip ids, same port. */
  async restart(keepFiles = true): Promise<void> {
    const files = this.layers.map((l) => l.clips.map((c) => this.pathOf(c)));
    await this.stop();
    this.build();
    if (keepFiles) files.forEach((row, l) => row.forEach((f, c) => f && this.setFile(this.layers[l].clips[c], f, true)));
    await this.start(this.port);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      this.requests.push({ method: req.method || '', url: req.url || '', body });
      const url = (req.url || '').replace(/\?.*$/, '');
      const json = (code: number, v: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(v === undefined ? '' : JSON.stringify(v));
      };
      if (!url.startsWith('/api/v1/')) return json(404, { error: 'not found' });
      const p = url.slice('/api/v1/'.length);
      if (req.method === 'GET' && p === 'product') return json(200, { name: 'Arena', major: 7, minor: 23, micro: 0, revision: 0 });
      if (req.method === 'GET' && p === 'composition') return json(200, this.composition());

      let clip: MockClip | undefined;
      let rest = '';
      let m = /^composition\/clips\/by-id\/(\d+)(\/.*)?$/.exec(p);
      if (m) {
        if (!this.opts.byId) return json(404, { error: 'not found' });
        clip = this.clipById(Number(m[1]));
        rest = m[2] || '';
      } else if ((m = /^composition\/layers\/(\d+)\/clips\/(\d+)(\/.*)?$/.exec(p))) {
        clip = this.clipAt(Number(m[1]), Number(m[2]));
        rest = m[3] || '';
      } else return json(404, { error: 'not found' });
      if (!clip) return json(404, { error: 'clip not found' });

      if (req.method === 'GET' && rest === '') return json(200, clip);
      if (req.method === 'POST' && rest === '/open') {
        let file = body.trim();
        if (!/^file:\/\//.test(file)) return json(400, { error: 'expected file uri' });
        file = file.replace(/^file:\/\/\//, '');
        if (/%[0-9A-F]{2}/i.test(file)) file = decodeURIComponent(file);
        if (!/^[A-Za-z]:/.test(file)) file = '/' + file;
        this.setFile(clip, file, this.opts.resetOnOpen);
        if (this.opts.pushOnOpen) this.push();
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'PUT' && rest === '') {
        let patch: any;
        try { patch = JSON.parse(body); } catch { return json(400, { error: 'bad json' }); }
        applyValues(clip, patch);
        this.push();
        res.writeHead(204);
        return res.end();
      }
      return json(404, { error: 'not found' });
    });
  }
}

function applyValues(target: any, patch: any) {
  if (!target || typeof patch !== 'object') return;
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && 'value' in (v as object) && target[k] && typeof target[k] === 'object' && 'valuetype' in target[k]) target[k].value = (v as any).value;
    else if (v && typeof v === 'object') applyValues(target[k], v);
  }
}
