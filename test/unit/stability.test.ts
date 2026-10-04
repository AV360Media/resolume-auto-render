import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitForStableFile } from '../../src/stability.js';

describe('waitForStableFile', () => {
  it('waits while a file is still growing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rar-stab-'));
    const f = path.join(dir, 'growing file ü.mov');
    await fs.writeFile(f, 'a');
    let writes = 0;
    const t = setInterval(() => { if (writes++ < 5) void fs.appendFile(f, 'more data'); }, 60);
    const start = Date.now();
    const st = await waitForStableFile(f, { stableMs: 200, intervalMs: 40 });
    clearInterval(t);
    expect(Date.now() - start).toBeGreaterThanOrEqual(300);
    expect(st.size).toBe((await fs.stat(f)).size);
  });
  it('waits for a file that does not exist yet', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rar-stab-'));
    const f = path.join(dir, 'later.mov');
    setTimeout(() => void fs.writeFile(f, 'x'), 150);
    const st = await waitForStableFile(f, { stableMs: 100, intervalMs: 30 });
    expect(st.size).toBe(1);
  });
  it('can be aborted and times out', async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    await expect(waitForStableFile('/nope/x.mov', { stableMs: 100, intervalMs: 20, signal: ctl.signal })).rejects.toThrow('aborted');
    await expect(waitForStableFile('/nope/x.mov', { stableMs: 100, intervalMs: 20, timeoutMs: 60 })).rejects.toThrow(/did not finish/);
  });
});
