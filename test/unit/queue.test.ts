import { describe, it, expect } from 'vitest';
import { JobQueue, SkipJob, type Job } from '../../src/queue.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function deferredRunner() {
  const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  let active = 0;
  let maxActive = 0;
  const runner = (job: Readonly<Job>, ctx: any) =>
    new Promise<void>((resolve, reject) => {
      active++;
      maxActive = Math.max(maxActive, active);
      ctx.update({ state: 'encoding', progress: 0.5 });
      const done = () => { active--; };
      pending.set(job.source, { resolve: () => { done(); resolve(); }, reject: (e) => { done(); reject(e); } });
      ctx.signal.addEventListener('abort', () => { done(); reject(new Error('aborted')); });
    });
  return { runner, pending, stats: () => ({ active, maxActive }) };
}

describe('JobQueue', () => {
  it('respects concurrency and runs in order', async () => {
    const d = deferredRunner();
    const q = new JobQueue(d.runner, 2);
    for (const s of ['a', 'b', 'c', 'd']) q.add({ source: s, origin: 'manual' });
    await tick();
    expect(d.stats().active).toBe(2);
    expect([...d.pending.keys()]).toEqual(['a', 'b']);
    d.pending.get('a')!.resolve();
    await tick();
    expect([...d.pending.keys()]).toEqual(['a', 'b', 'c']);
    d.pending.get('b')!.resolve();
    d.pending.get('c')!.resolve();
    await tick();
    d.pending.get('d')!.resolve();
    await q.idle();
    expect(d.stats().maxActive).toBe(2);
    expect(q.list().map((j) => j.state)).toEqual(['done', 'done', 'done', 'done']);
    expect(q.list().every((j) => j.progress === 1)).toBe(true);
  });

  it('dedupes active jobs for the same source and clip', () => {
    const d = deferredRunner();
    const q = new JobQueue(d.runner, 1);
    const a = q.add({ source: 'x', origin: 'clip', clip: { id: 1, layer: 1, column: 1, name: '' } });
    const b = q.add({ source: 'x', origin: 'clip', clip: { id: 1, layer: 1, column: 1, name: '' } });
    const c = q.add({ source: 'x', origin: 'clip', clip: { id: 2, layer: 1, column: 2, name: '' } });
    expect(b.id).toBe(a.id);
    expect(c.id).not.toBe(a.id);
  });

  it('marks failures, keeps going, and retries', async () => {
    const d = deferredRunner();
    const q = new JobQueue(d.runner, 1);
    const a = q.add({ source: 'a', origin: 'manual' });
    q.add({ source: 'b', origin: 'manual' });
    await tick();
    d.pending.get('a')!.reject(new Error('encode broke'));
    await tick();
    expect(q.get(a.id)!.state).toBe('failed');
    expect(q.get(a.id)!.error).toBe('encode broke');
    expect(d.pending.has('b')).toBe(true);
    d.pending.get('b')!.resolve();
    await tick();
    expect(q.retry(a.id)).toBe(true);
    await tick();
    expect(q.get(a.id)!.attempts).toBe(2);
    d.pending.get('a')!.resolve();
    await q.idle();
    expect(q.get(a.id)!.state).toBe('done');
    expect(q.get(a.id)!.error).toBeUndefined();
  });

  it('SkipJob ends as skipped with the reason', async () => {
    const q = new JobQueue(async () => { throw new SkipJob('Already DXV'); }, 1);
    const j = q.add({ source: 'a', origin: 'manual' });
    await q.idle();
    expect(q.get(j.id)!.state).toBe('skipped');
    expect(q.get(j.id)!.detail).toBe('Already DXV');
  });

  it('cancels queued and running jobs', async () => {
    const d = deferredRunner();
    const q = new JobQueue(d.runner, 1);
    const a = q.add({ source: 'a', origin: 'manual' });
    const b = q.add({ source: 'b', origin: 'manual' });
    await tick();
    expect(q.cancel(b.id)).toBe(true);
    expect(q.get(b.id)!.state).toBe('cancelled');
    expect(q.cancel(a.id)).toBe(true);
    await q.idle();
    expect(q.get(a.id)!.state).toBe('cancelled');
    expect(q.cancel(a.id)).toBe(false);
  });

  it('clamps progress and emits updates', async () => {
    const updates: number[] = [];
    const q = new JobQueue(async (_j, ctx) => { ctx.update({ progress: 5 }); ctx.warn('w'); ctx.warn('w'); }, 1);
    q.on('update', (j: Job) => updates.push(j.progress));
    const j = q.add({ source: 'a', origin: 'manual' });
    await q.idle();
    expect(Math.max(...updates)).toBe(1);
    expect(q.get(j.id)!.warnings).toEqual(['w']);
  });

  it('raising concurrency starts waiting jobs', async () => {
    const d = deferredRunner();
    const q = new JobQueue(d.runner, 1);
    for (const s of ['a', 'b', 'c']) q.add({ source: s, origin: 'manual' });
    await tick();
    expect(d.stats().active).toBe(1);
    q.setConcurrency(3);
    await tick();
    expect(d.stats().active).toBe(3);
    await q.stop();
  });

  it('clearFinished drops only finished jobs', async () => {
    const d = deferredRunner();
    const q = new JobQueue(d.runner, 1);
    q.add({ source: 'a', origin: 'manual' });
    q.add({ source: 'b', origin: 'manual' });
    await tick();
    d.pending.get('a')!.resolve();
    await tick();
    q.clearFinished();
    expect(q.list().map((j) => j.source)).toEqual(['b']);
    await q.stop();
  });
});
