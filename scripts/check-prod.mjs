// Fails if index.html was edited directly: its content must equal index.test.html at some commit.
import { git } from './git.mjs';

const prod = git(['hash-object', 'index.html']).out;
const shas = git(['log', '--format=%H', '--', 'index.test.html']).out.split('\n').filter(Boolean);
const match = shas.find((sha) => git(['rev-parse', `${sha}:index.test.html`], { allowFail: true }).out === prod);
if (match) {
  console.log(`PASS  index.html matches index.test.html at ${match.slice(0, 8)}`);
} else {
  console.error('FAIL  index.html does not match any committed index.test.html. Edit index.test.html and run npm run promote.');
  process.exit(1);
}
