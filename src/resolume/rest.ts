import type { ArenaClip, ArenaComposition, ArenaProduct } from './model.js';

export class ArenaHttpError extends Error {
  constructor(readonly status: number, readonly url: string, body: string) {
    super(`Arena ${status} on ${url}${body ? ': ' + body.slice(0, 200) : ''}`);
  }
}

/** Thin client for Arena's REST API at http://host:port/api/v1. */
export class ArenaRest {
  constructor(private base: () => string, private timeoutMs = 4000) {}

  get baseUrl(): string {
    return this.base();
  }

  private async req(method: string, rel: string, body?: string | object, accept: 'json' | 'text' = 'json'): Promise<any> {
    const url = `${this.base()}/${rel.replace(/^\//, '')}`;
    const headers: Record<string, string> = { Accept: accept === 'json' ? 'application/json' : '*/*' };
    let payload: string | undefined;
    if (typeof body === 'string') {
      payload = body;
      headers['Content-Type'] = 'text/plain';
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(this.timeoutMs) });
    const text = await res.text();
    if (!res.ok) throw new ArenaHttpError(res.status, url, text);
    if (accept === 'text') return text;
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  product(): Promise<ArenaProduct> {
    return this.req('GET', 'product');
  }

  composition(): Promise<ArenaComposition> {
    return this.req('GET', 'composition');
  }

  clipById(id: number): Promise<ArenaClip> {
    return this.req('GET', `composition/clips/by-id/${id}`);
  }

  clipAt(layer: number, column: number): Promise<ArenaClip> {
    return this.req('GET', `composition/layers/${layer}/clips/${column}`);
  }

  /** Body is a file URI as plain text, e.g. file:///C:/clips/a.mov */
  async openById(id: number, fileUri: string): Promise<void> {
    await this.req('POST', `composition/clips/by-id/${id}/open`, fileUri, 'text');
  }

  async openAt(layer: number, column: number, fileUri: string): Promise<void> {
    await this.req('POST', `composition/layers/${layer}/clips/${column}/open`, fileUri, 'text');
  }

  async updateClipById(id: number, patch: object): Promise<void> {
    await this.req('PUT', `composition/clips/by-id/${id}`, patch, 'text');
  }

  async updateClipAt(layer: number, column: number, patch: object): Promise<void> {
    await this.req('PUT', `composition/layers/${layer}/clips/${column}`, patch, 'text');
  }
}
