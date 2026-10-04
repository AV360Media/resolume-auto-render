import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface CacheEntry {
  source: string;
  size: number;
  mtimeMs: number;
  output: string;
  backend: string;
  codec: string;
  quality: string;
  alpha: boolean;
  at: number;
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

/** Key = hash of path + size + mtime. A changed source file gets a new key and is converted again. */
export function cacheKey(source: string, size: number, mtimeMs: number): string {
  const norm = source.normalize('NFC');
  return crypto.createHash('sha1').update(`${norm}\0${size}\0${Math.round(mtimeMs)}`).digest('hex');
}

/**
 * JSON file database. Chosen over SQLite to avoid a native module in the packaged app.
 * Writes are atomic (temp file + rename) and coalesced.
 */
export class ConversionCache {
  private entries = new Map<string, CacheEntry>();
  private outputs = new Set<string>();
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(readonly file: string) {}

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8')) as CacheFile;
      if (data && data.version === 1 && data.entries) {
        for (const [k, v] of Object.entries(data.entries)) {
          this.entries.set(k, v);
          this.outputs.add(normOut(v.output));
        }
      }
    } catch {
      // Missing or corrupt: start empty. A corrupt file is replaced on next write.
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** Returns the entry if this exact file version was converted and the output still exists. */
  async lookup(source: string, size: number, mtimeMs: number): Promise<CacheEntry | undefined> {
    const e = this.entries.get(cacheKey(source, size, mtimeMs));
    if (!e) return undefined;
    try {
      await fs.access(e.output);
      return e;
    } catch {
      return undefined;
    }
  }

  /** True if the path is a file this app produced. */
  isOutput(file: string): boolean {
    return this.outputs.has(normOut(file));
  }

  async put(entry: CacheEntry): Promise<void> {
    this.entries.set(cacheKey(entry.source, entry.size, entry.mtimeMs), entry);
    this.outputs.add(normOut(entry.output));
    await this.flush();
  }

  async remove(source: string, size: number, mtimeMs: number): Promise<void> {
    const k = cacheKey(source, size, mtimeMs);
    const e = this.entries.get(k);
    if (e) {
      this.entries.delete(k);
      this.outputs.delete(normOut(e.output));
      await this.flush();
    }
  }

  async clear(): Promise<void> {
    this.entries.clear();
    this.outputs.clear();
    await this.flush();
  }

  flush(): Promise<void> {
    this.dirty = true;
    this.writing = this.writing.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      const data: CacheFile = { version: 1, entries: Object.fromEntries(this.entries) };
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data));
      await fs.rename(tmp, this.file);
    });
    return this.writing;
  }
}

function normOut(p: string): string {
  const n = p.normalize('NFC').replace(/\\/g, '/');
  return process.platform === 'linux' ? n : n.toLowerCase();
}
