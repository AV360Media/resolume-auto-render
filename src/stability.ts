import { promises as fs } from 'node:fs';

export interface StabilityOptions {
  /** Size and mtime must stay unchanged for this long. */
  stableMs: number;
  /** Check interval. */
  intervalMs?: number;
  /** Give up after this long. Large copies over slow networks can take a while. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with the current size while waiting. */
  onWait?: (size: number) => void;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Waits until a file stops growing. Returns its final stat.
 * Also confirms the file can be opened for reading, which fails on Windows while another process holds it exclusively.
 */
export async function waitForStableFile(file: string, opts: StabilityOptions): Promise<{ size: number; mtimeMs: number }> {
  const interval = opts.intervalMs ?? Math.min(1000, Math.max(100, Math.floor(opts.stableMs / 3)));
  const deadline = Date.now() + (opts.timeoutMs ?? 6 * 60 * 60 * 1000);
  let last: { size: number; mtimeMs: number } | null = null;
  let stableSince = 0;
  for (;;) {
    if (opts.signal?.aborted) throw new Error('aborted');
    if (Date.now() > deadline) throw new Error(`File did not finish copying: ${file}`);
    let st: { size: number; mtimeMs: number } | null = null;
    try {
      const s = await fs.stat(file);
      st = { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      st = null; // not there yet, or temporarily locked
    }
    if (st && st.size > 0 && last && st.size === last.size && st.mtimeMs === last.mtimeMs) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= opts.stableMs && (await canOpen(file))) return st;
    } else {
      stableSince = 0;
      if (st) opts.onWait?.(st.size);
    }
    last = st;
    await sleep(interval, opts.signal);
  }
}

async function canOpen(file: string): Promise<boolean> {
  try {
    const h = await fs.open(file, 'r');
    await h.close();
    return true;
  } catch {
    return false;
  }
}
