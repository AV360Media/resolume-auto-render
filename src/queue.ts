import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

export type JobState =
  | 'queued'
  | 'waiting' // waiting for the file size to settle
  | 'probing'
  | 'encoding'
  | 'validating'
  | 'swapping'
  | 'done'
  | 'skipped'
  | 'failed'
  | 'cancelled';

export const FINAL_STATES: ReadonlySet<JobState> = new Set(['done', 'skipped', 'failed', 'cancelled']);

export interface ClipRef {
  id: number;
  layer: number;
  column: number;
  name: string;
}

export interface Job {
  id: string;
  source: string;
  origin: 'clip' | 'folder' | 'manual';
  clip?: ClipRef;
  state: JobState;
  progress: number;
  backend?: string;
  output?: string;
  error?: string;
  /** Things the user should know, e.g. "alpha dropped". */
  warnings: string[];
  /** Short status line for the UI. */
  detail?: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

export interface JobInput {
  source: string;
  origin: Job['origin'];
  clip?: ClipRef;
}

export interface JobContext {
  signal: AbortSignal;
  update(patch: Partial<Pick<Job, 'state' | 'progress' | 'backend' | 'output' | 'detail'>>): void;
  warn(msg: string): void;
}

/** Thrown by a runner to end a job as skipped rather than failed. */
export class SkipJob extends Error {}

export type JobRunner = (job: Readonly<Job>, ctx: JobContext) => Promise<void>;

const MAX_HISTORY = 300;

/**
 * FIFO job queue with a concurrency limit. Emits 'update' with a job snapshot on every change.
 * A failed job keeps its error and can be retried; it never blocks the rest of the queue.
 */
export class JobQueue extends EventEmitter {
  private jobs = new Map<string, Job>();
  private order: string[] = [];
  private running = new Map<string, AbortController>();
  private pumping = false;

  constructor(private runner: JobRunner, private concurrencyLimit = 2) {
    super();
  }

  get concurrency(): number {
    return this.concurrencyLimit;
  }

  setConcurrency(n: number): void {
    this.concurrencyLimit = Math.max(1, Math.floor(n));
    this.pump();
  }

  list(): Job[] {
    return this.order.map((id) => ({ ...this.jobs.get(id)!, warnings: [...this.jobs.get(id)!.warnings] }));
  }

  get(id: string): Job | undefined {
    const j = this.jobs.get(id);
    return j ? { ...j, warnings: [...j.warnings] } : undefined;
  }

  /** Active = not in a final state. */
  findActive(pred: (j: Job) => boolean): Job | undefined {
    for (const id of this.order) {
      const j = this.jobs.get(id)!;
      if (!FINAL_STATES.has(j.state) && pred(j)) return j;
    }
    return undefined;
  }

  add(input: JobInput): Job {
    const dup = this.findActive((j) => j.source === input.source && (j.clip?.id ?? null) === (input.clip?.id ?? null));
    if (dup) return { ...dup };
    const now = Date.now();
    const job: Job = {
      id: crypto.randomUUID(),
      source: input.source,
      origin: input.origin,
      clip: input.clip,
      state: 'queued',
      progress: 0,
      warnings: [],
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    this.order.push(job.id);
    this.trim();
    this.emitUpdate(job);
    this.pump();
    return { ...job };
  }

  retry(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j || !(j.state === 'failed' || j.state === 'cancelled' || j.state === 'skipped')) return false;
    Object.assign(j, { state: 'queued', progress: 0, error: undefined, detail: undefined, warnings: [], updatedAt: Date.now() });
    // Move to the end so it does not jump ahead of newer work.
    this.order = this.order.filter((x) => x !== id);
    this.order.push(id);
    this.emitUpdate(j);
    this.pump();
    return true;
  }

  cancel(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j || FINAL_STATES.has(j.state)) return false;
    const ctl = this.running.get(id);
    if (ctl) ctl.abort();
    else this.finish(j, 'cancelled');
    return true;
  }

  /** Remove finished jobs from the list. */
  clearFinished(): void {
    this.order = this.order.filter((id) => {
      const keep = !FINAL_STATES.has(this.jobs.get(id)!.state);
      if (!keep) this.jobs.delete(id);
      return keep;
    });
    this.emit('cleared');
  }

  /** Abort everything and wait for runners to stop. */
  async stop(): Promise<void> {
    for (const ctl of this.running.values()) ctl.abort();
    await this.idle();
  }

  /** Resolves when nothing is running or queued. */
  idle(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.running.size === 0 && !this.order.some((id) => this.jobs.get(id)!.state === 'queued')) {
          this.off('update', check);
          resolve();
        }
      };
      this.on('update', check);
      check();
    });
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.running.size < this.concurrencyLimit) {
        const next = this.order.map((id) => this.jobs.get(id)!).find((j) => j.state === 'queued');
        if (!next) break;
        this.start(next);
      }
    } finally {
      this.pumping = false;
    }
  }

  private start(job: Job): void {
    const ctl = new AbortController();
    this.running.set(job.id, ctl);
    job.attempts++;
    job.state = 'probing';
    job.updatedAt = Date.now();
    this.emitUpdate(job);
    const ctx: JobContext = {
      signal: ctl.signal,
      update: (patch) => {
        if (ctl.signal.aborted) return;
        Object.assign(job, patch);
        if (patch.progress !== undefined) job.progress = Math.max(0, Math.min(1, patch.progress));
        job.updatedAt = Date.now();
        this.emitUpdate(job);
      },
      warn: (msg) => {
        if (!job.warnings.includes(msg)) job.warnings.push(msg);
        job.updatedAt = Date.now();
        this.emitUpdate(job);
      },
    };
    Promise.resolve()
      .then(() => this.runner(job, ctx))
      .then(
        () => this.finish(job, ctl.signal.aborted ? 'cancelled' : 'done'),
        (err: unknown) => {
          if (ctl.signal.aborted) this.finish(job, 'cancelled');
          else if (err instanceof SkipJob) this.finish(job, 'skipped', err.message);
          else this.finish(job, 'failed', err instanceof Error ? err.message : String(err));
        },
      )
      .finally(() => {
        this.running.delete(job.id);
        this.pump();
        this.emitUpdate(job);
      });
  }

  private finish(job: Job, state: JobState, message?: string): void {
    job.state = state;
    if (state === 'done') job.progress = 1;
    if (state === 'failed') job.error = message;
    if (state === 'skipped') job.detail = message;
    if (state === 'cancelled') job.detail = 'Cancelled';
    job.updatedAt = Date.now();
    this.emitUpdate(job);
  }

  private trim(): void {
    while (this.order.length > MAX_HISTORY) {
      const idx = this.order.findIndex((id) => FINAL_STATES.has(this.jobs.get(id)!.state));
      if (idx < 0) break;
      this.jobs.delete(this.order[idx]);
      this.order.splice(idx, 1);
    }
  }

  private emitUpdate(job: Job): void {
    this.emit('update', { ...job, warnings: [...job.warnings] });
  }
}
