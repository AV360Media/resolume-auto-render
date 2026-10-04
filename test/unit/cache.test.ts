import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversionCache, cacheKey } from '../../src/cache.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rar-cache-'));
});

const entry = (output: string, extra = {}) => ({
  source: '/src/a.mp4', size: 100, mtimeMs: 1700000000000, output, backend: 'ffmpeg-dxv', codec: 'dxv', quality: 'normal', alpha: false, at: 1, ...extra,
});

describe('cacheKey', () => {
  it('changes with path, size and mtime', () => {
    const k = cacheKey('/a', 1, 2);
    expect(cacheKey('/a', 1, 2)).toBe(k);
    expect(cacheKey('/b', 1, 2)).not.toBe(k);
    expect(cacheKey('/a', 2, 2)).not.toBe(k);
    expect(cacheKey('/a', 1, 3)).not.toBe(k);
  });
  it('treats NFC and NFD names as the same file', () => {
    expect(cacheKey('/Café', 1, 1)).toBe(cacheKey('/Café', 1, 1));
  });
});

describe('ConversionCache', () => {
  it('stores, persists and reloads', async () => {
    const out = path.join(dir, 'a.mov');
    await fs.writeFile(out, 'x');
    const c = new ConversionCache(path.join(dir, 'db.json'));
    await c.load();
    await c.put(entry(out));
    expect((await c.lookup('/src/a.mp4', 100, 1700000000000))?.output).toBe(out);
    const c2 = new ConversionCache(path.join(dir, 'db.json'));
    await c2.load();
    expect(c2.size).toBe(1);
    expect(c2.isOutput(out)).toBe(true);
    expect((await c2.lookup('/src/a.mp4', 100, 1700000000000))?.backend).toBe('ffmpeg-dxv');
  });
  it('misses when the source changed or the output is gone', async () => {
    const out = path.join(dir, 'b.mov');
    await fs.writeFile(out, 'x');
    const c = new ConversionCache(path.join(dir, 'db.json'));
    await c.put(entry(out));
    expect(await c.lookup('/src/a.mp4', 101, 1700000000000)).toBeUndefined();
    await fs.rm(out);
    expect(await c.lookup('/src/a.mp4', 100, 1700000000000)).toBeUndefined();
  });
  it('survives a corrupt file', async () => {
    const f = path.join(dir, 'db.json');
    await fs.writeFile(f, '{not json');
    const c = new ConversionCache(f);
    await c.load();
    expect(c.size).toBe(0);
    await c.put(entry(path.join(dir, 'c.mov')));
    expect(JSON.parse(await fs.readFile(f, 'utf8')).version).toBe(1);
  });
  it('coalesces concurrent writes without losing entries', async () => {
    const c = new ConversionCache(path.join(dir, 'db.json'));
    await Promise.all(Array.from({ length: 20 }, (_, i) => c.put(entry(`/o/${i}.mov`, { source: `/s/${i}.mp4` }))));
    const c2 = new ConversionCache(path.join(dir, 'db.json'));
    await c2.load();
    expect(c2.size).toBe(20);
  });
  it('removes and clears', async () => {
    const c = new ConversionCache(path.join(dir, 'db.json'));
    await c.put(entry('/o/x.mov'));
    await c.remove('/src/a.mp4', 100, 1700000000000);
    expect(c.size).toBe(0);
    expect(c.isOutput('/o/x.mov')).toBe(false);
    await c.put(entry('/o/x.mov'));
    await c.clear();
    expect(c.size).toBe(0);
  });
});
