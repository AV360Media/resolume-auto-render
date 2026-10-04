import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toLongPath } from './paths.js';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  timeoutMs?: number;
}

/** Spawn without a shell. Arguments are passed as an array so spaces and unicode in paths are safe. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error('aborted'));
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let buf = '';
    const onAbort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      if (stdout.length < 4_000_000) stdout += d;
      if (opts.onStdoutLine) {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          opts.onStdoutLine(buf.slice(0, i).trim());
          buf = buf.slice(i + 1);
        }
      }
    });
    child.stderr.on('data', (d: string) => {
      stderr += d;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
      if (opts.signal?.aborted) return reject(new Error('aborted'));
      resolve({ code, stdout, stderr });
    });
  });
}

export interface FfmpegInstall {
  ffmpeg: string;
  ffprobe: string;
  version: string;
  encoders: Set<string>;
  source: string;
}

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

/** Directories that may hold a bundled ffmpeg, in priority order. */
export function bundledFfmpegDirs(): string[] {
  const dirs: string[] = [];
  const plat = `${process.platform}-${process.arch}`;
  const resources = (process as any).resourcesPath as string | undefined;
  if (resources) dirs.push(path.join(resources, 'ffmpeg'));
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/src -> repo root
  for (const up of ['..', '../..', '../../..']) dirs.push(path.resolve(here, up, 'vendor', 'ffmpeg', plat));
  return dirs;
}

async function inspect(ffmpeg: string, ffprobe: string, source: string): Promise<FfmpegInstall | null> {
  try {
    const v = await run(ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 15000 });
    if (v.code !== 0) return null;
    const version = (v.stdout.split('\n')[0] || '').replace(/^ffmpeg version\s*/, '').split(' ')[0];
    const enc = await run(ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 15000 });
    const encoders = new Set<string>();
    for (const line of enc.stdout.split('\n')) {
      const m = /^\s*[VAS][F.][S.][X.][B.][D.]\s+(\S+)/.exec(line);
      if (m) encoders.add(m[1]);
    }
    const p = await run(ffprobe, ['-version'], { timeoutMs: 15000 }).catch(() => null);
    if (!p || p.code !== 0) return null;
    return { ffmpeg, ffprobe, version, encoders, source };
  } catch {
    return null;
  }
}

/**
 * Finds every usable ffmpeg/ffprobe pair: configured path, RAR_FFMPEG env, bundled, then PATH.
 * Backends pick the first install that has the encoder they need.
 */
export async function findFfmpegInstalls(configured: { ffmpegPath?: string; ffprobePath?: string } = {}): Promise<FfmpegInstall[]> {
  const pairs: { ffmpeg: string; ffprobe: string; source: string }[] = [];
  const sibling = (f: string) => path.join(path.dirname(f), exe('ffprobe'));
  if (configured.ffmpegPath) pairs.push({ ffmpeg: configured.ffmpegPath, ffprobe: configured.ffprobePath || sibling(configured.ffmpegPath), source: 'settings' });
  if (process.env.RAR_FFMPEG) pairs.push({ ffmpeg: process.env.RAR_FFMPEG, ffprobe: process.env.RAR_FFPROBE || sibling(process.env.RAR_FFMPEG), source: 'RAR_FFMPEG' });
  for (const d of bundledFfmpegDirs()) {
    const f = path.join(d, exe('ffmpeg'));
    try {
      await fs.access(f);
      pairs.push({ ffmpeg: f, ffprobe: path.join(d, exe('ffprobe')), source: 'bundled' });
    } catch { /* not there */ }
  }
  pairs.push({ ffmpeg: exe('ffmpeg'), ffprobe: exe('ffprobe'), source: 'PATH' });
  const out: FfmpegInstall[] = [];
  const seen = new Set<string>();
  for (const p of pairs) {
    if (seen.has(p.ffmpeg)) continue;
    seen.add(p.ffmpeg);
    const i = await inspect(p.ffmpeg, p.ffprobe, p.source);
    if (i) out.push(i);
  }
  return out;
}

export interface MediaInfo {
  hasVideo: boolean;
  hasAudio: boolean;
  codec: string;
  codecTag: string;
  width: number;
  height: number;
  pixFmt: string;
  duration: number;
  fps: number;
  hasAlpha: boolean;
  /** True for still images that ffprobe reports as a video stream. */
  isStill: boolean;
}

const ALPHA_PIX = /^(yuva|rgba|bgra|argb|abgr|gbrap|ya8|ya16|pal8)/;

export function pixFmtHasAlpha(pixFmt: string): boolean {
  // pal8 can carry alpha (GIF); treat it as alpha so it is not silently flattened.
  return ALPHA_PIX.test(pixFmt);
}

export async function probe(ffprobe: string, file: string, signal?: AbortSignal): Promise<MediaInfo> {
  const r = await run(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', toLongPath(file)],
    { signal, timeoutMs: 60000 },
  );
  if (r.code !== 0) throw new Error(`ffprobe failed: ${lastLine(r.stderr) || 'exit ' + r.code}`);
  const data = JSON.parse(r.stdout || '{}');
  const streams: any[] = data.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = streams.find((s) => s.codec_type === 'audio');
  const duration = Number(v?.duration ?? data.format?.duration ?? 0) || 0;
  const [num, den] = String(v?.avg_frame_rate || v?.r_frame_rate || '0/1').split('/').map(Number);
  const fps = den ? num / den : 0;
  const fmtName = String(data.format?.format_name || '');
  const isStill = !!v && (/image2|png_pipe|jpeg_pipe|_pipe$/.test(fmtName) || Number(v.nb_frames) === 1);
  // Alpha in ProRes 4444 shows up only via pix_fmt; some codecs (qtrle, png in mov) report argb/rgba.
  const pixFmt = String(v?.pix_fmt || '');
  return {
    hasVideo: !!v,
    hasAudio: !!a,
    codec: String(v?.codec_name || ''),
    codecTag: String(v?.codec_tag_string || ''),
    width: Number(v?.width || 0),
    height: Number(v?.height || 0),
    pixFmt,
    duration,
    fps,
    hasAlpha: pixFmtHasAlpha(pixFmt),
    isStill,
  };
}

export interface ValidateExpect {
  codec: string;
  /** Accepted codec tags, e.g. DXD3 for DXT1 DXV3. Empty = do not check. */
  tags?: string[];
  multipleOf?: number;
  minDuration?: number;
}

/** Checks the encoded file: codec, tag, dimensions, and that frames at the start and middle decode. */
export async function validateOutput(inst: FfmpegInstall, file: string, expect: ValidateExpect, signal?: AbortSignal): Promise<MediaInfo> {
  const info = await probe(inst.ffprobe, file, signal);
  if (!info.hasVideo) throw new Error('Output has no video stream');
  if (info.codec !== expect.codec) throw new Error(`Output codec is ${info.codec || 'unknown'}, expected ${expect.codec}`);
  if (expect.tags?.length && !expect.tags.includes(info.codecTag)) throw new Error(`Output codec tag is ${info.codecTag}, expected ${expect.tags.join(' or ')}`);
  const m = expect.multipleOf ?? 1;
  if (!info.width || !info.height || info.width % m || info.height % m) throw new Error(`Output size ${info.width}x${info.height} is not a multiple of ${m}`);
  const decode = async (ss: number) => {
    const args = ['-v', 'error', '-xerror'];
    if (ss > 0) args.push('-ss', ss.toFixed(3));
    args.push('-i', toLongPath(file), '-map', '0:v:0', '-frames:v', '3', '-f', 'null', '-');
    const r = await run(inst.ffmpeg, args, { signal, timeoutMs: 120000 });
    if (r.code !== 0 || /error/i.test(r.stderr)) throw new Error(`Decode check failed at ${ss.toFixed(1)}s: ${lastLine(r.stderr) || 'exit ' + r.code}`);
  };
  await decode(0);
  if (info.duration > 2) await decode(info.duration / 2);
  return info;
}

export function lastLine(s: string): string {
  const lines = s.trim().split('\n').filter(Boolean);
  return lines[lines.length - 1] || '';
}
