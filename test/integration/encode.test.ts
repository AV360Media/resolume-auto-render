import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findFfmpegInstalls, probe, run, validateOutput, type FfmpegInstall } from '../../src/ffmpeg.js';
import { Service } from '../../src/service.js';
import { Logger } from '../../src/log.js';
import { MockArena } from '../mock/mock-arena.js';
import { FINAL_STATES, type Job } from '../../src/queue.js';

/**
 * Real ffmpeg DXV encodes. Needs ffmpeg >= 7.0 with the dxv encoder:
 * bundled in vendor/ffmpeg/<platform>-<arch> (npm run fetch-ffmpeg), RAR_FFMPEG, or on PATH.
 */
let inst: FfmpegInstall | undefined;
let work: string;

beforeAll(async () => {
  inst = (await findFfmpegInstalls()).find((i) => i.encoders.has('dxv'));
  if (!inst) throw new Error('No ffmpeg with the dxv encoder found. Run `npm run fetch-ffmpeg` or set RAR_FFMPEG.');
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'rar-int-'));
}, 60000);

async function makeClip(name: string, opts: { w?: number; h?: number; secs?: number; alpha?: boolean; audio?: boolean } = {}) {
  const { w = 1000, h = 562, secs = 2, alpha = false, audio = true } = opts;
  const file = path.join(work, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const args = ['-hide_banner', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}:r=25:d=${secs}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=f=440:d=${secs}`);
  if (alpha) args.push('-vf', 'format=rgba,geq=r=r(X\\,Y):g=g(X\\,Y):b=b(X\\,Y):a=128', '-c:v', 'png');
  else args.push('-c:v', 'mpeg4', '-q:v', '5');
  if (audio) args.push('-c:a', 'aac', '-shortest');
  args.push(file);
  const r = await run(inst!.ffmpeg, args);
  if (r.code !== 0) throw new Error(r.stderr);
  return file;
}

describe('ffmpeg DXV encode (real)', () => {
  it('encodes a non-multiple-of-16 clip and the output validates', async () => {
    const src = await makeClip('raw/odd size ü.mp4');
    const out = path.join(work, 'raw/out.mov');
    const r = await run(inst!.ffmpeg, ['-y', '-i', src, '-vf', 'pad=ceil(iw/16)*16:ceil(ih/16)*16:(ow-iw)/2:(oh-ih)/2,setsar=1,format=rgba', '-c:v', 'dxv', '-format', 'dxt1', '-c:a', 'pcm_s16le', out]);
    expect(r.code).toBe(0);
    const info = await validateOutput(inst!, out, { codec: 'dxv', tags: ['DXD3'], multipleOf: 16 });
    expect([info.width, info.height]).toEqual([1008, 576]);
    expect(info.hasAudio).toBe(true);
  });

  it('validator rejects a file that is not DXV', async () => {
    const src = await makeClip('raw/not dxv.mp4', { audio: false });
    await expect(validateOutput(inst!, src, { codec: 'dxv', tags: ['DXD3'], multipleOf: 16 })).rejects.toThrow(/codec/);
  });
});

describe('end to end with mock Arena', () => {
  let arena: MockArena | null = null;
  let svc: Service | null = null;
  afterEach(async () => {
    await svc?.stop();
    await arena?.stop();
    svc = null;
    arena = null;
  });

  async function boot(settings: object = {}) {
    arena = new MockArena({ layers: 2, columns: 4 });
    const port = await arena.start();
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rar-data-'));
    await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({
      arenaPort: port, pollIntervalMs: 500, stableMs: 500, checkUpdates: false,
      ffmpegPath: inst!.ffmpeg, ffprobePath: inst!.ffprobe, ...settings,
    }));
    svc = new Service({ dataDir, version: '0.0.0-test', logger: new Logger(false), skipUpdateCheck: true });
    await svc.start();
    await until(() => svc!.arena.getStatus().websocket && svc!.tracker.all().length > 0);
    return svc;
  }

  const until = async (cond: () => boolean, ms = 30000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const finished = async (source: string): Promise<Job> => {
    let job: Job | undefined;
    await until(() => !!(job = svc!.queue.list().find((j) => j.source === source && FINAL_STATES.has(j.state))), 60000);
    return job!;
  };

  it('converts a clip dropped into Arena and swaps the DXV into the same clip', async () => {
    await boot();
    const src = await makeClip('show/My Clip 日本.mp4');
    const clip = arena!.userLoad(2, 3, src, 'Opener');
    clip.transport.controls.speed.value = 1.5;
    const job = await finished(src);
    expect(job.state, job.error).toBe('done');
    const expected = path.join(work, 'show/DXV/My Clip 日本.mov');
    expect(job.output).toBe(expected);
    const info = await probe(inst!.ffprobe, expected);
    expect(info).toMatchObject({ codec: 'dxv', codecTag: 'DXD3', width: 1008, height: 576 });
    const after = arena!.clipById(clip.id)!;
    expect(arena!.pathOf(after)).toBe(expected);
    expect(after.name.value).toBe('Opener');
    expect(after.transport.controls.speed.value).toBe(1.5);
    // Original untouched.
    expect((await fs.stat(src)).size).toBeGreaterThan(0);
    // Loading the DXV back did not start a new job.
    await new Promise((r) => setTimeout(r, 800));
    expect(svc!.queue.list().filter((j) => j.source === expected)).toEqual([]);
  });

  it('reuses the cache for a second clip with the same file', async () => {
    await boot();
    const src = await makeClip('cache/loop.mp4', { secs: 1 });
    arena!.userLoad(1, 1, src);
    const first = await finished(src);
    expect(first.state).toBe('done');
    svc!.queue.clearFinished();
    const c2 = arena!.userLoad(1, 2, src);
    const second = await finished(src);
    expect(second.state).toBe('done');
    expect(second.detail).toMatch(/Swapped/);
    expect(arena!.pathOf(arena!.clipById(c2.id)!)).toBe(first.output);
    const dxvDir = await fs.readdir(path.join(work, 'cache/DXV'));
    expect(dxvDir.filter((f) => f.endsWith('.mov'))).toEqual(['loop.mov']);
  });

  it('does not swap when the clip changed to another file during encoding', async () => {
    await boot({ stableMs: 1500 });
    const src = await makeClip('changed/first.mp4', { secs: 1 });
    const clip = arena!.userLoad(1, 3, src);
    await until(() => svc!.queue.list().some((j) => j.source === src));
    arena!.userLoad(1, 3, '/elsewhere/other.mov');
    const job = await finished(src);
    expect(job.state).toBe('done');
    expect(job.warnings.join(' ')).toMatch(/different file/);
    expect(arena!.pathOf(arena!.clipById(clip.id)!)).toBe('/elsewhere/other.mov');
  });

  it('skips files that are already DXV and keeps alpha sources by default', async () => {
    await boot();
    const dxvSrc = path.join(work, 'skip/already.mov');
    await fs.mkdir(path.dirname(dxvSrc), { recursive: true });
    await run(inst!.ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25:d=1', '-vf', 'format=rgba', '-c:v', 'dxv', dxvSrc]);
    arena!.userLoad(1, 1, dxvSrc);
    expect((await finished(dxvSrc)).detail).toBe('Already DXV');

    const alphaSrc = await makeClip('skip/alpha.mov', { w: 320, h: 240, secs: 1, alpha: true, audio: false });
    const ac = arena!.userLoad(1, 2, alphaSrc);
    const aj = await finished(alphaSrc);
    expect(aj.state).toBe('skipped');
    expect(aj.detail).toMatch(/alpha/);
    expect(arena!.pathOf(arena!.clipById(ac.id)!)).toBe(alphaSrc);
  });

  it('drops alpha with a warning when allowed', async () => {
    await boot({ onAlphaUnavailable: 'downgrade', quality: 'high', onHqUnavailable: 'downgrade' });
    const alphaSrc = await makeClip('alpha2/a.mov', { w: 320, h: 240, secs: 1, alpha: true, audio: false });
    arena!.userLoad(1, 1, alphaSrc);
    const j = await finished(alphaSrc);
    expect(j.state, j.error).toBe('done');
    expect(j.warnings.join(' ')).toMatch(/Alpha dropped/);
    expect(j.warnings.join(' ')).toMatch(/Normal Quality/);
  });

  it('converts files dropped into a watch folder', async () => {
    const watch = path.join(work, 'watch');
    await fs.mkdir(watch, { recursive: true });
    await boot({ watchFolders: [watch] });
    await new Promise((r) => setTimeout(r, 500));
    const tmp = await makeClip('staging/dropped clip.mp4', { secs: 1, audio: false });
    const dest = path.join(watch, 'dropped clip.mp4');
    await fs.copyFile(tmp, dest);
    const j = await finished(dest);
    expect(j.state, j.error).toBe('done');
    expect(j.output).toBe(path.join(watch, 'DXV', 'dropped clip.mov'));
    await new Promise((r) => setTimeout(r, 1000));
    // Its own output was not picked up again.
    expect(svc!.queue.list().length).toBe(1);
  });

  it('keeps the original playing and reports a failed encode for a broken file, then retries', async () => {
    await boot();
    const bad = path.join(work, 'bad/broken.mp4');
    await fs.mkdir(path.dirname(bad), { recursive: true });
    await fs.writeFile(bad, 'this is not a video');
    const c = arena!.userLoad(1, 4, bad);
    const j = await finished(bad);
    expect(j.state).toBe('failed');
    expect(j.error).toMatch(/ffprobe/);
    expect(arena!.pathOf(arena!.clipById(c.id)!)).toBe(bad);
    expect(svc!.queue.retry(j.id)).toBe(true);
    await until(() => svc!.queue.get(j.id)!.attempts === 2 && FINAL_STATES.has(svc!.queue.get(j.id)!.state), 30000);
  });
});
