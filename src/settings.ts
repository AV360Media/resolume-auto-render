import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type Quality = 'normal' | 'high';
export type AlphaMode = 'auto' | 'on' | 'off';
export type Codec = 'dxv' | 'hap';
/** What to do when no installed backend can satisfy a request (HQ or alpha). */
export type Unsatisfiable = 'downgrade' | 'skip';

export interface Settings {
  arenaHost: string;
  arenaPort: number;
  /** Poll GET /composition this often as a fallback to WebSocket pushes. 0 disables. */
  pollIntervalMs: number;
  /** Port of the control panel. */
  uiPort: number;
  /** Serve index.test.html at / instead of index.html. */
  testMode: boolean;

  codec: Codec;
  quality: Quality;
  alpha: AlphaMode;
  /** Applies when a request needs HQ: downgrade to Normal or skip the file. */
  onHqUnavailable: Unsatisfiable;
  /** Applies when a source has alpha: drop alpha (flatten on black) or skip the file. */
  onAlphaUnavailable: Unsatisfiable;
  /** Preferred backend id, or 'auto'. */
  backend: string;
  /** ffmpeg DXV needs sizes in multiples of 16: add black borders (pad) or resample (scale). */
  dxvFit: 'pad' | 'scale';
  concurrency: number;

  /** Empty = <original folder>/DXV. Absolute path = one shared output folder. */
  outputFolder: string;
  postConvert: 'keep' | 'move';
  /** Empty = <original folder>/Originals. */
  moveOriginalsTo: string;

  autoReplace: boolean;
  /** Convert clips that already hold non-DXV media when Arena first connects. */
  convertExistingOnConnect: boolean;
  /** Swap a clip while it is playing. Off = wait until it stops playing. */
  swapWhileLive: boolean;
  /** Restore clip name and transport params after swapping. */
  restoreClipProps: boolean;
  /** Body format for the clip open call. */
  fileUriStyle: 'raw' | 'encoded';

  watchFolders: string[];
  /** Exact paths or glob-like patterns (* and ?) that are never converted. */
  ignore: string[];

  /** Size must hold still this long before encoding starts. */
  stableMs: number;

  ffmpegPath: string;
  ffprobePath: string;
  /** Command template for an Alley CLI, if one ever exists. {input} {output} {quality} {alpha}. */
  alleyCliCommand: string;
  /** Adobe Media Encoder watch folder with a DXV3 preset applied. */
  ameWatchFolder: string;
  /** Where AME writes its output for that watch folder. */
  ameOutputFolder: string;

  checkUpdates: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  arenaHost: '127.0.0.1',
  arenaPort: 8080,
  pollIntervalMs: 2000,
  uiPort: 8765,
  testMode: false,
  codec: 'dxv',
  quality: 'normal',
  alpha: 'auto',
  onHqUnavailable: 'downgrade',
  onAlphaUnavailable: 'skip',
  backend: 'auto',
  dxvFit: 'pad',
  concurrency: 2,
  outputFolder: '',
  postConvert: 'keep',
  moveOriginalsTo: '',
  autoReplace: true,
  convertExistingOnConnect: false,
  swapWhileLive: false,
  restoreClipProps: true,
  fileUriStyle: 'raw',
  watchFolders: [],
  ignore: [],
  stableMs: 3000,
  ffmpegPath: '',
  ffprobePath: '',
  alleyCliCommand: '',
  ameWatchFolder: '',
  ameOutputFolder: '',
  checkUpdates: true,
};

export function defaultDataDir(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Resolume Auto Render');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Resolume Auto Render');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'resolume-auto-render');
}

/** Coerce untrusted input (file or UI) into valid settings. Unknown keys are dropped. */
export function sanitizeSettings(input: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const out: Settings = { ...base };
  if (!input || typeof input !== 'object') return out;
  const src = input as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (!(key in src)) continue;
    const def = DEFAULT_SETTINGS[key];
    const v = src[key];
    if (Array.isArray(def)) {
      if (Array.isArray(v)) (out as any)[key] = v.filter((x) => typeof x === 'string' && x.trim()).map((x) => (x as string).trim());
    } else if (typeof def === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) (out as any)[key] = n;
    } else if (typeof def === 'boolean') {
      if (typeof v === 'boolean') (out as any)[key] = v;
    } else if (typeof v === 'string') {
      (out as any)[key] = v.trim();
    }
  }
  const pick = <T extends string>(v: string, allowed: T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);
  out.codec = pick(out.codec, ['dxv', 'hap'], 'dxv');
  out.quality = pick(out.quality, ['normal', 'high'], 'normal');
  out.alpha = pick(out.alpha, ['auto', 'on', 'off'], 'auto');
  out.onHqUnavailable = pick(out.onHqUnavailable, ['downgrade', 'skip'], 'downgrade');
  out.onAlphaUnavailable = pick(out.onAlphaUnavailable, ['downgrade', 'skip'], 'skip');
  out.dxvFit = pick(out.dxvFit, ['pad', 'scale'], 'pad');
  out.postConvert = pick(out.postConvert, ['keep', 'move'], 'keep');
  out.fileUriStyle = pick(out.fileUriStyle, ['raw', 'encoded'], 'raw');
  out.concurrency = Math.min(8, Math.max(1, Math.round(out.concurrency)));
  out.arenaPort = Math.min(65535, Math.max(1, Math.round(out.arenaPort)));
  out.uiPort = Math.min(65535, Math.max(1, Math.round(out.uiPort)));
  out.pollIntervalMs = out.pollIntervalMs <= 0 ? 0 : Math.max(500, out.pollIntervalMs);
  out.stableMs = Math.max(500, out.stableMs);
  return out;
}

export class SettingsStore {
  private current: Settings;
  readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'settings.json');
    this.current = { ...DEFAULT_SETTINGS };
  }

  get(): Settings {
    return this.current;
  }

  async load(): Promise<Settings> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      this.current = sanitizeSettings(JSON.parse(raw));
    } catch {
      this.current = { ...DEFAULT_SETTINGS };
    }
    return this.current;
  }

  async update(patch: unknown): Promise<Settings> {
    this.current = sanitizeSettings(patch, this.current);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(this.current, null, 2));
    await fs.rename(tmp, this.file);
    return this.current;
  }
}
