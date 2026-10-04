import type { MediaInfo, ValidateExpect, FfmpegInstall } from '../ffmpeg.js';
import type { Quality, Codec, Settings } from '../settings.js';

export interface Capabilities {
  available: boolean;
  /** Why it is unavailable, or a caveat when available. */
  reason?: string;
  codec: Codec;
  qualities: Quality[];
  alpha: boolean;
  /** Plain statements of limits, shown in the UI. */
  notes: string[];
}

export interface EncodeRequest {
  source: string;
  /** Write here. The pipeline validates it and renames it to the final path. */
  tempOutput: string;
  info: MediaInfo;
  quality: Quality;
  alpha: boolean;
}

export interface EncodeContext {
  signal: AbortSignal;
  /** 0..1, or -1 when progress is unknown. */
  onProgress(fraction: number): void;
  log(msg: string): void;
}

export interface Encoder {
  readonly id: string;
  readonly label: string;
  probe(): Promise<Capabilities>;
  encode(req: EncodeRequest, ctx: EncodeContext): Promise<void>;
  /** What the validator should check on this backend's output. */
  expect(req: EncodeRequest): ValidateExpect;
}

/** Shared environment the backends read on every call, so settings changes apply without a restart. */
export interface EncoderEnv {
  settings(): Settings;
  ffmpegInstalls(): FfmpegInstall[];
  platform: NodeJS.Platform;
}

/** DXV3 in QuickTime uses the DXD3 fourcc for all flavors; quality and alpha live in the bitstream. */
export const DXV_TAGS = ['DXD3', 'DXDI'];
