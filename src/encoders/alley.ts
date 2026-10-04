import { promises as fs } from 'node:fs';
import path from 'node:path';
import { run, lastLine } from '../ffmpeg.js';
import type { Capabilities, EncodeContext, EncodeRequest, Encoder, EncoderEnv } from './types.js';
import { DXV_TAGS } from './types.js';

/** Known install locations. Used only to report what is installed; nothing here is launched. */
export async function findAlley(platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const candidates: string[] = [];
  if (platform === 'darwin') {
    try {
      for (const name of await fs.readdir('/Applications')) {
        if (/alley/i.test(name) && name.endsWith('.app')) candidates.push(path.join('/Applications', name));
        if (/^Resolume/i.test(name) && !name.endsWith('.app')) {
          for (const sub of await fs.readdir(path.join('/Applications', name)).catch(() => [] as string[])) {
            if (/alley/i.test(sub)) candidates.push(path.join('/Applications', name, sub));
          }
        }
      }
    } catch { /* ignore */ }
  } else if (platform === 'win32') {
    const pf = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']].filter(Boolean) as string[];
    for (const base of pf) {
      for (const dir of ['Resolume Alley', 'Resolume\\Alley', 'Resolume Arena\\Alley']) candidates.push(path.join(base, dir));
    }
  }
  for (const c of candidates) {
    try {
      await fs.access(c);
      return c;
    } catch { /* next */ }
  }
  return null;
}

/** Splits a command template into argv without a shell. Supports "double" and 'single' quotes. */
export function splitCommand(template: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (const ch of template) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

export function fillTemplate(argv: string[], vars: Record<string, string>): string[] {
  return argv.map((a) => a.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)));
}

/**
 * Alley CLI backend. Alley has no documented command line (see docs/DISCOVERY.md).
 * This stays unavailable unless the user enters a command template, e.g. for a future Alley CLI
 * or their own wrapper script: `/path/to/alley-cli --in {input} --out {output} --quality {quality} --alpha {alpha}`.
 */
export class AlleyCliEncoder implements Encoder {
  readonly id = 'alley-cli';
  readonly label = 'Alley CLI';

  constructor(private env: EncoderEnv) {}

  async probe(): Promise<Capabilities> {
    const notes = ['Alley has no documented command line. Enabled only when you enter a command template in settings.'];
    const tpl = this.env.settings().alleyCliCommand;
    if (!tpl) {
      const installed = await findAlley(this.env.platform);
      return {
        available: false,
        reason: installed ? `Alley found at ${installed}, but it has no command line. Set a command template to use a CLI.` : 'No Alley CLI configured.',
        codec: 'dxv', qualities: ['normal', 'high'], alpha: true, notes,
      };
    }
    const argv = splitCommand(tpl);
    try {
      await fs.access(argv[0]);
    } catch {
      return { available: false, reason: `Command not found: ${argv[0]}`, codec: 'dxv', qualities: ['normal', 'high'], alpha: true, notes };
    }
    return { available: true, reason: 'Command template configured', codec: 'dxv', qualities: ['normal', 'high'], alpha: true, notes };
  }

  async encode(req: EncodeRequest, ctx: EncodeContext): Promise<void> {
    const argv = fillTemplate(splitCommand(this.env.settings().alleyCliCommand), {
      input: req.source,
      output: req.tempOutput,
      quality: req.quality,
      alpha: req.alpha ? 'on' : 'off',
    });
    ctx.onProgress(-1);
    const r = await run(argv[0], argv.slice(1), { signal: ctx.signal });
    if (r.code !== 0) throw new Error(`Alley CLI exited with ${r.code}: ${lastLine(r.stderr)}`);
  }

  expect() {
    return { codec: 'dxv', tags: DXV_TAGS, multipleOf: 1 };
  }
}

/**
 * Alley GUI automation was evaluated and not built. It is listed so the UI can say why.
 * Driving Alley with AppleScript/System Events or UI Automation would steal keyboard focus and
 * bring windows to the front during a live show, depends on Alley's window layout (which changes
 * between versions), and has no reliable completion signal other than polling the output folder.
 */
export class AlleyAutomationEncoder implements Encoder {
  readonly id = 'alley-automation';
  readonly label = 'Alley GUI automation';

  async probe(): Promise<Capabilities> {
    return {
      available: false,
      reason: 'Not built: GUI automation steals focus from Arena during a show and breaks when Alley’s UI changes.',
      codec: 'dxv',
      qualities: ['normal', 'high'],
      alpha: true,
      notes: ['See docs/DECISIONS.md.'],
    };
  }

  async encode(): Promise<void> {
    throw new Error('Alley GUI automation is not implemented');
  }

  expect() {
    return { codec: 'dxv', tags: DXV_TAGS };
  }
}
