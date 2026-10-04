import { EventEmitter } from 'node:events';
import { flattenClips, type ArenaComposition, type ClipInfo } from './model.js';
import { samePath } from '../paths.js';

export interface MediaChange {
  clip: ClipInfo;
  previousPath: string;
}

/**
 * Diffs composition snapshots and reports clips whose video file changed.
 * The first snapshot after (re)connecting is the baseline: clips already loaded are not reported
 * unless reportExisting is set. Arena assigns new clip ids after a restart, so baselines reset then.
 */
export class ClipTracker extends EventEmitter {
  private clips = new Map<number, ClipInfo>();
  private hasBaseline = false;

  constructor(
    private toNative: (p: string) => string,
    private reportExisting: () => boolean = () => false,
    private platform: NodeJS.Platform = process.platform,
  ) {
    super();
  }

  reset(): void {
    this.clips.clear();
    this.hasBaseline = false;
  }

  get(id: number): ClipInfo | undefined {
    return this.clips.get(id);
  }

  all(): ClipInfo[] {
    return [...this.clips.values()];
  }

  /** Returns the changes it emitted as 'media-changed'. */
  update(comp: ArenaComposition): MediaChange[] {
    const next = flattenClips(comp, this.toNative);
    const changes: MediaChange[] = [];
    // No clip id survived: Arena restarted or another composition was opened. Treat as a new baseline.
    const replaced = this.clips.size > 0 && next.length > 0 && !next.some((c) => this.clips.has(c.id));
    const first = !this.hasBaseline || replaced;
    const nextMap = new Map<number, ClipInfo>();
    for (const c of next) {
      nextMap.set(c.id, c);
      if (!c.path) continue;
      const prev = this.clips.get(c.id);
      if (first) {
        if (this.reportExisting()) changes.push({ clip: c, previousPath: '' });
      } else if (!prev || !samePath(prev.path, c.path, this.platform)) {
        changes.push({ clip: c, previousPath: prev?.path || '' });
      }
    }
    this.clips = nextMap;
    this.hasBaseline = true;
    for (const ch of changes) this.emit('media-changed', ch);
    return changes;
  }
}
