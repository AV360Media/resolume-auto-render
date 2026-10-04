/** Arena composition shapes we rely on. See docs/DISCOVERY.md for sources and confidence. */

export interface Param<T = unknown> {
  id?: number;
  valuetype?: string;
  value: T;
  [k: string]: unknown;
}

export interface ArenaClip {
  id: number;
  name?: Param<string>;
  connected?: Param<string>;
  video?: {
    fileinfo?: { path?: Param<string> | string; [k: string]: unknown } | null;
    width?: Param<number> | number;
    height?: Param<number> | number;
    effects?: unknown[];
    [k: string]: unknown;
  } | null;
  audio?: { fileinfo?: { path?: Param<string> | string } | null; [k: string]: unknown } | null;
  transport?: Record<string, unknown> | null;
  [k: string]: unknown;
}

export interface ArenaLayer {
  id: number;
  name?: Param<string>;
  clips?: ArenaClip[];
  [k: string]: unknown;
}

export interface ArenaComposition {
  name?: Param<string>;
  layers?: ArenaLayer[];
  columns?: unknown[];
  [k: string]: unknown;
}

export interface ArenaProduct {
  name: string;
  major: number;
  minor: number;
  micro: number;
  revision: number;
}

export interface ClipInfo {
  id: number;
  /** 1-based, as used in REST paths. */
  layer: number;
  column: number;
  name: string;
  /** Native path of the video file, '' when empty or a generator/source. */
  path: string;
}

export function paramValue<T>(p: Param<T> | T | undefined | null): T | undefined {
  if (p && typeof p === 'object' && 'value' in (p as object)) return (p as Param<T>).value;
  return (p as T) ?? undefined;
}

/** Video file path of a clip, falling back to the audio file path for audio-only clips. */
export function clipFilePath(clip: ArenaClip): { path: string; audioOnly: boolean } {
  const v = paramValue(clip.video?.fileinfo?.path as Param<string> | string | undefined);
  if (v) return { path: String(v), audioOnly: false };
  const a = paramValue(clip.audio?.fileinfo?.path as Param<string> | string | undefined);
  if (a) return { path: String(a), audioOnly: true };
  return { path: '', audioOnly: false };
}

/** Flattens the composition into clips with 1-based layer/column positions. */
export function flattenClips(comp: ArenaComposition, toNative: (p: string) => string = (p) => p): ClipInfo[] {
  const out: ClipInfo[] = [];
  (comp.layers || []).forEach((layer, li) => {
    (layer.clips || []).forEach((clip, ci) => {
      if (!clip || typeof clip.id !== 'number') return;
      const fp = clipFilePath(clip);
      out.push({
        id: clip.id,
        layer: li + 1,
        column: ci + 1,
        name: String(paramValue(clip.name) ?? ''),
        path: fp.audioOnly ? '' : toNative(fp.path),
      });
    });
  });
  return out;
}

/** Converts a param tree into a values-only patch, dropping ids so it can be PUT back after a reload. */
export function valuesOnly(node: unknown): unknown {
  if (Array.isArray(node)) return undefined;
  if (!node || typeof node !== 'object') return undefined;
  const o = node as Record<string, unknown>;
  if ('valuetype' in o && 'value' in o) return { value: o.value };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'id') continue;
    const sub = valuesOnly(v);
    if (sub !== undefined && !(typeof sub === 'object' && sub && !Object.keys(sub).length)) out[k] = sub;
  }
  return out;
}
