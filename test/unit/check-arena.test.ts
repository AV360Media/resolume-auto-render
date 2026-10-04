import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockArena } from '../mock/mock-arena.js';

let arena: MockArena | null = null;
afterEach(async () => { await arena?.stop(); arena = null; });

function runScript(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['scripts/check-arena.mjs', ...args], { cwd: path.resolve(__dirname, '../..') });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', () => resolve(out));
  });
}

describe('scripts/check-arena.mjs against the mock', () => {
  it('reports the API checks and the open/restore behavior', async () => {
    arena = new MockArena();
    const port = await arena.start();
    arena.userLoad(1, 1, '/clips/a.mov');
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'rar-chk-')), 'b c.mov');
    await fs.writeFile(file, 'x');
    const out = await runScript(['--port', String(port), '--try-open', file, '--layer', '1', '--column', '2']);
    expect(out).toMatch(/PASS\s+GET \/api\/v1\/product: Arena 7\.23\.0/);
    expect(out).toMatch(/PASS\s+GET \/composition\/clips\/by-id\/\{id\}/);
    expect(out).toMatch(/PASS\s+WebSocket/);
    expect(out).toMatch(/PASS\s+POST \/composition\/clips\/by-id\/\{id\}\/open/);
    expect(out).toMatch(/PASS\s+PUT clip name/);
    expect(out).toMatch(/Failures: 0/);
  });
  it('fails clearly when Arena is not running', async () => {
    const out = await runScript(['--port', '1']);
    expect(out).toMatch(/FAIL\s+GET \/api\/v1\/product/);
    expect(out).toMatch(/Web Server/);
  });
});
