import { promises as fs } from 'node:fs';
import path from 'node:path';
import { waitForStableFile } from '../stability.js';
import type { Capabilities, EncodeContext, EncodeRequest, Encoder, EncoderEnv } from './types.js';
import { DXV_TAGS } from './types.js';

export async function findAme(platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const roots = platform === 'darwin'
    ? ['/Applications']
    : platform === 'win32'
      ? [path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Adobe')]
      : [];
  for (const root of roots) {
    try {
      const hit = (await fs.readdir(root)).filter((n) => /^Adobe Media Encoder/i.test(n)).sort().pop();
      if (hit) return path.join(root, hit);
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Adobe Media Encoder via its own watch-folder feature. Optional.
 * Setup (once, in AME): add a watch folder, apply a DXV3 preset from Resolume's AME plugin, set the output folder, start the queue.
 * This backend copies the source into that watch folder and waits for AME's output.
 * The output flavor (Normal/High, alpha) is whatever preset you applied in AME.
 */
export class AmeEncoder implements Encoder {
  readonly id = 'ame';
  readonly label = 'Adobe Media Encoder (watch folder)';

  constructor(private env: EncoderEnv, private timeoutMs = 4 * 60 * 60 * 1000) {}

  async probe(): Promise<Capabilities> {
    const s = this.env.settings();
    const notes = [
      'Needs AME with Resolume’s DXV3 export plugin and a watch folder set up in AME.',
      'Quality and alpha come from the AME preset, not from this app.',
      'AME must be running with its watch-folder queue started.',
    ];
    const base = { codec: 'dxv' as const, qualities: ['normal' as const, 'high' as const], alpha: true, notes };
    if (!s.ameWatchFolder || !s.ameOutputFolder) {
      const ame = await findAme(this.env.platform);
      return { ...base, available: false, reason: ame ? `AME found at ${ame}. Set its watch and output folders in settings to use it.` : 'AME not configured.' };
    }
    for (const d of [s.ameWatchFolder, s.ameOutputFolder]) {
      try {
        if (!(await fs.stat(d)).isDirectory()) throw new Error();
      } catch {
        return { ...base, available: false, reason: `Folder not found: ${d}` };
      }
    }
    return { ...base, available: true, reason: 'Watch folder configured' };
  }

  async encode(req: EncodeRequest, ctx: EncodeContext): Promise<void> {
    const s = this.env.settings();
    const stem = `rar-${Date.now().toString(36)}-${path.basename(req.source, path.extname(req.source))}`;
    const dropped = path.join(s.ameWatchFolder, stem + path.extname(req.source));
    const expected = path.join(s.ameOutputFolder, stem + '.mov');
    ctx.onProgress(-1);
    ctx.log(`Copying to AME watch folder: ${dropped}`);
    await fs.copyFile(req.source, dropped);
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      if (ctx.signal.aborted) throw new Error('aborted');
      if (Date.now() > deadline) throw new Error('Timed out waiting for Adobe Media Encoder');
      try {
        await fs.access(expected);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    await waitForStableFile(expected, { stableMs: 5000, signal: ctx.signal });
    await fs.copyFile(expected, req.tempOutput);
    await fs.rm(expected, { force: true });
  }

  expect() {
    return { codec: 'dxv', tags: DXV_TAGS };
  }
}
