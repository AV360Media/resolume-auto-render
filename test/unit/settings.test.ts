import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeSettings, DEFAULT_SETTINGS, SettingsStore } from '../../src/settings.js';
import { compareVersions, checkForUpdate } from '../../src/update.js';
import { splitCommand, fillTemplate } from '../../src/encoders/alley.js';
import { dxvFilter, needsResize, progressParser } from '../../src/encoders/ffmpeg-dxv.js';
import { pixFmtHasAlpha } from '../../src/ffmpeg.js';
import { ignoredInWatchFolder } from '../../src/folders.js';

describe('sanitizeSettings', () => {
  it('drops unknown keys and bad values, clamps numbers', () => {
    const s = sanitizeSettings({ bogus: 1, concurrency: 99, quality: 'ultra', arenaPort: '9090', autoReplace: 'yes', watchFolders: ['/a', 3, ' '] });
    expect((s as any).bogus).toBeUndefined();
    expect(s.concurrency).toBe(8);
    expect(s.quality).toBe('normal');
    expect(s.arenaPort).toBe(9090);
    expect(s.autoReplace).toBe(DEFAULT_SETTINGS.autoReplace);
    expect(s.watchFolders).toEqual(['/a']);
  });
  it('defaults match the brief', () => {
    expect(DEFAULT_SETTINGS.arenaHost).toBe('127.0.0.1');
    expect(DEFAULT_SETTINGS.arenaPort).toBe(8080);
    expect(DEFAULT_SETTINGS.concurrency).toBe(2);
    expect(DEFAULT_SETTINGS.codec).toBe('dxv');
    expect(DEFAULT_SETTINGS.outputFolder).toBe('');
  });
  it('persists through the store', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rar-set-'));
    const st = new SettingsStore(dir);
    await st.load();
    await st.update({ quality: 'high', ignore: ['*.webm'] });
    const st2 = new SettingsStore(dir);
    expect((await st2.load()).quality).toBe('high');
    expect(st2.get().ignore).toEqual(['*.webm']);
  });
});

describe('update check', () => {
  it('compares versions', () => {
    expect(compareVersions('v1.2.0', '1.1.9')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.9.10', '0.10.0')).toBe(-1);
  });
  it('reports a newer release', async () => {
    const fake = (async () => new Response(JSON.stringify({ tag_name: 'v0.2.0', html_url: 'https://x' }), { status: 200 })) as typeof fetch;
    const u = await checkForUpdate('0.1.0', fake);
    expect(u.available).toBe(true);
    expect(u.latest).toBe('0.2.0');
  });
  it('handles no releases and network errors', async () => {
    const none = (async () => new Response('{}', { status: 404 })) as typeof fetch;
    expect((await checkForUpdate('0.1.0', none)).available).toBe(false);
    const boom = (async () => { throw new Error('offline'); }) as typeof fetch;
    expect((await checkForUpdate('0.1.0', boom)).error).toBe('offline');
  });
});

describe('encoder helpers', () => {
  it('splits command templates without a shell', () => {
    expect(splitCommand(`"/Applications/My Tool/cli" --in {input} --out '{output}' -q {quality}`)).toEqual(['/Applications/My Tool/cli', '--in', '{input}', '--out', '{output}', '-q', '{quality}']);
    expect(fillTemplate(['--in', '{input}', '{nope}'], { input: '/a b/c.mov' })).toEqual(['--in', '/a b/c.mov', '{nope}']);
  });
  it('builds the DXV filter', () => {
    expect(dxvFilter('pad')).toContain('pad=ceil(iw/16)*16:ceil(ih/16)*16');
    expect(dxvFilter('scale')).toContain('scale=ceil(iw/16)*16');
    expect(dxvFilter('pad')).toMatch(/format=rgba$/);
    expect(needsResize(1920, 1080)).toBe(true);
    expect(needsResize(1280, 720)).toBe(false);
  });
  it('parses ffmpeg progress', () => {
    const seen: number[] = [];
    const parse = progressParser(10, (f) => seen.push(f));
    parse('out_time_us=5000000');
    parse('progress=end');
    expect(seen).toEqual([0.5, 1]);
  });
  it('detects alpha pixel formats', () => {
    expect(pixFmtHasAlpha('yuva444p10le')).toBe(true);
    expect(pixFmtHasAlpha('argb')).toBe(true);
    expect(pixFmtHasAlpha('yuv422p10le')).toBe(false);
    expect(pixFmtHasAlpha('rgb24')).toBe(false);
  });
  it('watch folders skip our own output, hidden and partial files', () => {
    expect(ignoredInWatchFolder('/w/DXV/a.mov', '/w')).toBe(true);
    expect(ignoredInWatchFolder('/w/sub/Originals/a.mov', '/w')).toBe(true);
    expect(ignoredInWatchFolder('/w/.a.partial.mov', '/w')).toBe(true);
    expect(ignoredInWatchFolder('/w/sub/a.mov', '/w')).toBe(false);
    expect(ignoredInWatchFolder('/w', '/w')).toBe(false);
  });
});
