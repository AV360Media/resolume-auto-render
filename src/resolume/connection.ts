import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { ArenaRest } from './rest.js';
import type { ArenaComposition, ArenaProduct } from './model.js';

export type ConnState = 'connecting' | 'connected' | 'disconnected';

export interface ConnectionStatus {
  state: ConnState;
  host: string;
  port: number;
  product?: ArenaProduct;
  websocket: boolean;
  lastError?: string;
  since: number;
}

export interface ConnectionOptions {
  host: () => string;
  port: () => number;
  pollIntervalMs: () => number;
  /** Max reconnect delay. */
  maxBackoffMs?: number;
}

function isComposition(msg: any): msg is ArenaComposition {
  return msg && typeof msg === 'object' && !('type' in msg) && Array.isArray(msg.layers);
}

/**
 * Keeps a live link to Arena: REST for reachability and polling, WebSocket for pushed composition updates.
 * Emits:
 *   'status'      ConnectionStatus
 *   'composition' (comp, source: 'ws' | 'poll')
 *   'connected'   after Arena becomes reachable (also after an Arena restart)
 *   'disconnected'
 *   'session-reset' when the WebSocket drops; clip ids may have changed (Arena restart, new composition)
 */
export class ArenaConnection extends EventEmitter {
  readonly rest: ArenaRest;
  private ws: WebSocket | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private backoff = 1000;
  private stopped = true;
  private status: ConnectionStatus;

  constructor(private opts: ConnectionOptions) {
    super();
    this.rest = new ArenaRest(() => `http://${this.opts.host()}:${this.opts.port()}/api/v1`);
    this.status = { state: 'disconnected', host: opts.host(), port: opts.port(), websocket: false, since: Date.now() };
  }

  getStatus(): ConnectionStatus {
    return { ...this.status };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.teardown();
    this.setStatus({ state: 'disconnected', websocket: false });
  }

  /** Reconnect now, e.g. after the host or port setting changed. */
  restart(): void {
    this.stop();
    this.backoff = 1000;
    this.start();
  }

  private setStatus(patch: Partial<ConnectionStatus>): void {
    const prev = this.status.state;
    this.status = { ...this.status, ...patch, host: this.opts.host(), port: this.opts.port() };
    if (patch.state && patch.state !== prev) this.status.since = Date.now();
    this.emit('status', this.getStatus());
  }

  private teardown(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pollTimer = this.retryTimer = null;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.on('error', () => {});
      try { this.ws.terminate(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    // Stay "disconnected" during retries so the UI does not flicker.
    if (!this.status.lastError) this.setStatus({ state: 'connecting' });
    try {
      const product = await this.rest.product();
      if (this.stopped) return;
      this.backoff = 1000;
      this.setStatus({ state: 'connected', product, lastError: undefined });
      this.emit('connected', product);
      this.openWebSocket();
      this.startPolling();
      // Initial snapshot even if the WebSocket is slow or unavailable.
      await this.pollOnce();
    } catch (err) {
      this.fail(err);
    }
  }

  private fail(err: unknown): void {
    if (this.stopped) return;
    const wasConnected = this.status.state === 'connected';
    this.teardown();
    this.setStatus({ state: 'disconnected', websocket: false, lastError: describeError(err) });
    if (wasConnected) this.emit('disconnected');
    const delay = this.backoff;
    this.backoff = Math.min(this.opts.maxBackoffMs ?? 10000, this.backoff * 2);
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }

  private openWebSocket(): void {
    const url = `ws://${this.opts.host()}:${this.opts.port()}/api/v1`;
    const ws = new WebSocket(url, { handshakeTimeout: 4000 });
    this.ws = ws;
    ws.on('open', () => this.setStatus({ websocket: true }));
    ws.on('message', (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (isComposition(msg)) this.emit('composition', msg, 'ws');
      else this.emit('ws-message', msg);
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setStatus({ websocket: false });
      if (this.stopped) return;
      this.emit('session-reset');
      // Check right away whether Arena is gone, then retry the socket while it is up.
      void this.pollOnce();
      if (this.status.state === 'connected') {
        setTimeout(() => {
          if (!this.stopped && this.status.state === 'connected' && !this.ws) this.openWebSocket();
        }, 2000);
      }
    });
    ws.on('error', () => { /* close follows */ });
  }

  /** Sends a raw WebSocket message, e.g. {action:'set', parameter, value}. */
  send(msg: object): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private startPolling(): void {
    const ms = this.opts.pollIntervalMs();
    // Even with polling disabled, check reachability every 5 s so restarts are noticed.
    this.pollTimer = setInterval(() => void this.pollOnce(), ms > 0 ? ms : 5000);
  }

  private polling = false;
  private async pollOnce(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      if (this.opts.pollIntervalMs() > 0) {
        const comp = await this.rest.composition();
        if (!this.stopped && isComposition(comp)) this.emit('composition', comp, 'poll');
      } else {
        await this.rest.product();
      }
    } catch (err) {
      this.fail(err);
    } finally {
      this.polling = false;
    }
  }
}

function describeError(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (e?.cause?.code === 'ECONNREFUSED') return 'connection refused (web server off or wrong port)';
  if (e?.cause?.code) return e.cause.code;
  if (e?.name === 'TimeoutError') return 'timed out';
  return e?.message || String(err);
}
