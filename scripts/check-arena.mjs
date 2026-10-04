// npm run check-arena -- [--host 127.0.0.1] [--port 8080] [--watch 30] [--try-open <file> --layer 1 --column 1]
// Verifies the Arena API assumptions in docs/DISCOVERY.md against a running Arena and looks for Alley/AME installs.
// Read-only unless --try-open is given (that loads a file into the clip you name; use an empty slot).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const host = opt('--host', '127.0.0.1');
const port = Number(opt('--port', '8080'));
const base = `http://${host}:${port}`;
const api = `${base}/api/v1`;
const outDir = path.join(root, 'arena-dump');
const findings = [];
const note = (status, item, detail = '') => {
  findings.push({ status, item, detail });
  console.log(`${status.padEnd(5)} ${item}${detail ? `: ${detail}` : ''}`);
};

async function get(url, accept = 'application/json') {
  const r = await fetch(url, { headers: { Accept: accept }, signal: AbortSignal.timeout(5000) });
  const text = await r.text();
  return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return undefined; } })() };
}

const pv = (p) => (p && typeof p === 'object' && 'value' in p ? p.value : p);
const clipPath = (c) => pv(c?.video?.fileinfo?.path) || '';
const flatten = (comp) => (comp.layers || []).flatMap((l, li) => (l.clips || []).map((c, ci) => ({ c, layer: li + 1, column: ci + 1 })));

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  console.log(`Checking Arena at ${base}\n`);

  // Product
  let product;
  try {
    const r = await get(`${api}/product`);
    product = r.json;
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    note('PASS', 'GET /api/v1/product', `${product.name} ${product.major}.${product.minor}.${product.micro} (rev ${product.revision})`);
  } catch (e) {
    note('FAIL', 'GET /api/v1/product', `${e.message}. Is Arena running with Preferences > Web Server enabled on port ${port}?`);
    return finish();
  }

  // Schema files served by Arena itself (paths vary by version; save whatever answers).
  for (const p of ['/api/docs/swagger.yaml', '/api/docs/swagger.json', '/api/v1/docs', '/api/docs/', '/docs/restapi/swagger.yaml', '/swagger.yaml', '/swagger.json', '/openapi.json']) {
    try {
      const r = await get(`${base}${p}`, '*/*');
      if (r.status === 200 && /swagger|openapi/i.test(r.text.slice(0, 2000))) {
        const f = path.join(outDir, `schema${path.extname(p) || '.txt'}`);
        await fs.writeFile(f, r.text);
        note('PASS', `Schema at ${p}`, `saved ${path.relative(root, f)}`);
      }
    } catch { /* not there */ }
  }

  // Composition
  const comp = (await get(`${api}/composition`)).json;
  await fs.writeFile(path.join(outDir, 'composition.json'), JSON.stringify(comp, null, 2));
  const clips = flatten(comp || {});
  note(clips.length ? 'PASS' : 'WARN', 'GET /api/v1/composition', `${comp?.layers?.length ?? 0} layers, ${clips.length} clip slots (saved arena-dump/composition.json)`);
  const loaded = clips.filter((x) => clipPath(x.c));
  if (loaded.length) {
    const sample = loaded[0];
    const raw = sample.c.video.fileinfo.path;
    note('INFO', 'Clip file path shape', `${typeof raw === 'object' ? `param object {${Object.keys(raw).join(', ')}}` : typeof raw}; value like "${clipPath(sample.c)}"`);
    note('INFO', 'video.fileinfo keys', Object.keys(sample.c.video.fileinfo).join(', '));
    note('INFO', 'clip keys', Object.keys(sample.c).join(', '));
    if (sample.c.transport) note('INFO', 'transport keys', JSON.stringify(Object.keys(sample.c.transport)) + (sample.c.transport.controls ? ' controls: ' + Object.keys(sample.c.transport.controls).join(', ') : ''));
  } else {
    note('WARN', 'No clip with a file loaded', 'load any video into a clip and run again to see the path format');
  }

  // by-id endpoints
  const anyClip = (loaded[0] || clips[0])?.c;
  if (anyClip) {
    const r = await get(`${api}/composition/clips/by-id/${anyClip.id}`);
    note(r.status === 200 && r.json?.id === anyClip.id ? 'PASS' : 'FAIL', 'GET /composition/clips/by-id/{id}', `HTTP ${r.status}`);
    const r2 = await get(`${api}/composition/layers/1/clips/1`);
    note(r2.status === 200 ? 'PASS' : 'FAIL', 'GET /composition/layers/1/clips/1', `HTTP ${r2.status}`);
  }

  // WebSocket
  const wsInfo = await new Promise((resolve) => {
    const seen = [];
    const ws = new WebSocket(`ws://${host}:${port}/api/v1`);
    const t = setTimeout(() => { ws.terminate(); resolve({ ok: seen.length > 0, seen }); }, 3000);
    ws.on('message', (d) => {
      try {
        const m = JSON.parse(d.toString());
        seen.push(m.type || (Array.isArray(m.layers) ? 'composition' : Object.keys(m).slice(0, 4).join(',')));
      } catch { seen.push('non-json'); }
    });
    ws.on('error', (e) => { clearTimeout(t); resolve({ ok: false, error: e.message, seen }); });
  });
  note(wsInfo.ok ? 'PASS' : 'FAIL', 'WebSocket ws://host:port/api/v1', wsInfo.error || `first messages: ${wsInfo.seen.join(', ')}`);

  // Watch mode: does Arena push a composition when a file is loaded?
  const watchSecs = Number(opt('--watch', '0'));
  if (watchSecs > 0) {
    console.log(`\nWatching for ${watchSecs}s. Drag a video file onto an EMPTY clip slot in Arena now.`);
    const before = new Map(clips.map((x) => [x.c.id, clipPath(x.c)]));
    const result = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://${host}:${port}/api/v1`);
      let first = true;
      let pushed = null;
      ws.on('message', (d) => {
        let m; try { m = JSON.parse(d.toString()); } catch { return; }
        if (!Array.isArray(m?.layers)) return;
        if (first) { first = false; return; }
        for (const x of flatten(m)) if (clipPath(x.c) && clipPath(x.c) !== before.get(x.c.id)) pushed = pushed || { id: x.c.id, path: clipPath(x.c) };
      });
      setTimeout(async () => {
        ws.terminate();
        const now = flatten((await get(`${api}/composition`)).json || {});
        const polled = now.find((x) => clipPath(x.c) && clipPath(x.c) !== before.get(x.c.id));
        resolve({ pushed, polled: polled ? { id: polled.c.id, path: clipPath(polled.c) } : null });
      }, watchSecs * 1000);
    });
    if (!result.polled) note('WARN', 'File load detection', 'no clip changed during the watch window');
    else note(result.pushed ? 'PASS' : 'INFO', 'File load pushed over WebSocket', result.pushed ? `yes (${result.pushed.path})` : `no; seen only by polling (${result.polled.path}). Keep the poll interval on.`);
  }

  // Optional open test
  const tryFile = opt('--try-open');
  if (tryFile) {
    const layer = Number(opt('--layer', '1'));
    const column = Number(opt('--column', '1'));
    const target = (await get(`${api}/composition/layers/${layer}/clips/${column}`)).json;
    if (!target?.id) note('FAIL', 'try-open', `no clip at layer ${layer} column ${column}`);
    else {
      const body = 'file:///' + path.resolve(tryFile).replace(/\\/g, '/').replace(/^\/+/, '');
      const nameBefore = pv(target.name);
      const fxBefore = (target.video?.effects || []).length;
      let r = await fetch(`${api}/composition/clips/by-id/${target.id}/open`, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' } });
      note(r.ok ? 'PASS' : 'FAIL', 'POST /composition/clips/by-id/{id}/open', `HTTP ${r.status}`);
      if (!r.ok) {
        r = await fetch(`${api}/composition/layers/${layer}/clips/${column}/open`, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' } });
        note(r.ok ? 'PASS' : 'FAIL', 'POST /composition/layers/{l}/clips/{c}/open', `HTTP ${r.status}`);
      }
      await new Promise((res) => setTimeout(res, 1500));
      const after = (await get(`${api}/composition/clips/by-id/${target.id}`)).json || (await get(`${api}/composition/layers/${layer}/clips/${column}`)).json;
      await fs.writeFile(path.join(outDir, 'clip-after-open.json'), JSON.stringify(after, null, 2));
      note(after?.id === target.id ? 'PASS' : 'WARN', 'Clip id kept after open', `${target.id} -> ${after?.id}`);
      note('INFO', 'Path after open', String(clipPath(after)));
      note(pv(after?.name) === nameBefore ? 'PASS' : 'INFO', 'Clip name after open', `"${nameBefore}" -> "${pv(after?.name)}"`);
      note('INFO', 'Clip video effects', `${fxBefore} before, ${(after?.video?.effects || []).length} after`);
      const put = await fetch(`${api}/composition/clips/by-id/${target.id}`, { method: 'PUT', body: JSON.stringify({ name: { value: 'rar-check' } }), headers: { 'Content-Type': 'application/json' } });
      const renamed = pv((await get(`${api}/composition/clips/by-id/${target.id}`)).json?.name);
      note(put.ok && renamed === 'rar-check' ? 'PASS' : 'FAIL', 'PUT clip name (by-id)', `HTTP ${put.status}, name now "${renamed}"`);
      await fetch(`${api}/composition/clips/by-id/${target.id}`, { method: 'PUT', body: JSON.stringify({ name: { value: nameBefore ?? '' } }), headers: { 'Content-Type': 'application/json' } });
    }
  }
  await localTools();
  return finish();
}

async function localTools() {
  console.log('');
  const dirs = process.platform === 'darwin' ? ['/Applications'] : process.platform === 'win32' ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean) : [];
  for (const d of dirs) {
    for (const scan of [d, path.join(d, 'Resolume'), path.join(d, 'Adobe')]) {
      let names = [];
      try { names = await fs.readdir(scan); } catch { continue; }
      for (const n of names.filter((x) => /alley|media encoder|resolume/i.test(x))) {
        const full = path.join(scan, n);
        note('INFO', 'Installed', full);
        if (/alley/i.test(n)) {
          const inner = process.platform === 'darwin' ? path.join(full, 'Contents', 'MacOS') : full;
          try {
            const exes = (await fs.readdir(inner)).filter((x) => process.platform !== 'win32' || /\.exe$/i.test(x));
            note('INFO', 'Alley executables', exes.join(', ') + ' (none are run; check vendor docs for a CLI)');
          } catch { /* ignore */ }
        }
      }
    }
  }
  const candidates = [path.join(root, 'vendor', 'ffmpeg', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), 'ffmpeg'];
  for (const ff of candidates) {
    const r = spawnSync(ff, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    if (r.status === 0) {
      const v = spawnSync(ff, ['-version'], { encoding: 'utf8' }).stdout.split('\n')[0];
      note(/^\s*V\S*\s+dxv\s/m.test(r.stdout) ? 'PASS' : 'FAIL', `ffmpeg DXV encoder (${ff})`, v);
      break;
    }
  }
}

async function finish() {
  const report = { checkedAt: new Date().toISOString(), host, port, os: `${os.platform()} ${os.release()} ${os.arch()}`, findings };
  await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2)).catch(() => {});
  console.log(`\nReport saved to arena-dump/report.json. Failures: ${findings.filter((f) => f.status === 'FAIL').length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
