import { describe, it, expect, afterEach } from 'vitest';
import { MockArena, type MockOptions } from '../mock/mock-arena.js';
import { ArenaConnection } from '../../src/resolume/connection.js';
import { ArenaRest } from '../../src/resolume/rest.js';
import { ClipTracker, type MediaChange } from '../../src/resolume/tracker.js';
import { swapClipFile, ClipChangedError } from '../../src/resolume/swap.js';
import { flattenClips, valuesOnly } from '../../src/resolume/model.js';
import { fromArenaPath } from '../../src/paths.js';

const plat = 'linux' as const;
let arena: MockArena | null = null;
let conn: ArenaConnection | null = null;

afterEach(async () => {
  conn?.stop();
  conn = null;
  await arena?.stop().catch(() => {});
  arena = null;
});

async function setup(opts: MockOptions = {}, pollIntervalMs = 0) {
  arena = new MockArena(opts);
  const port = await arena.start();
  conn = new ArenaConnection({ host: () => '127.0.0.1', port: () => port, pollIntervalMs: () => pollIntervalMs, maxBackoffMs: 200 });
  const tracker = new ClipTracker((p) => fromArenaPath(p, plat), () => false, plat);
  const changes: MediaChange[] = [];
  conn.on('connected', () => tracker.reset());
  conn.on('disconnected', () => tracker.reset());
  conn.on('session-reset', () => tracker.reset());
  conn.on('composition', (c) => tracker.update(c));
  tracker.on('media-changed', (c: MediaChange) => changes.push(c));
  return { port, tracker, changes, rest: new ArenaRest(() => `http://127.0.0.1:${port}/api/v1`) };
}

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('ArenaRest against mock Arena', () => {
  it('reads product, composition and clips', async () => {
    const { rest } = await setup();
    expect((await rest.product()).name).toBe('Arena');
    const comp = await rest.composition();
    expect(comp.layers?.length).toBe(2);
    const first = comp.layers![0].clips![0];
    expect((await rest.clipById(first.id)).id).toBe(first.id);
    expect((await rest.clipAt(1, 1)).id).toBe(first.id);
  });
});

describe('ArenaConnection + ClipTracker', () => {
  it('detects a file loaded into a clip via WebSocket push', async () => {
    const { changes } = await setup();
    conn!.start();
    await waitFor(() => conn!.getStatus().state === 'connected' && conn!.getStatus().websocket);
    await new Promise((r) => setTimeout(r, 50));
    arena!.userLoad(2, 3, '/clips/my clip ü.mp4');
    await waitFor(() => changes.length === 1);
    expect(changes[0].clip).toMatchObject({ layer: 2, column: 3, path: '/clips/my clip ü.mp4', name: 'my clip ü' });
  });

  it('detects loads by polling when Arena does not push', async () => {
    const { changes } = await setup({ pushOnOpen: false }, 100);
    conn!.start();
    await waitFor(() => conn!.getStatus().state === 'connected');
    await new Promise((r) => setTimeout(r, 150));
    // Simulate a change Arena does not broadcast.
    const clip = arena!.clipAt(1, 2)!;
    clip.video = { fileinfo: { path: { valuetype: 'ParamString', value: '/x/silent.mov' } } };
    await waitFor(() => changes.length === 1);
    expect(changes[0].clip.path).toBe('/x/silent.mov');
  });

  it('does not report clips that were already loaded at connect', async () => {
    const { changes, tracker } = await setup();
    arena!.userLoad(1, 1, '/pre/existing.mov');
    conn!.start();
    await waitFor(() => tracker.all().length > 0);
    await new Promise((r) => setTimeout(r, 100));
    expect(changes).toEqual([]);
  });

  it('reconnects after an Arena restart and re-baselines new clip ids', async () => {
    const { changes, tracker } = await setup();
    conn!.start();
    await waitFor(() => conn!.getStatus().websocket);
    arena!.userLoad(1, 1, '/a.mov');
    await waitFor(() => changes.length === 1);
    const oldId = changes[0].clip.id;
    let reset = false;
    conn!.on('session-reset', () => (reset = true));
    await arena!.restart();
    await waitFor(() => reset && conn!.getStatus().state === 'connected' && conn!.getStatus().websocket, 8000);
    await waitFor(() => tracker.all().length > 0);
    // Same file, new id after restart: baseline, not a change.
    expect(changes.length).toBe(1);
    expect(tracker.all().find((c) => c.path === '/a.mov')!.id).not.toBe(oldId);
    arena!.userLoad(1, 2, '/b.mov');
    await waitFor(() => changes.length === 2);
  });

  it('treats a snapshot with no surviving clip ids as a new baseline', () => {
    const t = new ClipTracker((p) => p, () => false, plat);
    const seen: MediaChange[] = [];
    t.on('media-changed', (c: MediaChange) => seen.push(c));
    const comp = (ids: number[], p: string) => ({ layers: [{ id: 1, clips: ids.map((id) => ({ id, video: { fileinfo: { path: p } } })) }] });
    t.update(comp([1, 2], '/a.mov'));
    t.update(comp([3, 4], '/b.mov'));
    expect(seen).toEqual([]);
    t.update(comp([3, 4, 5], '/b.mov'));
    expect(seen.map((c) => c.clip.id)).toEqual([5]);
  });

  it('reports file URIs as native paths', async () => {
    const { changes } = await setup({ reportAs: 'uri' });
    conn!.start();
    await waitFor(() => conn!.getStatus().websocket);
    await new Promise((r) => setTimeout(r, 50));
    arena!.userLoad(1, 1, '/clips/with space.mov');
    await waitFor(() => changes.length === 1);
    expect(changes[0].clip.path).toBe('/clips/with space.mov');
  });

  it('reports disconnected when Arena is not running', async () => {
    arena = new MockArena();
    const port = await arena.start();
    await arena.stop();
    conn = new ArenaConnection({ host: () => '127.0.0.1', port: () => port, pollIntervalMs: () => 0, maxBackoffMs: 100 });
    conn.start();
    await waitFor(() => !!conn!.getStatus().lastError);
    expect(conn.getStatus().state).not.toBe('connected');
    arena = null;
  });
});

describe('swapClipFile', () => {
  it('loads the output into the same clip and restores name and transport', async () => {
    const { rest } = await setup();
    const clip = arena!.userLoad(1, 2, '/clips/src.mp4', 'Intro Loop');
    clip.transport.controls.speed.value = 2.5;
    clip.transport.controls.playmode.value = 'Bounce';
    const r = await swapClipFile(rest, { id: clip.id, layer: 1, column: 2, name: 'Intro Loop' }, '/clips/src.mp4', '/clips/DXV/src.mov', { uriStyle: 'raw', restoreProps: true, platform: plat });
    const after = arena!.clipById(clip.id)!;
    expect(arena!.pathOf(after)).toBe('/clips/DXV/src.mov');
    expect(after.name.value).toBe('Intro Loop');
    expect(after.transport.controls.speed.value).toBe(2.5);
    expect(after.transport.controls.playmode.value).toBe('Bounce');
    expect(r.restored.sort()).toEqual(['name', 'transport']);
    const open = arena!.requests.find((q) => q.url.endsWith('/open'))!;
    expect(open.url).toBe(`/api/v1/composition/clips/by-id/${clip.id}/open`);
    expect(open.body).toBe('file:///clips/DXV/src.mov');
  });

  it('refuses when the clip now holds a different file', async () => {
    const { rest } = await setup();
    const clip = arena!.userLoad(1, 1, '/clips/a.mp4');
    arena!.userLoad(1, 1, '/clips/other.mp4');
    await expect(
      swapClipFile(rest, { id: clip.id, layer: 1, column: 1, name: '' }, '/clips/a.mp4', '/clips/DXV/a.mov', { uriStyle: 'raw', restoreProps: true, platform: plat }),
    ).rejects.toBeInstanceOf(ClipChangedError);
    expect(arena!.pathOf(arena!.clipById(clip.id)!)).toBe('/clips/other.mp4');
    expect(arena!.requests.some((q) => q.url.endsWith('/open'))).toBe(false);
  });

  it('refuses when the clip was removed', async () => {
    const { rest } = await setup();
    await expect(
      swapClipFile(rest, { id: 999999, layer: 1, column: 1, name: '' }, '/a.mp4', '/DXV/a.mov', { uriStyle: 'raw', restoreProps: false, platform: plat }),
    ).rejects.toBeInstanceOf(ClipChangedError);
  });

  it('follows a clip that moved and falls back to layer/column without by-id', async () => {
    const { rest } = await setup({ byId: false });
    const clip = arena!.userLoad(1, 1, '/clips/m.mp4');
    // Move clip to layer 2 column 3.
    const l0 = arena!.layers[0].clips;
    const l1 = arena!.layers[1].clips;
    [l0[0], l1[2]] = [l1[2], l0[0]];
    const r = await swapClipFile(rest, { id: clip.id, layer: 1, column: 1, name: '' }, '/clips/m.mp4', '/clips/DXV/m.mov', { uriStyle: 'encoded', restoreProps: true, platform: plat });
    expect(r).toMatchObject({ layer: 2, column: 3 });
    expect(arena!.pathOf(arena!.clipAt(2, 3)!)).toBe('/clips/DXV/m.mov');
    expect(arena!.requests.some((q) => q.url === '/api/v1/composition/layers/2/clips/3/open')).toBe(true);
  });

  it('is a no-op when the clip already holds the output', async () => {
    const { rest } = await setup();
    const clip = arena!.userLoad(1, 1, '/clips/DXV/done.mov');
    await swapClipFile(rest, { id: clip.id, layer: 1, column: 1, name: '' }, '/clips/done.mp4', '/clips/DXV/done.mov', { uriStyle: 'raw', restoreProps: true, platform: plat });
    expect(arena!.requests.some((q) => q.url.endsWith('/open'))).toBe(false);
  });
});

describe('model helpers', () => {
  it('flattens clips with 1-based positions and skips audio-only paths', () => {
    const comp = {
      layers: [
        { id: 1, clips: [{ id: 10, name: { value: 'a' }, video: { fileinfo: { path: { value: '/v.mov' } } } }, { id: 11, audio: { fileinfo: { path: '/s.wav' } } }] },
        { id: 2, clips: [{ id: 20, video: { fileinfo: { path: '/plain.mov' } } }] },
      ],
    };
    expect(flattenClips(comp as any)).toEqual([
      { id: 10, layer: 1, column: 1, name: 'a', path: '/v.mov' },
      { id: 11, layer: 1, column: 2, name: '', path: '' },
      { id: 20, layer: 2, column: 1, name: '', path: '/plain.mov' },
    ]);
  });
  it('valuesOnly strips ids and keeps values', () => {
    expect(valuesOnly({ id: 1, controls: { speed: { id: 2, valuetype: 'ParamRange', value: 2, min: 0 }, list: [1] } })).toEqual({ controls: { speed: { value: 2 } } });
  });
});
