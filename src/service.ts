import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Logger } from './log.js';
import { SettingsStore, type Settings } from './settings.js';
import { ConversionCache } from './cache.js';
import { JobQueue, SkipJob, type Job, type JobContext } from './queue.js';
import { waitForStableFile } from './stability.js';
import { findFfmpegInstalls, probe, validateOutput, type FfmpegInstall } from './ffmpeg.js';
import {
  fromArenaPath, isProbablyNetworkPath, matchesIgnore, mediaKind, outputPathFor, partialPathFor, samePath, uniquePath,
} from './paths.js';
import { ArenaConnection, type ConnectionStatus } from './resolume/connection.js';
import { ClipTracker, type MediaChange } from './resolume/tracker.js';
import { swapClipFile, ClipChangedError } from './resolume/swap.js';
import { FolderWatcher } from './folders.js';
import type { Encoder, EncoderEnv, Capabilities } from './encoders/types.js';
import { FfmpegDxvEncoder } from './encoders/ffmpeg-dxv.js';
import { HapEncoder } from './encoders/hap.js';
import { AlleyCliEncoder, AlleyAutomationEncoder } from './encoders/alley.js';
import { AmeEncoder } from './encoders/ame.js';
import { selectEncoder, type Probed } from './encoders/select.js';
import { checkForUpdate, type UpdateInfo } from './update.js';

export interface BackendInfo {
  id: string;
  label: string;
  caps: Capabilities;
}

export interface ServiceOptions {
  dataDir: string;
  version: string;
  logger?: Logger;
  /** Overrides for tests. */
  platform?: NodeJS.Platform;
  encoders?: (env: EncoderEnv) => Encoder[];
  skipUpdateCheck?: boolean;
}

const exists = (p: string) => fs.access(p).then(() => true, () => false);

/**
 * Wires Arena, the watchers, the queue and the encoders together.
 * Emits 'job', 'status', 'settings', 'backends', 'update' for the UI server.
 */
export class Service extends EventEmitter {
  readonly log: Logger;
  readonly settings: SettingsStore;
  readonly cache: ConversionCache;
  readonly queue: JobQueue;
  readonly arena: ArenaConnection;
  readonly tracker: ClipTracker;
  readonly folders: FolderWatcher;
  readonly platform: NodeJS.Platform;
  private installs: FfmpegInstall[] = [];
  private encoders: Encoder[];
  private probed: Probed[] = [];
  private updateInfo: UpdateInfo;
  private updateTimer: NodeJS.Timeout | null = null;

  constructor(private opts: ServiceOptions) {
    super();
    this.platform = opts.platform ?? process.platform;
    this.log = opts.logger ?? new Logger();
    this.settings = new SettingsStore(opts.dataDir);
    this.cache = new ConversionCache(path.join(opts.dataDir, 'conversions.json'));
    this.queue = new JobQueue((job, ctx) => this.runJob(job, ctx), 2);
    this.queue.on('update', (job: Job) => this.emit('job', job));
    this.updateInfo = { current: opts.version, available: false };

    const s = () => this.settings.get();
    this.arena = new ArenaConnection({ host: () => s().arenaHost, port: () => s().arenaPort, pollIntervalMs: () => s().pollIntervalMs });
    this.tracker = new ClipTracker((p) => fromArenaPath(p, this.platform), () => s().convertExistingOnConnect, this.platform);
    this.arena.on('status', (st: ConnectionStatus) => this.emit('status', st));
    this.arena.on('connected', (p) => {
      this.tracker.reset();
      this.log.info(`Connected to ${p.name} ${p.major}.${p.minor}.${p.micro} at ${s().arenaHost}:${s().arenaPort}`);
    });
    this.arena.on('disconnected', () => {
      this.tracker.reset();
      this.log.warn('Lost connection to Arena. Retrying.');
    });
    this.arena.on('session-reset', () => this.tracker.reset());
    this.arena.on('composition', (comp) => this.tracker.update(comp));
    this.tracker.on('media-changed', (ch: MediaChange) => this.onClipMedia(ch));
    this.folders = new FolderWatcher((f) => this.onFolderFile(f), (m) => this.log.warn(m));

    const env: EncoderEnv = { settings: s, ffmpegInstalls: () => this.installs, platform: this.platform };
    // Priority order from the brief. Selection also respects capability, so HQ/alpha requests skip ahead.
    this.encoders = opts.encoders
      ? opts.encoders(env)
      : [new AlleyCliEncoder(env), new AlleyAutomationEncoder(), new FfmpegDxvEncoder(env), new AmeEncoder(env), new HapEncoder(env)];
  }

  async start(): Promise<void> {
    const s = await this.settings.load();
    await this.cache.load();
    this.queue.setConcurrency(s.concurrency);
    await this.refreshBackends();
    await this.folders.set(s.watchFolders);
    this.arena.start();
    if (!this.opts.skipUpdateCheck && s.checkUpdates) {
      void this.checkUpdates();
      this.updateTimer = setInterval(() => void this.checkUpdates(), 24 * 60 * 60 * 1000);
    }
    this.log.info(`Cache: ${this.cache.size} converted files. Watching ${s.watchFolders.length} folder(s).`);
  }

  async stop(): Promise<void> {
    if (this.updateTimer) clearInterval(this.updateTimer);
    this.arena.stop();
    await this.folders.close();
    await this.queue.stop();
    await this.cache.flush();
  }

  getSettings(): Settings {
    return this.settings.get();
  }

  async updateSettings(patch: unknown): Promise<Settings> {
    const before = this.settings.get();
    const s = await this.settings.update(patch);
    this.queue.setConcurrency(s.concurrency);
    if (before.arenaHost !== s.arenaHost || before.arenaPort !== s.arenaPort || before.pollIntervalMs !== s.pollIntervalMs) this.arena.restart();
    await this.folders.set(s.watchFolders);
    if (before.ffmpegPath !== s.ffmpegPath || before.ffprobePath !== s.ffprobePath) this.installs = [];
    await this.refreshBackends();
    this.emit('settings', s);
    return s;
  }

  backends(): BackendInfo[] {
    return this.probed.map((p) => ({ id: p.encoder.id, label: p.encoder.label, caps: p.caps }));
  }

  ffmpeg(): FfmpegInstall | undefined {
    return this.installs.find((i) => i.encoders.has('dxv')) || this.installs[0];
  }

  async refreshBackends(): Promise<BackendInfo[]> {
    if (!this.installs.length) {
      const s = this.settings.get();
      this.installs = await findFfmpegInstalls({ ffmpegPath: s.ffmpegPath, ffprobePath: s.ffprobePath });
      if (!this.installs.length) this.log.error('ffmpeg not found. Install the app build that bundles it, or set the ffmpeg path in settings.');
      else if (!this.installs.some((i) => i.encoders.has('dxv'))) this.log.warn(`ffmpeg ${this.installs[0].version} has no DXV encoder. Needs ffmpeg 7.0 or newer.`);
    }
    this.probed = [];
    for (const e of this.encoders) {
      try {
        this.probed.push({ encoder: e, caps: await e.probe() });
      } catch (err) {
        this.probed.push({ encoder: e, caps: { available: false, reason: (err as Error).message, codec: 'dxv', qualities: [], alpha: false, notes: [] } });
      }
    }
    this.emit('backends', this.backends());
    return this.backends();
  }

  update(): UpdateInfo {
    return this.updateInfo;
  }

  async checkUpdates(): Promise<UpdateInfo> {
    this.updateInfo = await checkForUpdate(this.opts.version);
    if (this.updateInfo.available) this.log.info(`Update available: ${this.updateInfo.latest}`);
    this.emit('update', this.updateInfo);
    return this.updateInfo;
  }

  /** Manual add from the UI. */
  convert(file: string): Job {
    return this.queue.add({ source: file, origin: 'manual' });
  }

  async ignore(file: string): Promise<void> {
    const s = this.settings.get();
    if (!s.ignore.some((x) => samePath(x, file, this.platform))) await this.updateSettings({ ignore: [...s.ignore, file] });
  }

  private shouldIgnore(file: string, why: string): boolean {
    const s = this.settings.get();
    if (this.cache.isOutput(file)) return true;
    if (matchesIgnore(file, s.ignore, this.platform)) {
      this.log.info(`Ignored (ignore list): ${file}`);
      return true;
    }
    const kind = mediaKind(file);
    if (kind === 'image' || kind === 'audio') {
      this.log.debug(`Skipped ${kind} (${why}): ${file}`);
      return true;
    }
    return false;
  }

  private onClipMedia(ch: MediaChange): void {
    const { clip } = ch;
    if (this.shouldIgnore(clip.path, 'clip')) return;
    this.log.info(`Clip L${clip.layer} C${clip.column} "${clip.name}" loaded ${clip.path}`);
    this.queue.add({ source: clip.path, origin: 'clip', clip: { id: clip.id, layer: clip.layer, column: clip.column, name: clip.name } });
  }

  private onFolderFile(file: string): void {
    if (this.shouldIgnore(file, 'watch folder')) return;
    this.log.info(`New file in watch folder: ${file}`);
    this.queue.add({ source: file, origin: 'folder' });
  }

  private async runJob(job: Readonly<Job>, ctx: JobContext): Promise<void> {
    const s = this.settings.get();
    const src = job.source;

    ctx.update({ state: 'waiting', detail: 'Waiting for file to finish copying' });
    const stableMs = isProbablyNetworkPath(src, this.platform) ? s.stableMs * 2 : s.stableMs;
    const st = await waitForStableFile(src, { stableMs, signal: ctx.signal, onWait: (size) => ctx.update({ detail: `Copying… ${(size / 1e6).toFixed(1)} MB` }) });

    const inst = this.ffmpeg();
    if (!inst) throw new Error('ffmpeg not found');
    ctx.update({ state: 'probing', detail: 'Reading file' });
    const info = await probe(inst.ffprobe, src, ctx.signal);
    if (!info.hasVideo) throw new SkipJob(info.hasAudio ? 'Audio only' : 'No video stream');
    if (info.isStill) throw new SkipJob('Still image');
    if (info.codec === 'dxv') throw new SkipJob('Already DXV');
    if (s.codec === 'hap' && info.codec === 'hap') throw new SkipJob('Already HAP');

    let output: string;
    const cached = await this.cache.lookup(src, st.size, st.mtimeMs);
    if (cached && cached.codec === s.codec) {
      output = cached.output;
      ctx.update({ output, backend: cached.backend, progress: 0.9, detail: 'Already converted' });
      this.log.info(`Cache hit: ${src} -> ${output}`);
    } else {
      output = await this.encode(job, ctx, info, st);
    }

    let swappedClip: number | null = null;
    if (job.origin === 'clip' && job.clip) {
      if (!s.autoReplace) {
        ctx.update({ detail: 'Converted. Auto-replace is off.' });
      } else {
        ctx.update({ state: 'swapping', detail: 'Loading into clip', progress: 0.96 });
        try {
          const r = await swapClipFile(this.arena.rest, job.clip, src, output, {
            uriStyle: s.fileUriStyle,
            restoreProps: s.restoreClipProps,
            platform: this.platform,
            log: (m) => this.log.info(m),
          });
          swappedClip = job.clip.id;
          if (r.notRestored.length) ctx.warn(`Could not restore: ${r.notRestored.join(', ')}`);
          ctx.update({ detail: `Swapped into L${r.layer} C${r.column}` });
          this.log.info(`Swapped clip ${job.clip.id} to ${output}`);
        } catch (e) {
          if (e instanceof ClipChangedError) {
            ctx.warn(e.message);
            ctx.update({ detail: 'Converted. Clip changed, not swapped.' });
            this.log.warn(`Not swapped: ${e.message}`);
            return;
          }
          throw e;
        }
      }
    }
    await this.postConvert(ctx, src, swappedClip);
    if (!job.clip || !s.autoReplace) ctx.update({ detail: `Converted: ${path.basename(output)}` });
  }

  private async encode(job: Readonly<Job>, ctx: JobContext, info: Awaited<ReturnType<typeof probe>>, st: { size: number; mtimeMs: number }): Promise<string> {
    const s = this.settings.get();
    const src = job.source;
    const wantAlpha = s.alpha === 'on' ? true : s.alpha === 'off' ? false : info.hasAlpha;
    const sel = selectEncoder(this.probed, { codec: s.codec, quality: s.quality, alpha: wantAlpha }, s);
    if (sel.kind === 'skip') throw new SkipJob(sel.reason);
    for (const w of sel.warnings) ctx.warn(w);

    let output = outputPathFor(src, { outputFolder: s.outputFolder, codec: s.codec }, this.platform);
    if (samePath(output, src, this.platform)) throw new Error('Output path equals the source path. Change the output folder.');
    output = await uniquePath(output, exists, this.platform);
    await fs.mkdir(path.dirname(output), { recursive: true });
    const temp = partialPathFor(output, this.platform);

    const req = { source: src, tempOutput: temp, info, quality: sel.quality, alpha: sel.alpha };
    ctx.update({ state: 'encoding', backend: sel.encoder.id, detail: `Encoding with ${sel.encoder.label}`, progress: 0.02 });
    this.log.info(`Encoding ${path.basename(src)} with ${sel.encoder.label} (${sel.quality}${sel.alpha ? ', alpha' : ''})`);
    try {
      await sel.encoder.encode(req, {
        signal: ctx.signal,
        onProgress: (f) => ctx.update({ progress: f < 0 ? -1 : 0.02 + f * 0.88 }),
        log: (m) => this.log.info(m),
      });
      ctx.update({ state: 'validating', detail: 'Checking output', progress: 0.91 });
      const inst = this.ffmpeg()!;
      await validateOutput(inst, temp, sel.encoder.expect(req), ctx.signal);
      // Re-check: something may have created the target meanwhile. Never overwrite.
      if (await exists(output)) output = await uniquePath(output, exists, this.platform);
      await fs.rename(temp, output);
    } catch (e) {
      await fs.rm(temp, { force: true }).catch(() => {});
      throw e;
    }
    await this.cache.put({
      source: src, size: st.size, mtimeMs: st.mtimeMs, output, backend: sel.encoder.id,
      codec: s.codec, quality: sel.quality, alpha: sel.alpha, at: Date.now(),
    });
    ctx.update({ output, progress: 0.95 });
    return output;
  }

  private async postConvert(ctx: JobContext, src: string, swappedClip: number | null): Promise<void> {
    const s = this.settings.get();
    if (s.postConvert !== 'move') return;
    // Never pull a file out from under a clip that still plays it.
    if (this.tracker.all().some((c) => c.id !== swappedClip && samePath(c.path, src, this.platform))) {
      ctx.warn('Original kept in place: a clip still uses it.');
      return;
    }
    const dir = s.moveOriginalsTo || path.join(path.dirname(src), 'Originals');
    await fs.mkdir(dir, { recursive: true });
    const dest = await uniquePath(path.join(dir, path.basename(src)), exists, this.platform);
    try {
      await fs.rename(src, dest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      await fs.copyFile(src, dest);
      await fs.unlink(src);
    }
    this.log.info(`Moved original to ${dest}`);
  }
}
