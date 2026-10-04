import { run, lastLine } from '../ffmpeg.js';
import { toLongPath } from '../paths.js';
import { progressParser } from './ffmpeg-dxv.js';
import type { Capabilities, EncodeContext, EncodeRequest, Encoder, EncoderEnv } from './types.js';

/** HAP is open and fully supported by ffmpeg. Resolume plays it natively. Not DXV. */
export class HapEncoder implements Encoder {
  readonly id = 'ffmpeg-hap';
  readonly label = 'FFmpeg HAP (not DXV)';

  constructor(private env: EncoderEnv) {}

  private install() {
    return this.env.ffmpegInstalls().find((i) => i.encoders.has('hap'));
  }

  async probe(): Promise<Capabilities> {
    const notes = [
      'Produces HAP, not DXV. Resolume plays HAP natively.',
      'Normal = HAP, High = HAP Q, alpha = HAP Alpha. HAP Q with alpha is not available in ffmpeg; alpha wins.',
      'Frame size is padded to a multiple of 4.',
    ];
    const inst = this.install();
    if (!inst) return { available: false, reason: 'No ffmpeg with the hap encoder (needs ffmpeg built with snappy).', codec: 'hap', qualities: ['normal', 'high'], alpha: true, notes };
    return { available: true, reason: `ffmpeg ${inst.version} (${inst.source})`, codec: 'hap', qualities: ['normal', 'high'], alpha: true, notes };
  }

  format(req: EncodeRequest): string {
    if (req.alpha) return 'hap_alpha';
    return req.quality === 'high' ? 'hap_q' : 'hap';
  }

  async encode(req: EncodeRequest, ctx: EncodeContext): Promise<void> {
    const inst = this.install();
    if (!inst) throw new Error('ffmpeg with hap encoder not found');
    if (req.alpha && req.quality === 'high') ctx.log('HAP Q has no alpha variant in ffmpeg; using HAP Alpha.');
    const pix = req.alpha ? 'rgba' : 'rgb0';
    const vf = `pad=ceil(iw/4)*4:ceil(ih/4)*4:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1,format=${pix}`;
    const args = ['-hide_banner', '-nostdin', '-y', '-i', toLongPath(req.source, this.env.platform), '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', vf, '-c:v', 'hap', '-format', this.format(req)];
    if (req.info.hasAudio) args.push('-c:a', 'pcm_s16le');
    args.push('-progress', 'pipe:1', '-nostats', '-f', 'mov', toLongPath(req.tempOutput, this.env.platform));
    const r = await run(inst.ffmpeg, args, { signal: ctx.signal, onStdoutLine: progressParser(req.info.duration, ctx.onProgress) });
    if (r.code !== 0) throw new Error(`ffmpeg exited with ${r.code}: ${lastLine(r.stderr)}`);
  }

  expect() {
    return { codec: 'hap', tags: ['Hap1', 'Hap5', 'HapY', 'HapM', 'HapA'], multipleOf: 4 };
  }
}
