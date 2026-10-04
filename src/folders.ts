import chokidar, { type FSWatcher } from 'chokidar';
import path from 'node:path';
import { isProbablyNetworkPath, mediaKind } from './paths.js';

const OWN_DIRS = new Set(['dxv', 'hap', 'originals']);

/** True for files this app writes or should never pick up: our output folders, temp and hidden files. */
export function ignoredInWatchFolder(file: string, root: string): boolean {
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith('..')) return false;
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => p.startsWith('.'))) return true;
  if (parts.slice(0, -1).some((p) => OWN_DIRS.has(p.toLowerCase()))) return true;
  return false;
}

/** Watches the configured folders for new video files. Existing files are left alone. */
export class FolderWatcher {
  private watchers: FSWatcher[] = [];
  private folders: string[] = [];

  constructor(private onFile: (file: string) => void, private onError: (msg: string) => void) {}

  get watching(): string[] {
    return [...this.folders];
  }

  async set(folders: string[], extraIgnored: string[] = []): Promise<void> {
    const want = [...new Set(folders.map((f) => path.resolve(f)))];
    if (want.join('\n') === this.folders.join('\n')) return;
    await this.close();
    this.folders = want;
    for (const root of want) {
      const w = chokidar.watch(root, {
        ignoreInitial: true,
        usePolling: isProbablyNetworkPath(root),
        interval: 2000,
        depth: 8,
        ignored: (p: string) => ignoredInWatchFolder(p, root) || extraIgnored.some((d) => p === d || p.startsWith(d + path.sep)),
      });
      w.on('add', (file: string) => {
        const k = mediaKind(file);
        if (k === 'video' || k === 'other') this.onFile(file);
      });
      w.on('error', (err: unknown) => this.onError(`Watch folder ${root}: ${err instanceof Error ? err.message : String(err)}`));
      this.watchers.push(w);
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.watchers.map((w) => w.close()));
    this.watchers = [];
    this.folders = [];
  }
}
