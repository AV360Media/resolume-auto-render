import { run, lastLine } from '../ffmpeg.js';
import { toLongPath } from '../paths.js';
import type { Capabilities, EncodeContext, EncodeRequest, Encoder, EncoderEnv } from './types.js';

/** Parses `-progress pipe:1` lines into a 0..1 fraction. */
export function progressParser(durationSec: number, onProgress: (f: number) => void) {
  return (line: string) => {
    const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
    if (m && durationSec > 0) onProgress(Math.min(0.999, Number(m[1]) / 1e6 / durationSec));
    else if (line === 'progress=end') onProgress(1);
  };
}

/** Video filter that makes ffmpeg's DXV encoder accept the frame. */
export function dxvFilter(fit: 'pad' | 'scale'): string {
  const size =
    fit === 'scale'
      ? 'scale=ceil(iw/16)*16:ceil(ih/16)*16:flags=lanczos'
      : 'pad=ceil(iw/16)*16:ceil(ih/16)*16:(ow-iw)/2:(oh-ih)/2:color=black';
  return `${size},setsar=1,format=rgba`;
}

export function needsResize(w: number, h: number): boolean {
  return w % 16 !== 0 || h % 16 !== 0;
}

export class FfmpegDxvEncoder implements Encoder {
  readonly id = 'ffmpeg-dxv';
  readonly label = 'FFmpeg DXV (built-in)';

  constructor(private env: EncoderEnv) {}

  private install() {
    return this.env.ffmpegInstalls().find((i) => i.encoders.has('dxv'));
  }

  async probe(): Promise<Capabilities> {
    const notes = [
      'DXV3 Normal Quality only (DXT1). No High Quality.',
      'No alpha. Transparent areas become black.',
      'Frame size is padded (or scaled) to a multiple of 16.',
    ];
    const inst = this.install();
    if (!inst) {
      const any = this.env.ffmpegInstalls()[0];
      return {
        available: false,
        reason: any ? `ffmpeg ${any.version} has no dxv encoder. Needs ffmpeg 7.0 or newer.` : 'ffmpeg not found.',
        codec: 'dxv', qualities: ['normal'], alpha: false, notes,
      };
    }
    return { available: true, reason: `ffmpeg ${inst.version} (${inst.source})`, codec: 'dxv', qualities: ['normal'], alpha: false, notes };
  }

  args(req: EncodeRequest): string[] {
    const fit = this.env.settings().dxvFit;
    const args = ['-hide_banner', '-nostdin', '-y', '-i', toLongPath(req.source, this.env.platform), '-map', '0:v:0', '-map', '0:a:0?'];
    args.push('-vf', dxvFilter(fit), '-c:v', 'dxv', '-format', 'dxt1');
    if (req.info.hasAudio) args.push('-c:a', 'pcm_s16le');
    args.push('-map_metadata', '0', '-progress', 'pipe:1', '-nostats', '-f', 'mov', toLongPath(req.tempOutput, this.env.platform));
    return args;
  }

  async encode(req: EncodeRequest, ctx: EncodeContext): Promise<void> {
    const inst = this.install();
    if (!inst) throw new Error('ffmpeg with dxv encoder not found');
    if (req.quality === 'high') throw new Error('FFmpeg DXV cannot encode High Quality');
    if (req.alpha) throw new Error('FFmpeg DXV cannot encode alpha');
    const r = await run(inst.ffmpeg, this.args(req), { signal: ctx.signal, onStdoutLine: progressParser(req.info.duration, ctx.onProgress) });
    if (r.code !== 0) throw new Error(`ffmpeg exited with ${r.code}: ${lastLine(r.stderr)}`);
  }

  expect() {
    return { codec: 'dxv', tags: ['DXD3'], multipleOf: 16 };
  }
}
