// npm run promote
// Gate index.test.html, then copy it to index.html, back up the old production file, commit and push to main.
// On any gate failure nothing is changed.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runGate } from './ui-gate.mjs';
import { root, git, dirtyPaths, currentBranch, push, stamp } from './git.mjs';

const TEST = 'index.test.html';
const PROD = 'index.html';
const report = [];
const line = (ok, name, detail = '') => {
  report.push({ ok, name, detail });
  console.log(`${ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
};

function finish(ok, summary) {
  console.log(`\n${'='.repeat(60)}\n${ok ? 'PASS' : 'FAIL'}: ${summary}\n${'='.repeat(60)}`);
  process.exit(ok ? 0 : 1);
}

/** "+12 -3 lines; touches: settings drawer, queue" style summary. */
function diffSummary(oldText, newText) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const setA = new Map();
  for (const l of a) setA.set(l, (setA.get(l) || 0) + 1);
  let added = 0;
  const addedLines = [];
  for (const l of b) {
    const n = setA.get(l) || 0;
    if (n > 0) setA.set(l, n - 1);
    else {
      added++;
      addedLines.push(l);
    }
  }
  const removed = [...setA.values()].reduce((s, n) => s + n, 0);
  const ids = [...new Set(addedLines.flatMap((l) => [...l.matchAll(/id="([\w-]+)"|\$\('([\w-]+)'\)/g)].map((m) => m[1] || m[2])))].slice(0, 3);
  return `+${added} -${removed} lines${ids.length ? `; ${ids.join(', ')}` : ''}`;
}

async function main() {
  console.log('Promote index.test.html -> index.html\n');

  // 1. Clean tree except the staging file.
  let branch;
  try {
    branch = currentBranch();
    const dirty = dirtyPaths().filter((p) => p !== TEST);
    if (dirty.length) {
      line(false, 'Working tree clean outside index.test.html', `uncommitted: ${dirty.join(', ')}`);
      return finish(false, 'Commit or stash those changes first. Nothing was changed.');
    }
    line(true, 'Working tree clean outside index.test.html');
    if (branch !== 'main') {
      line(false, 'On main branch', `current branch is ${branch}`);
      return finish(false, 'Promotion only runs on main. Nothing was changed.');
    }
    line(true, 'On main branch');
  } catch (e) {
    line(false, 'Git checks', e.message);
    return finish(false, 'Nothing was changed.');
  }

  // 2. Test gate.
  console.log('\nTest gate on index.test.html:');
  const gate = await runGate(TEST);
  if (!gate.ok) {
    const failed = gate.results.filter((r) => !r.ok).map((r) => r.name);
    line(false, 'Test gate', `failed: ${failed.join(', ')}`);
    return finish(false, `Gate failed (${failed.join(', ')}). index.html was not changed.`);
  }
  line(true, 'Test gate', 'all checks passed');

  // 3. Copy with backup.
  const testPath = path.join(root, TEST);
  const prodPath = path.join(root, PROD);
  const next = await fs.readFile(testPath, 'utf8');
  const prev = await fs.readFile(prodPath, 'utf8').catch(() => '');
  if (prev === next) {
    line(null, 'Copy', 'index.html already matches index.test.html');
    const testDirty = dirtyPaths().includes(TEST);
    if (!testDirty) return finish(true, 'Nothing to promote. Production already matches staging.');
  }
  const summary = diffSummary(prev, next);
  if (prev && prev !== next) {
    const dir = path.join(root, '.backups');
    await fs.mkdir(dir, { recursive: true });
    const backup = path.join(dir, `index.${stamp()}.html`);
    await fs.writeFile(backup, prev);
    line(true, 'Backup', path.relative(root, backup));
  }
  await fs.writeFile(prodPath, next);
  line(true, 'Copy', `index.test.html -> index.html (${summary})`);

  // 4. Commit and push.
  try {
    git(['add', '--', PROD, TEST]);
    git(['commit', '-m', `Promote index.test.html to index.html (${summary})`]);
    line(true, 'Commit', git(['rev-parse', '--short', 'HEAD']).out);
  } catch (e) {
    // Undo the copy so a failed commit leaves production as it was.
    if (prev) await fs.writeFile(prodPath, prev);
    git(['reset', '-q', '--', PROD], { allowFail: true });
    line(false, 'Commit', e.message);
    return finish(false, 'Commit failed. index.html restored to its previous content.');
  }
  const p = push(branch);
  line(p.ok, 'Push', p.detail);
  if (!p.ok) return finish(false, 'Promoted and committed locally, but the push failed. Run `git push origin main`.');
  finish(true, `Promoted to production (${summary}).`);
}

main().catch((e) => {
  line(false, 'Unexpected error', e.stack || e.message);
  finish(false, 'Promotion aborted.');
});
