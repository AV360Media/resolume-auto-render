import path from 'node:path';

export type MediaKind = 'video' | 'image' | 'audio' | 'other';

const VIDEO_EXT = new Set([
  'mov', 'mp4', 'm4v', 'avi', 'mkv', 'webm', 'mpg', 'mpeg', 'm2v', 'mts', 'm2ts', 'ts', 'mxf', 'wmv', 'flv', 'gif', 'ogv', '3gp', 'dv', 'vob',
]);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff', 'tga', 'psd', 'exr', 'webp', 'heic', 'svg', 'dds']);
const AUDIO_EXT = new Set(['wav', 'mp3', 'aif', 'aiff', 'flac', 'ogg', 'm4a', 'aac', 'wma', 'opus']);

/** Classification by extension only. A .mov that is audio-only or already DXV is caught by ffprobe later. */
export function mediaKind(file: string): MediaKind {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (ext === 'gif') return 'video';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return 'other';
}

type Platform = NodeJS.Platform;

function pathApi(platform: Platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

export interface OutputOptions {
  outputFolder: string;
  codec: 'dxv' | 'hap';
}

/** Default: <original folder>/DXV/<name>.mov (HAP: <original folder>/HAP/<name>.mov). */
export function outputPathFor(src: string, opts: OutputOptions, platform: Platform = process.platform): string {
  const p = pathApi(platform);
  const sub = opts.codec === 'hap' ? 'HAP' : 'DXV';
  const dir = opts.outputFolder ? opts.outputFolder : p.join(p.dirname(src), sub);
  const base = p.basename(src, p.extname(src));
  return p.join(dir, `${base}.mov`);
}

/** "clip.mov" -> "clip (1).mov", "clip (2).mov", ... until exists() is false. */
export async function uniquePath(target: string, exists: (p: string) => Promise<boolean>, platform: Platform = process.platform): Promise<string> {
  if (!(await exists(target))) return target;
  const p = pathApi(platform);
  const dir = p.dirname(target);
  const ext = p.extname(target);
  const base = p.basename(target, ext);
  for (let i = 1; i < 10000; i++) {
    const candidate = p.join(dir, `${base} (${i})${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`No free file name for ${target}`);
}

/** Temp file in the same folder so the final rename is atomic. */
export function partialPathFor(target: string, platform: Platform = process.platform): string {
  const p = pathApi(platform);
  return p.join(p.dirname(target), `.${p.basename(target, '.mov')}.partial.mov`);
}

/**
 * The body Arena expects for /clips/.../open.
 * raw:     file:///C:/clips/my clip.mov   (what the Bitfocus Companion module sends; known to work)
 * encoded: file:///C:/clips/my%20clip.mov (RFC 8089; use if raw fails for unusual characters)
 */
export function toFileUri(file: string, style: 'raw' | 'encoded' = 'raw', platform: Platform = process.platform): string {
  let p = file;
  if (platform === 'win32') p = p.replace(/\\/g, '/');
  if (p.startsWith('//')) {
    // UNC path //server/share/x -> file://server/share/x
    const rest = p.slice(2);
    return 'file://' + (style === 'encoded' ? encodePath(rest) : rest);
  }
  p = p.replace(/^\/+/, '');
  return 'file:///' + (style === 'encoded' ? encodePath(p) : p);
}

function encodePath(p: string): string {
  return p
    .split('/')
    .map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join('/');
}

/** Normalize whatever Arena reports (plain path or file URI) to a native path. */
export function fromArenaPath(value: string | undefined | null, platform: Platform = process.platform): string {
  if (!value) return '';
  let p = String(value).trim();
  if (/^file:/i.test(p)) {
    p = p.replace(/^file:\/\//i, '');
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1); // /C:/x -> C:/x
    else if (!p.startsWith('/')) p = '//' + p; // server/share -> //server/share
    if (/%[0-9A-Fa-f]{2}/.test(p)) {
      try { p = decodeURIComponent(p); } catch { /* keep as is */ }
    }
  }
  if (platform === 'win32') p = p.replace(/\//g, '\\');
  return p.normalize('NFC');
}

/** Compare two paths the way the OS would. Windows and macOS are case-insensitive by default. */
export function samePath(a: string, b: string, platform: Platform = process.platform): boolean {
  if (!a || !b) return false;
  const norm = (s: string) => {
    let x = s.normalize('NFC');
    if (platform === 'win32') x = x.replace(/\//g, '\\').replace(/\\+$/, '');
    else x = x.replace(/\/+$/, '');
    if (platform === 'win32' || platform === 'darwin') x = x.toLowerCase();
    return x;
  };
  return norm(a) === norm(b);
}

/** Windows needs the \\?\ prefix for paths over 259 chars when passed to child processes. */
export function toLongPath(p: string, platform: Platform = process.platform): string {
  if (platform !== 'win32') return p;
  if (p.startsWith('\\\\?\\')) return p;
  const abs = path.win32.resolve(p);
  if (abs.length < 260) return p;
  if (abs.startsWith('\\\\')) return '\\\\?\\UNC\\' + abs.slice(2);
  return '\\\\?\\' + abs;
}

/** Network and removable locations get polling watchers and a longer stability window. */
export function isProbablyNetworkPath(p: string, platform: Platform = process.platform): boolean {
  if (platform === 'win32') return p.startsWith('\\\\') || p.startsWith('//');
  if (platform === 'darwin') return p.startsWith('/Volumes/');
  return p.startsWith('/mnt/') || p.startsWith('/media/') || p.startsWith('//');
}

/** True when file is inside dir (or equal). */
export function isInside(file: string, dir: string, platform: Platform = process.platform): boolean {
  const p = pathApi(platform);
  const rel = p.relative(dir, file);
  if (platform === 'win32' || platform === 'darwin') {
    const rel2 = p.relative(dir.toLowerCase(), file.toLowerCase());
    return rel2 === '' || (!rel2.startsWith('..') && !p.isAbsolute(rel2));
  }
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}

/** Ignore list entries: exact paths, or patterns with * (any run within a segment), ** (anything) and ?. */
export function matchesIgnore(file: string, patterns: string[], platform: Platform = process.platform): boolean {
  const ci = platform === 'win32' || platform === 'darwin';
  const f = (platform === 'win32' ? file.replace(/\\/g, '/') : file).normalize('NFC');
  for (const raw of patterns) {
    const pat = (platform === 'win32' ? raw.replace(/\\/g, '/') : raw).normalize('NFC');
    if (!/[*?]/.test(pat)) {
      if (samePath(file, raw, platform)) return true;
      continue;
    }
    let re = '';
    for (let i = 0; i < pat.length; i++) {
      const c = pat[i];
      if (c === '*' && pat[i + 1] === '*') { re += '.*'; i++; }
      else if (c === '*') re += '[^/]*';
      else if (c === '?') re += '[^/]';
      else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    // A pattern without a slash matches the file name anywhere.
    const full = pat.includes('/') ? `^${re}$` : `(^|/)${re}$`;
    if (new RegExp(full, ci ? 'i' : '').test(f)) return true;
  }
  return false;
}
