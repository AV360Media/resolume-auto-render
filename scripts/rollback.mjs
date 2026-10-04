// npm run rollback
// Restores the previous production index.html: newest backup in .backups/, else the version before the last promotion in git.
// Commits and pushes to main. Does not touch index.test.html.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { root, git, dirtyPaths, currentBranch, push, stamp } from './git.mjs';

const PROD = 'index.html';
const say = (ok, name, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
function finish(ok, summary) {
  console.log(`\n${'='.repeat(60)}\n${ok ? 'PASS' : 'FAIL'}: ${summary}\n${'='.repeat(60)}`);
  process.exit(ok ? 0 : 1);
}

async function fromBackups(current) {
  const dir = path.join(root, '.backups');
  let files = [];
  try {
    files = (await fs.readdir(dir)).filter((f) => /^index\..+\.html$/.test(f)).sort();
  } catch {
    return null;
  }
  // Newest first; skip backups identical to what is live now.
  for (const f of files.reverse()) {
    const text = await fs.readFile(path.join(dir, f), 'utf8');
    if (text !== current) return { text, source: `.backups/${f}`, consume: async () => {
      await fs.mkdir(path.join(dir, 'used'), { recursive: true });
      await fs.rename(path.join(dir, f), path.join(dir, 'used', f));
    } };
  }
  return null;
}

function fromGit(current) {
  const log = git(['log', '--format=%H%x09%s', '--', PROD]).out.split('\n').filter(Boolean);
  for (const entry of log) {
    const [sha, subject] = entry.split('\t');
    if (!subject.startsWith('Promote index.test.html to index.html')) continue;
    const r = git(['show', `${sha}^:${PROD}`], { allowFail: true });
    if (!r.ok) continue; // index.html did not exist before this promotion
    const text = r.out + '\n';
    if (text.trimEnd() !== current.trimEnd()) return { text, source: `git ${sha.slice(0, 8)}^ (before "${subject}")`, consume: async () => {} };
  }
  return null;
}

async function main() {
  console.log('Roll back production index.html\n');
  const branch = currentBranch();
  if (branch !== 'main') return finish(false, `Rollback runs on main; current branch is ${branch}. Nothing changed.`);
  if (dirtyPaths().includes(PROD)) return finish(false, 'index.html has uncommitted changes. Nothing changed.');
  const prodPath = path.join(root, PROD);
  const current = await fs.readFile(prodPath, 'utf8');
  const target = (await fromBackups(current)) || fromGit(current);
  if (!target) return finish(false, 'No earlier production version found in .backups/ or git history. Nothing changed.');

  // Keep a copy of what we are replacing, so a rollback can itself be undone with promote or by hand.
  await fs.mkdir(path.join(root, '.backups', 'replaced'), { recursive: true });
  await fs.writeFile(path.join(root, '.backups', 'replaced', `index.${stamp()}.html`), current);
  await fs.writeFile(prodPath, target.text);
  say(true, 'Restore', `index.html <- ${target.source}`);
  try {
    git(['add', '--', PROD]);
    git(['commit', '-m', `Roll back index.html to previous production (${target.source})`]);
    say(true, 'Commit', git(['rev-parse', '--short', 'HEAD']).out);
  } catch (e) {
    await fs.writeFile(prodPath, current);
    git(['reset', '-q', '--', PROD], { allowFail: true });
    say(false, 'Commit', e.message);
    return finish(false, 'Commit failed. index.html left as it was.');
  }
  await target.consume();
  const p = push(branch);
  say(p.ok, 'Push', p.detail);
  if (!p.ok) return finish(false, 'Rolled back and committed locally, but the push failed. Run `git push origin main`.');
  finish(true, `Production rolled back to ${target.source}.`);
}

main().catch((e) => finish(false, `Rollback aborted: ${e.message}`));
