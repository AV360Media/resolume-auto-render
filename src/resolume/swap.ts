import { ArenaHttpError, type ArenaRest } from './rest.js';
import { clipFilePath, flattenClips, paramValue, valuesOnly, type ArenaClip } from './model.js';
import { fromArenaPath, samePath, toFileUri } from '../paths.js';
import type { ClipRef } from '../queue.js';

export class ClipChangedError extends Error {}

export interface SwapOptions {
  uriStyle: 'raw' | 'encoded';
  restoreProps: boolean;
  platform?: NodeJS.Platform;
  /** How long to wait for Arena to report the new file. */
  verifyTimeoutMs?: number;
  log?: (msg: string) => void;
}

export interface SwapResult {
  restored: string[];
  notRestored: string[];
  /** Where the clip was found (it may have moved since the job started). */
  layer: number;
  column: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Loads `output` into the clip that held `source`.
 * - Refuses if the clip now holds a different file (ClipChangedError).
 * - Uses the by-id endpoint, falling back to layer/column after confirming the id at that position.
 * - Waits until Arena reports the new path, then restores name and transport controls.
 * - If Arena does not report the new file, re-opens the original so the clip keeps working.
 */
export async function swapClipFile(rest: ArenaRest, clipRef: ClipRef, source: string, output: string, opts: SwapOptions): Promise<SwapResult> {
  const platform = opts.platform ?? process.platform;
  const log = opts.log ?? (() => {});
  const native = (p: string) => fromArenaPath(p, platform);

  const located = await locateClip(rest, clipRef);
  if (!located) throw new ClipChangedError('Clip was removed from the composition. Left it alone.');
  const { clip, layer, column, byId } = located;
  const current = native(clipFilePath(clip).path);
  if (samePath(current, output, platform)) return { restored: [], notRestored: [], layer, column };
  if (!samePath(current, source, platform)) {
    throw new ClipChangedError(`Clip now holds a different file (${current || 'empty'}). Left it alone.`);
  }

  const before = { name: paramValue(clip.name), transport: clip.transport ? valuesOnly(clip.transport) : undefined };
  const open = async (file: string) => {
    const uri = toFileUri(file, opts.uriStyle, platform);
    if (byId) {
      try {
        await rest.openById(clipRef.id, uri);
        return;
      } catch (e) {
        if (!(e instanceof ArenaHttpError && (e.status === 404 || e.status === 405))) throw e;
        log('by-id open not supported by this Arena; using layer/column');
      }
    }
    await rest.openAt(layer, column, uri);
  };

  await open(output);
  const ok = await waitForPath(rest, clipRef.id, layer, column, output, platform, opts.verifyTimeoutMs ?? 10000);
  if (!ok) {
    log('Arena did not report the new file; restoring the original');
    await open(source).catch(() => {});
    throw new Error('Arena did not load the converted file. Original restored.');
  }

  const restored: string[] = [];
  const notRestored: string[] = [];
  if (opts.restoreProps) {
    const after = await getClip(rest, clipRef.id, layer, column);
    const patch: Record<string, unknown> = {};
    if (before.name !== undefined && paramValue(after?.name) !== before.name) patch.name = { value: before.name };
    if (before.transport && typeof before.transport === 'object') {
      const t = before.transport as Record<string, unknown>;
      // Position is tied to the old file's timeline; restoring it would jump the playhead.
      const { position: _ignored, ...rest } = t;
      if (Object.keys(rest).length) patch.transport = rest;
    }
    if (Object.keys(patch).length) {
      try {
        await rest.updateClipById(clipRef.id, patch).catch(async (e) => {
          if (e instanceof ArenaHttpError && (e.status === 404 || e.status === 405)) return rest.updateClipAt(layer, column, patch);
          throw e;
        });
        restored.push(...Object.keys(patch));
      } catch (e) {
        notRestored.push(...Object.keys(patch));
        log(`Could not restore ${Object.keys(patch).join(', ')}: ${(e as Error).message}`);
      }
    }
  }
  return { restored, notRestored, layer, column };
}

async function getClip(rest: ArenaRest, id: number, layer: number, column: number): Promise<ArenaClip | null> {
  try {
    return await rest.clipById(id);
  } catch {
    try {
      const c = await rest.clipAt(layer, column);
      return c && c.id === id ? c : null;
    } catch {
      return null;
    }
  }
}

async function locateClip(rest: ArenaRest, ref: ClipRef): Promise<{ clip: ArenaClip; layer: number; column: number; byId: boolean } | null> {
  try {
    const clip = await rest.clipById(ref.id);
    if (clip && clip.id === ref.id) {
      const pos = await findPosition(rest, ref.id).catch(() => null);
      return { clip, layer: pos?.layer ?? ref.layer, column: pos?.column ?? ref.column, byId: true };
    }
  } catch (e) {
    if (!(e instanceof ArenaHttpError)) throw e;
  }
  // by-id unsupported or clip gone: search the composition.
  const pos = await findPosition(rest, ref.id);
  if (!pos) return null;
  const clip = await rest.clipAt(pos.layer, pos.column);
  if (!clip || clip.id !== ref.id) return null;
  return { clip, layer: pos.layer, column: pos.column, byId: false };
}

async function findPosition(rest: ArenaRest, id: number): Promise<{ layer: number; column: number } | null> {
  const comp = await rest.composition();
  const hit = flattenClips(comp).find((c) => c.id === id);
  return hit ? { layer: hit.layer, column: hit.column } : null;
}

async function waitForPath(rest: ArenaRest, id: number, layer: number, column: number, expected: string, platform: NodeJS.Platform, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const c = await getClip(rest, id, layer, column);
    if (c && samePath(fromArenaPath(clipFilePath(c).path, platform), expected, platform)) return true;
    await sleep(250);
  }
  return false;
}

/** True when Arena reports the clip as playing on its layer. Option names come from the clip's `connected` choice param. */
export function isLive(clip: ArenaClip | null | undefined): boolean {
  const v = String(paramValue(clip?.connected) ?? '');
  return /^connected/i.test(v);
}

/**
 * Waits while the clip is playing, so the swap does not cause a visible reload on stage.
 * Resolves when the clip is not live or no longer found (the swap then decides what to do).
 */
export async function waitUntilNotLive(rest: ArenaRest, ref: ClipRef, signal: AbortSignal, onWait: () => void, pollMs = 1000): Promise<void> {
  let told = false;
  for (;;) {
    if (signal.aborted) throw new Error('aborted');
    const pos = await locateClip(rest, ref).catch(() => null);
    if (!pos || !isLive(pos.clip)) return;
    if (!told) {
      onWait();
      told = true;
    }
    await sleep(pollMs);
  }
}
