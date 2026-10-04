// Minimal git helpers for promote/rollback. Spawns git directly (no shell).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function git(args, { allowFail = false, raw = false } = {}) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (r.error) throw new Error(`git not available: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return { ok: r.status === 0, out: raw ? r.stdout || '' : (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/** Paths with uncommitted changes, including untracked files that are not ignored. */
export function dirtyPaths() {
  // raw: porcelain lines start with a status column that may be a space.
  const out = git(['status', '--porcelain', '-z', '--untracked-files=all'], { raw: true }).out;
  if (!out) return [];
  const parts = out.split('\0').filter(Boolean);
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const code = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (code[0] === 'R' || code[0] === 'C') i++; // rename/copy carries the old path next
  }
  return paths;
}

export function currentBranch() {
  return git(['rev-parse', '--abbrev-ref', 'HEAD']).out;
}

export function hasRemote(name = 'origin') {
  return git(['remote'], { allowFail: true }).out.split('\n').includes(name);
}

export function push(branch) {
  if (!hasRemote()) return { ok: false, detail: 'no "origin" remote configured' };
  const r = git(['push', 'origin', branch], { allowFail: true });
  return { ok: r.ok, detail: r.ok ? `pushed to origin/${branch}` : r.err || r.out };
}

export function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
